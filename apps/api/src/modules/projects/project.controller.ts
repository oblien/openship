import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { operationContext, applyOperationContext } from "../../lib/operation-context";
/**
 * Project controller - Hono request handlers.
 *
 * Every handler:
 *   1. Extracts user from context (set by authMiddleware)
 *   2. Delegates to project.service
 *   3. Returns consistent JSON
 */

import type { Context } from "hono";
import { streamSSE } from "../../lib/sse";
import { param } from "../../lib/controller-helpers";
import { getRequestContext } from "../../lib/request-context";
import { AppError } from "@repo/core";
import type { TEnsureProjectBody } from "@repo/contracts";
import { parseProjectDeleteOptions } from "./project-delete-options";


function logEnsureProjectError(userId: string, body: TEnsureProjectBody, err: unknown) {
  console.error("[PROJECT] Failed to ensure project", {
    userId,
    projectId: body.projectId,
    name: body.name,
    slug: body.slug,
    gitBranch: body.gitBranch,
    port: body.port,
    publicEndpoints: body.publicEndpoints?.map((endpoint) => ({
      port: endpoint.port,
      targetPath: endpoint.targetPath,
      domain: endpoint.domain,
      customDomain: endpoint.customDomain,
      domainType: endpoint.domainType,
    })),
  });
  console.error(err);

  if (err instanceof Error && err.cause) {
    console.error("[PROJECT] Ensure project cause:", err.cause);
  }
}

// ─── Ensure project ──────────────────────────────────────────────────────────

export async function ensure(c: Context) {
  const body = await c.req.json<TEnsureProjectBody>();
  try {
    const result = await getPlatformKernel().projects.ensure(operationContext(c), body);
    applyOperationContext(c, result.context);
    return c.json(result.data);
  } catch (err) {
    logEnsureProjectError(getRequestContext(c).userId, body, err);
    if (err instanceof AppError)
      return c.json({ success: false, error: err.message, code: err.code }, err.statusCode as 400);
    return c.json({ success: false, error: "Failed to ensure project" }, 500);
  }
}

// ─── Projects CRUD ───────────────────────────────────────────────────────────

export async function getHome(c: Context) {
  const result = await getPlatformKernel().projects.getHome(operationContext(c));
  applyOperationContext(c, result.context);
  return c.json(result.data);
}

export async function list(c: Context) {
  const result = await getPlatformKernel().projects.list(operationContext(c), {
    page: Number(c.req.query("page") ?? 1),
    perPage: Number(c.req.query("perPage") ?? 20),
  });
  applyOperationContext(c, result.context);
  return c.json(result.data);
}

export async function create(c: Context) {
  const result = await getPlatformKernel().projects.create(operationContext(c), await c.req.json());
  applyOperationContext(c, result.context);
  return c.json({ data: result.data }, 201);
}

export async function getById(c: Context) {
  const result = await getPlatformKernel().projects.get(operationContext(c), param(c, "id"));
  applyOperationContext(c, result.context);
  return c.json({ data: result.data });
}

// ─── Project environments ───────────────────────────────────────────────────

export async function listEnvironments(c: Context) {
  const result = await getPlatformKernel().projects.listEnvironments(
    operationContext(c),
    param(c, "id"),
  );
  applyOperationContext(c, result.context);
  return c.json({ success: true, data: result.data });
}

export async function createEnvironment(c: Context) {
  const result = await getPlatformKernel().projects.createEnvironment(
    operationContext(c),
    param(c, "id"),
    await c.req.json(),
  );
  applyOperationContext(c, result.context);
  return c.json({ success: true, data: result.data }, 201);
}

export async function update(c: Context) {
  const result = await getPlatformKernel().projects.update(
    operationContext(c),
    param(c, "id"),
    await c.req.json(),
  );
  applyOperationContext(c, result.context);
  return c.json({ data: result.data });
}

