/**
 * Docker migration controller — inspect an existing Docker deployment on a
 * server so it can be adopted as an Openship project.
 *
 * Self-hosted only (mounted behind `localOnly`): inspection requires SSH into
 * a user's own server, which cloud mode has no notion of. Mirrors the mail
 * scan/adopt shape: read-only `/scan` returns what's adoptable, no mutation.
 */

import type { Context } from "hono";
import { repos } from "@repo/db";
import { safeErrorMessage } from "@repo/core";
import { getRequestContext } from "../../lib/request-context";
import { permission } from "../../lib/permission";
import { isServerInOrg, param } from "../../lib/controller-helpers";
import { streamRunSSE } from "../../lib/run-sse";
import { streamSSE } from "../../lib/sse";
import {
  discoverServerStack,
  revealContainerEnv,
  type DiscoveredStack,
  type DiscoveredService,
} from "./docker-inspect.service";
import { adoptServerStack, reimportOpenshipProject, parseRepoCompose } from "./migrate.service";
import { maskEnv, maskServicesEnv } from "../../lib/secret-env";
import { buildMigrationPreview } from "./migration-preflight";
import { migrationOrchestrator } from "./migration.orchestrator";
import { migrationRunBus } from "./migration.sse";
import {
  sanitizeVolumeStrategies,
  sanitizeSubpaths,
  sanitizeRenames,
  sanitizeGitSource,
  sanitizeServiceEnv,
  sanitizeCustomPaths,
  sanitizeRoutes,
  sanitizeConflictResolution,
} from "./migration-input";
import {
  getTransferPrefs,
  isValidTransferMode,
  isValidTransferCompression,
} from "../settings/settings.service";

const TERMINAL_MIGRATION = ["succeeded", "failed", "rolled_back"];

/**
 * #336: mask the live `env` read off running containers before it leaves the
 * server-scan API. `services` is a flat view of the same objects nested in
 * `groups` / `openshipProjects`, so each array is masked into its own copy. The
 * adopt path re-discovers server-side (server truth), so masking the RESPONSE
 * doesn't affect what actually gets persisted. Typed against the real shapes so
 * a field rename fails to compile instead of silently un-masking.
 */
function maskDiscoveredEnv(s: DiscoveredService): DiscoveredService {
  return s.env ? { ...s, env: maskEnv(s.env) } : s;
}
function maskDiscoveredStack(stack: DiscoveredStack): DiscoveredStack {
  return {
    ...stack,
    services: stack.services.map(maskDiscoveredEnv),
    groups: stack.groups.map((g) => ({ ...g, services: g.services.map(maskDiscoveredEnv) })),
    openshipProjects: stack.openshipProjects.map((g) => ({
      ...g,
      services: g.services.map(maskDiscoveredEnv),
    })),
  };
}

/** Assert both source and target servers belong to the caller's org + write. */
async function assertServersWritable(
  c: Context,
  sourceServerId: string,
  targetServerId: string,
): Promise<{ organizationId: string } | Response> {
  const ctx = getRequestContext(c);
  for (const serverId of new Set([sourceServerId, targetServerId])) {
    await permission.assert(ctx, {
      resourceType: "server",
      resourceId: serverId,
      action: "write",
    });
    if (!(await isServerInOrg(ctx, serverId))) {
      return c.json({ error: "Server not found" }, 404);
    }
  }
  return { organizationId: ctx.organizationId };
}

/**
 * POST /migration/repo-compose  { owner, repo, branch? }
 *
 * Read-only: parse a linked repo's docker-compose (via the GitHub API, no clone)
 * so the wizard can map each discovered container to a compose service. Returns
 * `{ services: [] }` when the repo has no compose file.
 */
export async function repoCompose(c: Context) {
  const ctx = getRequestContext(c);
  const { owner, repo, branch } = await c.req.json<{ owner?: string; repo?: string; branch?: string }>();
  if (!owner?.trim() || !repo?.trim()) {
    return c.json({ error: "owner and repo are required" }, 400);
  }
  try {
    const services = await parseRepoCompose(ctx, owner.trim(), repo.trim(), branch?.trim() || undefined);
    return c.json({ success: true, services: maskServicesEnv(services) });
  } catch (err) {
    return c.json({ error: `Failed to parse repo compose: ${safeErrorMessage(err)}` }, 502);
  }
}

