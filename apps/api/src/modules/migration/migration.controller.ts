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
import { discoverServerStack } from "./docker-inspect.service";
import { adoptServerStack, reimportOpenshipProject } from "./migrate.service";
import { buildMigrationPreview } from "./migration-preflight";
import { migrationOrchestrator } from "./migration.orchestrator";
import { migrationRunBus } from "./migration.sse";
import {
  getTransferPrefs,
  isValidTransferMode,
  isValidTransferCompression,
} from "../settings/settings.service";

const TERMINAL_MIGRATION = ["succeeded", "failed", "rolled_back"];

/** Keep only well-formed serviceName → "reuse"|"copy" entries from client input. */
function sanitizeVolumeStrategies(
  input: Record<string, unknown> | undefined,
): Record<string, "reuse" | "copy"> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const out: Record<string, "reuse" | "copy"> = {};
  for (const [name, v] of Object.entries(input)) {
    if (v === "copy" || v === "reuse") out[name] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
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
 * POST /migration/scan  { serverId }
 *
 * Read-only: enumerate the server's Docker (compose stacks + hand-run
 * containers), reconcile with any compose files, and return the discovered
 * stack for the migration wizard to preview. Nothing changes on the server.
 */
export async function scanServer(c: Context) {
  const { serverId } = await c.req.json<{ serverId?: string }>();
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
    const stack = await discoverServerStack(serverId, ctx.organizationId);
    return c.json({ success: true, stack });
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
  if (!serverId) return c.json({ error: "serverId is required" }, 400);

  const ctx = getRequestContext(c);
  await permission.assert(ctx, { resourceType: "server", resourceId: serverId, action: "write" });
  if (!(await isServerInOrg(ctx, serverId))) {
    return c.json({ error: "Server not found" }, 404);
  }

  return streamSSE(c, async (s) => {
    try {
      const stack = await discoverServerStack(serverId, ctx.organizationId, (message) => {
        void s.writeSSE({ event: "progress", data: JSON.stringify({ type: "progress", message }) });
      });
      await s.writeSSE({ event: "result", data: JSON.stringify({ type: "result", stack }) });
    } catch (err) {
      await s.writeSSE({
        event: "error",
        data: JSON.stringify({ type: "error", error: `Scan failed: ${safeErrorMessage(err)}` }),
      });
    }
  });
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
  }>();
  const { serverId, projectName, serviceNames } = body;
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
  return c.json({ success: true, run });
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