/**
 * Atomic project delete.
 *
 * Two paths:
 *   - graceful (default):  refuse with 409 if any deployment / build /
 *                          backup is still in flight. The dashboard
 *                          surfaces `active` so the user can cancel
 *                          and retry.
 *   - force=true:          cancel active work, wait up to 5s for
 *                          confirmed quiescence, then teardown.
 *
 * Delete flags are accepted as query parameters or JSON booleans in the
 * request body. An explicitly supplied query parameter wins.
 *
 * Both paths converge into `teardownProject`, which runs a named,
 * audited step sequence and reports per-step success/failure. The DB
 * row only drops after remote cleanup; FK CASCADE handles dependents.
 */
export async function remove(c: Context) {
  const raw = await c.req.text();
  const options = parseProjectDeleteOptions(
    {
      force: c.req.query("force"),
      forceOrphan: c.req.query("forceOrphan"),
      orphan: c.req.query("orphan"),
      wipeVolumes: c.req.query("wipeVolumes"),
      recordOnly: c.req.query("recordOnly"),
    },
    raw.trim() ? JSON.parse(raw) : undefined,
  );
  const result = await getPlatformKernel().projects.remove(
    operationContext(c),
    param(c, "id"),
    options,
  );
  applyOperationContext(c, result.context);
  return c.json(result.data, result.data.ok ? 200 : 207);
}

export async function deletionPreview(c: Context) {
  const result = await getPlatformKernel().projects.deletionPreview(
    operationContext(c),
    param(c, "id"),
  );
  applyOperationContext(c, result.context);
  return c.json({ success: true, preview: result.data });
}

/** POST /projects/:id/clear-build — explicit host-wide unused build-cache prune. */
export async function clearBuildCache(c: Context) {
  const result = await getPlatformKernel().projects.clearBuildCache(
    operationContext(c),
    param(c, "id"),
  );
  applyOperationContext(c, result.context);
  return c.json(result.data);
}

// ─── Environment variables ───────────────────────────────────────────────────

export async function listEnvVars(c: Context) {
  const result = await getPlatformKernel().projects.listEnvVars(
    operationContext(c),
    param(c, "id"),
    { environment: c.req.query("environment") },
  );
  applyOperationContext(c, result.context);
  return c.json({ data: result.data });
}

export async function mergeEnvVars(c: Context) {
  const result = await getPlatformKernel().projects.mergeEnvVars(
    operationContext(c),
    param(c, "id"),
    await c.req.json(),
  );
  applyOperationContext(c, result.context);
  return c.json(result.data);
}

// ─── Resources ───────────────────────────────────────────────────────────────

export async function getResources(c: Context) {
  const result = await getPlatformKernel().projects.getResources(
    operationContext(c),
    param(c, "id"),
  );
  applyOperationContext(c, result.context);
  return c.json({ success: true, data: result.data });
}

/** GET /projects/:id/rollback-capacity — the retention window in force, the
 *  measured snapshot size and the host's free disk, for the rollback label. */
export async function getRollbackCapacity(c: Context) {
  const result = await getPlatformKernel().projects.getRollbackCapacity(
    operationContext(c),
    param(c, "id"),
  );
  applyOperationContext(c, result.context);
  return c.json({ data: result.data });
}

/** POST /projects/:id/port-check — live, on-demand port-reachability audit of
 *  the active deployment's container(s). Advisory (never throws on probe
 *  failure); powers the Domains tab's "port not reachable" hint. */
export async function portCheck(c: Context) {
  const result = await getPlatformKernel().projects.checkPorts(operationContext(c), param(c, "id"));
  applyOperationContext(c, result.context);
  return c.json({ data: result.data });
}

/** POST /projects/:id/output-check — live static-output audit of the active
 *  deployment (advisory; static apps only). Powers the Domains tab's "no output
 *  found at this path" hint — the file-side twin of /port-check. */