/**
 * POST /migration/scan  { serverId }
 *
 * Read-only: enumerate the server's Docker (compose stacks + hand-run
 * containers), reconcile with any compose files, and return the discovered
 * stack for the migration wizard to preview. Nothing changes on the server.
 */
export async function scanServer(c: Context) {
  const { serverId, flatDocker } = await c.req.json<{ serverId?: string; flatDocker?: boolean }>();
  if (!serverId) return c.json({ error: "serverId is required" }, 400);

  const ctx = getRequestContext(c);
  await permission.assert(ctx, {
    resourceType: "server",
    resourceId: serverId,
    action: "write",
  });
  if (!(await isServerInOrg(ctx, serverId))) {
    return c.json({ error: "Server not found" }, 404);
  }

  try {
    const stack = await discoverServerStack(serverId, ctx.organizationId, undefined, {
      flatDocker: flatDocker === true,
    });
    return c.json({ success: true, stack: maskDiscoveredStack(stack) });
  } catch (err) {
    return c.json({ error: `Scan failed: ${safeErrorMessage(err)}` }, 502);
  }
}

/**
 * GET /migration/scan/stream?serverId=…  (SSE)
 *
 * Streaming variant of `scanServer`: SSH + `docker inspect` across a server's
 * containers is slow and variable, so a plain request races the client's fixed
 * timeout (worse through the same-origin proxy's extra hop). Streaming it —
 * step progress events + a `result` frame — removes the arbitrary timeout
 * entirely (streamSSE keeps the connection alive with heartbeats) and shows the
 * user what's happening. Emits `{type:"progress"|"result"|"error", …}` frames.
 */
export async function scanServerStream(c: Context) {
  const serverId = c.req.query("serverId");
  const flatDocker = c.req.query("flatDocker") === "1";
  if (!serverId) return c.json({ error: "serverId is required" }, 400);

  const ctx = getRequestContext(c);
  await permission.assert(ctx, { resourceType: "server", resourceId: serverId, action: "write" });
  if (!(await isServerInOrg(ctx, serverId))) {
    return c.json({ error: "Server not found" }, 404);
  }

  return streamSSE(c, async (s) => {
    try {
      const stack = await discoverServerStack(
        serverId,
        ctx.organizationId,
        (message) => {
          void s.writeSSE({ event: "progress", data: JSON.stringify({ type: "progress", message }) });
        },
        { flatDocker },
      );
      await s.writeSSE({ event: "result", data: JSON.stringify({ type: "result", stack: maskDiscoveredStack(stack) }) });
    } catch (err) {
      await s.writeSSE({
        event: "error",
        data: JSON.stringify({ type: "error", error: `Scan failed: ${safeErrorMessage(err)}` }),
      });
    }
  });
}

/**
 * POST /migration/reveal-env  { serverId, containerId }
 *
 * #336: on-demand reveal of ONE discovered container's real env for the wizard's
 * env viewer. The scan masks env (`maskDiscoveredStack`); this returns it UNMASKED
 * for a single container the user chose to reveal. Write-gated (`server:write`, the
 * route tag) — same read/write split as the service-env reveal — so the masked
 * scan stays a `:read` and only a `:write` holder can pull the real secrets.
 */
export async function revealServiceEnv(c: Context) {
  const { serverId, containerId } = await c.req.json<{ serverId?: string; containerId?: string }>();
  if (!serverId) return c.json({ error: "serverId is required" }, 400);
  if (!containerId) return c.json({ error: "containerId is required" }, 400);

  const ctx = getRequestContext(c);
  await permission.assert(ctx, {
    resourceType: "server",
    resourceId: serverId,
    action: "write",
  });
  if (!(await isServerInOrg(ctx, serverId))) {
    return c.json({ error: "Server not found" }, 404);
  }

  try {
    const environment = await revealContainerEnv(serverId, ctx.organizationId, containerId);
    return c.json({ success: true, environment });
  } catch (err) {
    return c.json({ error: `Reveal failed: ${safeErrorMessage(err)}` }, 502);
  }
}