export async function outputCheck(c: Context) {
  const result = await getPlatformKernel().projects.checkOutput(
    operationContext(c),
    param(c, "id"),
  );
  applyOperationContext(c, result.context);
  return c.json({ data: result.data });
}

export async function updateResources(c: Context) {
  const result = await getPlatformKernel().projects.updateResources(
    operationContext(c),
    param(c, "id"),
    await c.req.json(),
  );
  applyOperationContext(c, result.context);
  return c.json({ success: true, data: result.data });
}

// ─── Clone token (per-project override) ──────────────────────────────────────

/**
 * GET /projects/:id/clone-token - read-only state. Never returns the token,
 * only whether one is set and when it was set last.
 */
export async function getCloneToken(c: Context) {
  const result = await getPlatformKernel().projects.getCloneToken(
    operationContext(c),
    param(c, "id"),
  );
  applyOperationContext(c, result.context);
  return c.json(result.data);
}

/**
 * PATCH /projects/:id/clone-token - set/replace/clear the per-project clone token.
 *
 * Body:
 *   { token?: string | null }
 *
 *   token === null → clear.
 *   token: string  → encrypt and store. Empty string treated as clear.
 *
 * The token is encrypted on save and never echoed back. Resolves the chain
 * tier: project token > user-global > App > mode default.
 */
export async function updateCloneToken(c: Context) {
  const result = await getPlatformKernel().projects.updateCloneToken(
    operationContext(c),
    param(c, "id"),
    await c.req.json(),
  );
  applyOperationContext(c, result.context);
  return c.json(result.data);
}

// ─── Local projects ──────────────────────────────────────────────────────────

/** Scan a local directory and detect framework/stack */
export async function scanLocal(c: Context) {
  const result = await getPlatformKernel().projects.scanLocal(operationContext(c), await c.req.json());
  applyOperationContext(c, result.context);
  c.header("Cache-Control", "no-store");
  return c.json(result.data);
}

/** Import a local folder as a project */
export async function importLocal(c: Context) {
  const result = await getPlatformKernel().projects.importLocal(operationContext(c), await c.req.json());
  applyOperationContext(c, result.context);
  c.set("createdResourceId", result.data.id);
  return c.json({ data: result.data }, 201);
}

/** List only local projects for the current user */
export async function listLocal(c: Context) {
  const result = await getPlatformKernel().projects.listLocal(operationContext(c));
  applyOperationContext(c, result.context);
  return c.json(result.data);
}

// ─── Runtime logs ────────────────────────────────────────────────────────────

/**
 * GET /projects/:id/logs - one-shot fetch of recent runtime logs.
 */
export async function runtimeLogs(c: Context) {
  const result = await getPlatformKernel().projects.runtimeLogs(
    operationContext(c),
    param(c, "id"),
    { tail: c.req.query("tail") === undefined ? undefined : Number(c.req.query("tail")) },
  );
  applyOperationContext(c, result.context);
  return c.json({ data: result.data });
}

/**
 * GET /projects/:id/logs/stream - SSE stream of runtime logs.
 */
export async function runtimeLogStream(c: Context) {
  const ctx = operationContext(c);
  const id = param(c, "id");
  const input = { tail: c.req.query("tail") ? Number(c.req.query("tail")) : undefined };
  return streamSSE(c, async stream => {
    const abort = new AbortController();
    stream.onAbort(() => abort.abort());
    try {
      for await (const event of getPlatformKernel().projects.streamRuntimeLogs(ctx, id, input, { signal: abort.signal })) {
        await stream.writeSSE(event);
      }
    } catch (error) {
      if (!abort.signal.aborted)
        await stream.writeSSE({ event: "error", data: JSON.stringify({ error: error instanceof Error ? error.message : "Failed to stream logs" }) });
    } finally { abort.abort(); }
  });
}

// ─── Server HTTP request logs ────────────────────────────────────────────────