/**
 * POST /migration/adopt  { serverId, projectName, serviceNames[] }
 *
 * Create an Openship `services` project from the selected discovered services.
 * Re-discovers server-side (server truth, not client-sent config). Records only
 * — reuses the existing named volumes in place; deploy + cutover is separate.
 */
export async function adoptServer(c: Context) {
  const body = await c.req.json<{
    serverId?: string;
    projectName?: string;
    serviceNames?: string[];
    flatDocker?: boolean;
    volumeStrategies?: Record<string, "reuse" | "copy">;
    serviceSubpaths?: Record<string, string>;
    serviceEnv?: Record<string, Record<string, string>>;
    /** Compose project to resolve `serviceNames` in (`null` = standalone group).
     *  Omit for the legacy server-wide match — ambiguous when several stacks
     *  share service names like `app`/`db`/`redis`. */
    composeProject?: string | null;
  }>();
  const { serverId, projectName, serviceNames, flatDocker, volumeStrategies, serviceSubpaths, serviceEnv } = body;
  if (!serverId) return c.json({ error: "serverId is required" }, 400);
  if (!projectName?.trim()) return c.json({ error: "projectName is required" }, 400);
  if (!Array.isArray(serviceNames) || serviceNames.length === 0) {
    return c.json({ error: "Select at least one service to adopt" }, 400);
  }

  const ctx = getRequestContext(c);
  await permission.assert(ctx, {
    resourceType: "server",
    resourceId: serverId,
    action: "write",
  });
  if (!(await isServerInOrg(ctx, serverId))) {
    return c.json({ error: "Server not found" }, 404);
  }

  try {
    const result = await adoptServerStack({
      serverId,
      organizationId: ctx.organizationId,
      projectName: projectName.trim(),
      serviceNames,
      flatDocker,
      volumeStrategies,
      serviceSubpaths,
      serviceEnv,
      ...("composeProject" in body ? { composeProject: body.composeProject } : {}),
    });
    return c.json({ success: true, ...result });
  } catch (err) {
    return c.json({ error: `Adopt failed: ${safeErrorMessage(err)}` }, 502);
  }
}

/**
 * POST /migration/reimport  { serverId, projectId, projectName?, serviceNames? }
 *
 * Recover an ORPHANED Openship project (DR / cross-instance) from a server,
 * preserving its original id so the running containers re-attach. Records only —
 * the user redeploys from the project to finalize. `organizationId` comes from
 * the request context, never from server-supplied data.
 */
export async function reimportServer(c: Context) {
  const body = await c.req.json<{
    serverId?: string;
    projectId?: string;
    projectName?: string;
    serviceNames?: string[];
  }>();
  const { serverId, projectId, projectName, serviceNames } = body;
  if (!serverId) return c.json({ error: "serverId is required" }, 400);
  if (!projectId?.trim()) return c.json({ error: "projectId is required" }, 400);

  const ctx = getRequestContext(c);
  await permission.assert(ctx, {
    resourceType: "server",
    resourceId: serverId,
    action: "write",
  });
  if (!(await isServerInOrg(ctx, serverId))) {
    return c.json({ error: "Server not found" }, 404);
  }

  try {
    const result = await reimportOpenshipProject({
      serverId,
      organizationId: ctx.organizationId,
      projectId: projectId.trim(),
      projectName: projectName?.trim() || undefined,
      serviceNames: Array.isArray(serviceNames) ? serviceNames : undefined,
    });
    return c.json({ success: true, ...result });
  } catch (err) {
    return c.json({ error: `Re-import failed: ${safeErrorMessage(err)}` }, 502);
  }
}

/**
 * POST /migration/preview  { sourceServerId, targetServerId, serviceNames[] }
 *
 * Read-only migration preview: per-service registry/build classification,
 * volumes that will move, and downtime/bind/network warnings. Nothing changes.
 */
export async function previewMigration(c: Context) {
  const body = await c.req.json<{
    sourceServerId?: string;
    targetServerId?: string;
    serviceNames?: string[];
    customPaths?: unknown;
  }>();
  const sourceServerId = body.sourceServerId;
  const targetServerId = body.targetServerId || body.sourceServerId;
  if (!sourceServerId || !targetServerId) {
    return c.json({ error: "sourceServerId is required" }, 400);
  }
  if (!Array.isArray(body.serviceNames) || body.serviceNames.length === 0) {
    return c.json({ error: "Select at least one service" }, 400);
  }

  const guard = await assertServersWritable(c, sourceServerId, targetServerId);
  if (guard instanceof Response) return guard;

  try {
    const preview = await buildMigrationPreview({
      sourceServerId,
      targetServerId,
      serviceNames: body.serviceNames,
      organizationId: guard.organizationId,
      customPaths: sanitizeCustomPaths(body.customPaths),
    });
    return c.json({ success: true, preview });
  } catch (err) {
    return c.json({ error: `Preview failed: ${safeErrorMessage(err)}` }, 502);
  }
}

/**
 * POST /migration/migrate
 *   { sourceServerId, targetServerId, serviceNames[], projectName, killOriginals? }
 *
 * Start a full migration (adopt → move volumes → deploy on target → verify →
 * await cutover). Returns { migrationId, confirmationToken } — the token is
 * required to confirm the destructive cutover later.
 */
export async function startMigration(c: Context) {
  const body = await c.req.json<{
    sourceServerId?: string;
    targetServerId?: string;
    serviceNames?: string[];
    projectName?: string;
    killOriginals?: boolean;
    volumeStrategies?: Record<string, unknown>;
    transferMode?: unknown;
    transferCompression?: unknown;
    gitSource?: unknown;
    serviceSubpaths?: Record<string, unknown>;
    serviceRenames?: Record<string, unknown>;
    serviceEnv?: Record<string, unknown>;
    customPaths?: unknown;
    routesByServiceName?: Record<string, unknown>;
    conflictResolution?: Record<string, unknown>;
    flatDocker?: boolean;
  }>();
  const sourceServerId = body.sourceServerId;
  const targetServerId = body.targetServerId || body.sourceServerId;
  if (!sourceServerId || !targetServerId) {
    return c.json({ error: "sourceServerId is required" }, 400);
  }
  if (!body.projectName?.trim()) {
    return c.json({ error: "projectName is required" }, 400);
  }
  if (!Array.isArray(body.serviceNames) || body.serviceNames.length === 0) {
    return c.json({ error: "Select at least one service to migrate" }, 400);
  }

  const guard = await assertServersWritable(c, sourceServerId, targetServerId);
  if (guard instanceof Response) return guard;

  const ctx = getRequestContext(c);
  // Per-run override wins over the user's Settings default; both fall back to
  // "auto" (topology-aware) inside the transfer core.
  const prefs = await getTransferPrefs(ctx.userId);
  const transferMode = isValidTransferMode(body.transferMode) ? body.transferMode : prefs.transferMode;
  const transferCompression = isValidTransferCompression(body.transferCompression)
    ? body.transferCompression
    : prefs.transferCompression;

  try {
    const result = await migrationOrchestrator.begin(ctx, {
      organizationId: guard.organizationId,
      sourceServerId,
      targetServerId,
      serviceNames: body.serviceNames,
      projectName: body.projectName.trim(),
      killOriginals: body.killOriginals === true,
      volumeStrategies: sanitizeVolumeStrategies(body.volumeStrategies),
      transferMode,
      transferCompression,
      gitSource: sanitizeGitSource(body.gitSource),
      serviceSubpaths: sanitizeSubpaths(body.serviceSubpaths),
      serviceRenames: sanitizeRenames(body.serviceRenames),
      serviceEnv: sanitizeServiceEnv(body.serviceEnv),
      customPaths: sanitizeCustomPaths(body.customPaths),
      routesByServiceName: sanitizeRoutes(body.routesByServiceName),
      conflictResolution: sanitizeConflictResolution(body.conflictResolution),
      flatDocker: body.flatDocker === true,
    });
    return c.json({ success: true, ...result });
  } catch (err) {
    return c.json({ error: `Migration failed to start: ${safeErrorMessage(err)}` }, 502);
  }
}