export async function serverLogStreamToken(c: Context) {
  const result = await getPlatformKernel().projects.getServerLogStreamToken(operationContext(c), param(c, "id"), { domain: c.req.query("domain") });
  applyOperationContext(c, result.context);
  return c.json(result.data);
}

/** Preserve the edge's SSE frames, including comments and split UTF-8 bytes. */
export async function serverLogStream(c: Context) {
  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, c.req.raw.signal]);
  const result = await getPlatformKernel().projects.openServerLogStream(operationContext(c), param(c, "id"), { domain: c.req.query("domain") }, { signal });
  applyOperationContext(c, result.context);
  return streamSSE(c, async stream => {
    stream.onAbort(() => abort.abort());
    try {
      for await (const chunk of result.data) await stream.write(chunk);
    } finally { abort.abort(); }
  });
}

export async function recentServerLogs(c: Context) {
  // Retain the HTTP query's historical clamping; native inputs are validated directly.
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") || "50", 10) || 50, 1), 200);
  const result = await getPlatformKernel().projects.recentServerLogs(operationContext(c), param(c, "id"), { domain: c.req.query("domain"), limit });
  applyOperationContext(c, result.context);
  return c.json(result.data);
}

// ─── Git info ────────────────────────────────────────────────────────────────

export async function getGitInfo(c: Context) {
  const result = await getPlatformKernel().projects.getGitInfo(operationContext(c), param(c, "id"));
  applyOperationContext(c, result.context);
  return c.json(result.data);
}

export async function listBranches(c: Context) {
  const result = await getPlatformKernel().projects.listBranches(
    operationContext(c),
    param(c, "id"),
    { page: Number(c.req.query("page") ?? 1) },
  );
  applyOperationContext(c, result.context);
  return c.json({ success: true, ...result.data });
}

/**
 * POST /projects/:id/git/link  { owner, repo, branch? }
 *
 * Links a GitHub repo to an existing project and registers a deploy webhook.
 */
export async function linkRepo(c: Context) {
  const result = await getPlatformKernel().projects.linkRepo(
    operationContext(c),
    param(c, "id"),
    await c.req.json(),
  );
  applyOperationContext(c, result.context);
  return c.json(result.data);
}

/** PUT /projects/:id/release-image-source — complete source transition, never
 * a partial generic project patch. */
export async function setReleaseImageSource(c: Context) {
  const result = await getPlatformKernel().projects.setReleaseImageSource(
    operationContext(c),
    param(c, "id"),
    await c.req.json(),
  );
  applyOperationContext(c, result.context);
  return c.json({ data: result.data });
}

export async function setAutoDeploy(c: Context) {
  const result = await getPlatformKernel().projects.setAutoDeploy(
    operationContext(c),
    param(c, "id"),
    await c.req.json(),
  );
  applyOperationContext(c, result.context);
  return c.json(result.data);
}

/**
 * POST /projects/:id/webhook-domain  { domain: string | null }
 *
 * Set or clear the domain used for receiving GitHub webhooks.
 *
 * When a domain is set:
 *   1. Validates it belongs to this project and is verified
 *   2. Adds /_openship/hooks/ location to the domain's nginx config
 *   3. The webhook URL becomes https://{domain}/_openship/hooks/github
 *
 * When domain is null → clears the webhook domain (falls back to edge relay or none).
 */
export async function setWebhookDomain(c: Context) {
  const result = await getPlatformKernel().projects.setWebhookDomain(
    operationContext(c),
    param(c, "id"),
    await c.req.json(),
  );
  applyOperationContext(c, result.context);
  return c.json(result.data);
}

export async function setBranch(c: Context) {
  const result = await getPlatformKernel().projects.setBranch(
    operationContext(c),
    param(c, "id"),
    await c.req.json(),
  );
  applyOperationContext(c, result.context);
  return c.json(result.data);
}

// ─── Build options ───────────────────────────────────────────────────────────

export async function setOptions(c: Context) {
  const result = await getPlatformKernel().projects.setOptions(
    operationContext(c),
    param(c, "id"),
    await c.req.json(),
  );
  applyOperationContext(c, result.context);
  return c.json({ data: result.data });
}