/** GET /migration/migrations/:id — current run row. */
export async function getMigration(c: Context) {
  const ctx = getRequestContext(c);
  const run = await repos.dockerMigrationRun.findById(param(c, "id"));
  if (!run || run.organizationId !== ctx.organizationId) {
    return c.json({ error: "Migration not found" }, 404);
  }
  // Prefer the in-memory log tail while the run is live (fresher than the
  // throttled DB copy); fall back to the persisted logs once terminal.
  const liveLogs = migrationOrchestrator.getLiveLogs(run.id);
  // #336: inputSnapshot.serviceEnv holds operator-supplied per-service env
  // (secrets) — mask it on output. Server-side resume reads the raw row via the
  // repo, not this response, and the write path unmask-merges, so this is safe.
  const safeRun = maskMigrationRunEnv(run);
  return c.json({
    success: true,
    run: liveLogs ? { ...safeRun, logs: liveLogs } : safeRun,
    progress: migrationOrchestrator.getProgress(run.id),
  });
}

/** Mask serviceEnv inside a migration run's inputSnapshot (see #336). */
function maskMigrationRunEnv<T extends { inputSnapshot?: unknown }>(run: T): T {
  const snap = run.inputSnapshot as { serviceEnv?: Record<string, Record<string, string>> } | null;
  if (!snap?.serviceEnv) return run;
  return {
    ...run,
    inputSnapshot: {
      ...snap,
      serviceEnv: Object.fromEntries(
        Object.entries(snap.serviceEnv).map(([name, env]) => [name, maskEnv(env)]),
      ),
    },
  };
}

/**
 * GET /migration/runs?serverId=…
 *
 * Recent migration runs touching this server (source or target), newest first
 * — the server detail "Migrations" tab lists these like a project's deployments.
 */
export async function getMigrationRuns(c: Context) {
  const ctx = getRequestContext(c);
  const serverId = c.req.query("serverId");
  if (!serverId) return c.json({ error: "serverId is required" }, 400);
  const runs = await repos.dockerMigrationRun.listForServer(ctx.organizationId, serverId, {
    limit: 50,
  });
  // Summary rows only: the 256 KiB session log, the input snapshot, and the
  // cutover token belong to the per-run detail fetch, not a 50-row list.
  const lite = runs.map(
    ({ logs: _logs, confirmationToken: _t, inputSnapshot: _in, ...rest }) => rest,
  );
  return c.json({ success: true, runs: lite });
}

/** GET /migration/migrations/:id/stream — SSE progress. */
export async function streamMigration(c: Context) {
  const ctx = getRequestContext(c);
  const id = param(c, "id");
  const initial = await repos.dockerMigrationRun.findById(id);
  if (!initial || initial.organizationId !== ctx.organizationId) {
    return c.json({ error: "Migration not found" }, 404);
  }

  const finished = TERMINAL_MIGRATION.includes(initial.status);
  return streamRunSSE(c, {
    bus: migrationRunBus,
    id,
    snapshot: { type: "snapshot", run: initial },
    terminalComplete: finished
      ? {
          type: "complete",
          status: initial.status as "succeeded" | "failed" | "rolled_back",
        }
      : null,
    isFinalEvent: (e) => e.type === "complete",
  });
}

/**
 * POST /migration/migrations/:id/cutover  { confirmationToken, kill? }
 *
 * Confirm the destructive teardown of the originals (kill=true) or finish the
 * migration keeping them stopped (kill=false). Only valid from awaiting_cutover.
 */