/**
 * GET /:id/commit-status — drift check for the "project outdated" banner.
 *
 * Goes through the updates service rather than resolving drift here, so this
 * banner and the issues feed are the same computation. It also caches what it
 * polls, which is what stops a visit to this page from knowing more than the
 * tracker does.
 */
export async function getCommitStatus(c: Context) {
  const result = await getPlatformKernel().projects.getCommitStatus(
    operationContext(c),
    param(c, "id"),
  );
  applyOperationContext(c, result.context);
  return c.json({ data: result.data });
}

/**
 * GET /projects/:id/pending-actions — everything waiting on a human for this
 * project, each item carrying the call that resolves it.
 *
 * On-demand like the other attention reads (`/commit-status`, `/port-check`,
 * `/routing/edge-status`), so the project list and detail reads pay nothing.
 */
export async function getPendingActions(c: Context) {
  const result = await getPlatformKernel().projects.getPendingActions(
    operationContext(c),
    param(c, "id"),
  );
  applyOperationContext(c, result.context);
  return c.json({ data: result.data });
}

// ─── Sleep mode ──────────────────────────────────────────────────────────────

export async function setSleepMode(c: Context) {
  const result = await getPlatformKernel().projects.setSleepMode(
    operationContext(c),
    param(c, "id"),
    await c.req.json(),
  );
  applyOperationContext(c, result.context);
  return c.json(result.data);
}

// ─── Enable / Disable ────────────────────────────────────────────────────────

export async function enable(c: Context) {
  const result = await getPlatformKernel().projects.enable(operationContext(c), param(c, "id"));
  applyOperationContext(c, result.context);
  return c.json(result.data);
}

export async function disable(c: Context) {
  const result = await getPlatformKernel().projects.disable(operationContext(c), param(c, "id"));
  applyOperationContext(c, result.context);
  return c.json(result.data);
}

/** Re-run the managed free-domain edge-proxy sync (no rebuild). Clears the
 *  "Action Required" routing warning on success; returns the failure text
 *  (200, ok:false) when it still can't sync so the UI re-surfaces guidance. */
export async function retryRouting(c: Context) {
  const result = await getPlatformKernel().projects.retryRouting(
    operationContext(c),
    param(c, "id"),
  );
  applyOperationContext(c, result.context);
  return c.json(result.data);
}

// ─── Project deployments ─────────────────────────────────────────────────────

export async function listDeployments(c: Context) {
  const result = await getPlatformKernel().projects.listDeployments(
    operationContext(c),
    param(c, "id"),
    {
      page: Number(c.req.query("page") ?? 1),
      perPage: Number(c.req.query("perPage") ?? 20),
      environment: c.req.query("environment"),
      status: c.req.query("status") as import("@repo/core").DeploymentHistoryFilter | undefined,
      search: c.req.query("search"),
    },
  );
  applyOperationContext(c, result.context);
  return c.json(result.data);
}

// ─── Deployment session ──────────────────────────────────────────────────────

export async function deploymentSession(c: Context) {
  const result = await getPlatformKernel().projects.deploymentSession(
    operationContext(c),
    param(c, "id"),
  );
  applyOperationContext(c, result.context);
  return c.json(result.data);
}

// ─── Project info (enriched) ─────────────────────────────────────────────────

export async function getInfo(c: Context) {
  const result = await getPlatformKernel().projects.getInfo(operationContext(c), param(c, "id"));
  applyOperationContext(c, result.context);
  return c.json({ success: true, data: result.data });
}

// ─── Connect custom domain ─────────────────────────────────────────────────────

export async function connectDomain(c: Context) {
  const result = await getPlatformKernel().projects.connectDomain(operationContext(c), param(c, "id"), await c.req.json());
  applyOperationContext(c, result.context);
  return c.json(result.data);
}