export async function confirmCutover(c: Context) {
  const ctx = getRequestContext(c);
  const id = param(c, "id");
  const body = await c.req
    .json<{ confirmationToken?: string; kill?: boolean }>()
    .catch(() => ({}) as { confirmationToken?: string; kill?: boolean });
  if (!body.confirmationToken) {
    return c.json({ error: "confirmationToken is required" }, 400);
  }

  const result = await migrationOrchestrator.resolveCutover(
    id,
    ctx.organizationId,
    body.confirmationToken,
    body.kill === true,
  );
  if (!result.ok) return c.json({ error: result.error }, result.status as 400);
  return c.json({ success: true });
}

/**
 * POST /migration/migrations/:id/cancel
 *
 * Abort an in-flight migration: flags the run + kills the transfer on both
 * boxes; the pipeline rolls back (source restarted, target torn down). Not
 * valid once parked at awaiting_cutover (use cutover) or terminal.
 */
export async function cancelMigration(c: Context) {
  const ctx = getRequestContext(c);
  const result = await migrationOrchestrator.cancel(param(c, "id"), ctx.organizationId);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400);
  return c.json({ success: true });
}

/**
 * POST /migration/migrations/:id/cleanup-target
 *
 * Remove the volumes a FAILED run copied to the target (orphaned after rollback),
 * so a retry starts clean. Source untouched; succeeded runs are rejected.
 */
export async function cleanupTargetData(c: Context) {
  const ctx = getRequestContext(c);
  const result = await migrationOrchestrator.cleanupTargetData(param(c, "id"), ctx.organizationId);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400);
  return c.json({ success: true, removed: result.removed });
}

/**
 * POST /migration/migrations/:id/resume  { overrides?, skip? }
 *
 * Resume a `partial` run: re-transfer the pending paths (per-item source
 * overrides), skip the chosen ones, then finish to cutover when nothing remains.
 */
export async function resumeMigration(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req
    .json<{ overrides?: Record<string, string>; skip?: string[] }>()
    .catch(() => ({}) as { overrides?: Record<string, string>; skip?: string[] });
  const overrides =
    body.overrides && typeof body.overrides === "object" ? body.overrides : {};
  const skip = Array.isArray(body.skip) ? body.skip.filter((s) => typeof s === "string") : [];
  const result = await migrationOrchestrator.resume(ctx, param(c, "id"), ctx.organizationId, {
    overrides,
    skip,
  });
  if (!result.ok) return c.json({ error: result.error }, result.status as 400);
  return c.json({ success: true });
}

/**
 * DELETE /migration/migrations/:id
 *
 * Remove a migration run's record (history cleanup, e.g. a failed/rolled-back
 * run). Only terminal runs — deleting an in-flight one would orphan the running
 * pipeline. Deletes ONLY the run record: the adopted project + any moved data
 * are untouched.
 */
export async function deleteMigration(c: Context) {
  const ctx = getRequestContext(c);
  const id = param(c, "id");
  const run = await repos.dockerMigrationRun.findById(id);
  if (!run || run.organizationId !== ctx.organizationId) {
    return c.json({ error: "Migration not found" }, 404);
  }
  if (!TERMINAL_MIGRATION.includes(run.status)) {
    return c.json({ error: "Cancel the migration before deleting its record." }, 409);
  }
  await repos.dockerMigrationRun.remove(id);
  return c.json({ success: true });
}

/**
 * GET /migration/active?serverId=…
 *
 * The in-flight migration involving this server (source or target), so a
 * client that reloaded mid-migration can re-attach and resume polling. Returns
 * the run + its confirmationToken (needed for the cutover step, never persisted
 * client-side), or null.
 */
export async function getActiveMigration(c: Context) {
  const ctx = getRequestContext(c);
  const serverId = c.req.query("serverId");
  if (!serverId) return c.json({ error: "serverId is required" }, 400);
  const runs = await repos.dockerMigrationRun.findActiveForServer(serverId);
  // Org-scope: a run for a server outside this org won't match (IDOR guard).
  const run = runs.find((r) => r.organizationId === ctx.organizationId) ?? null;
  return c.json({ success: true, run, confirmationToken: run?.confirmationToken ?? null });
}
