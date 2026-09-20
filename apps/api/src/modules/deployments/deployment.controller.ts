/**
 * Deployment controller - Hono request handlers.
 */

import type { Context } from "hono";
import { AppError } from "@repo/core";
import { freezeContext } from "@repo/platform";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { operationContext, applyOperationContext } from "../../lib/operation-context";
import { resolveCallSource, resolveCallClientId } from "../../lib/call-source";
import { streamSSE } from "../../lib/sse";
import { param } from "../../lib/controller-helpers";
import { getRequestContext } from "../../lib/request-context";
import { permission } from "../../lib/permission";
import * as deploymentService from "@repo/platform/engine/modules/deployments/deployment.service";
import * as buildService from "@repo/platform/engine/modules/deployments/build.service";
import { env } from "@repo/platform/engine/config/index";

export async function list(c: Context) {
  const result = await getPlatformKernel().deployments.list(operationContext(c), {
    projectId: c.req.query("projectId"), environment: c.req.query("environment") as "production" | "preview" | undefined,
    page: Number(c.req.query("page") ?? 1), perPage: Number(c.req.query("perPage") ?? 50),
    status: c.req.query("status") as import("@repo/core").DeploymentHistoryFilter | undefined,
    search: c.req.query("search"),
  });
  applyOperationContext(c, result.context);
  return c.json({ success: true, ...result.data });
}

export async function create(c: Context) {
  const body = await c.req.json<{ trigger?: unknown }>();
  const hint = c.req.header("X-Project-Source")?.toLowerCase();
  const { context, data } = await getPlatformKernel().deployments.create(
    {
      ...freezeContext(getRequestContext(c)),
      source: resolveCallSource(c),
      sourceClientId: resolveCallClientId(c),
    },
    body,
    {
      // Preserve the existing webhook-forward marker. Private build snapshot,
      // rollback, and migration flags are never part of the public command.
      trigger: body?.trigger === "webhook" ? "webhook" : undefined,
      projectSource: hint === "local" || hint === "cloud" ? hint : undefined,
    },
  );
  applyOperationContext(c, context);
  return c.json({ data }, 202);
}

export async function getById(c: Context) {
  const result = await getPlatformKernel().deployments.get(operationContext(c), param(c, "id"));
  applyOperationContext(c, result.context);
  return c.json({ data: result.data });
}

export async function logs(c: Context) {
  const result = await getPlatformKernel().deployments.logs(operationContext(c), param(c, "id"), {
    tail: c.req.query("tail") ? Number(c.req.query("tail")) : undefined,
  });
  applyOperationContext(c, result.context);
  return c.json({ data: result.data });
}

/**
 * Shared SSE streaming helper - subscribes to a build session and
 * keeps the connection open until the client disconnects or session ends.
 */
function streamBuildSession(
  c: Context,
  deploymentId: string,
  initialEvent?: { event: string; data: string },
  sinceSeq?: number,
) {
  return streamSSE(c, async (sseStream) => {
    const abort = new AbortController();
    sseStream.onAbort(() => abort.abort());
    try {
      if (initialEvent) await sseStream.writeSSE(initialEvent);
      for await (const event of getPlatformKernel().deployments.events(operationContext(c), deploymentId, { since: sinceSeq, signal: abort.signal }))
        await sseStream.writeSSE(event);
    } finally { abort.abort(); }
  });
}

export async function stream(c: Context) {
  const ctx = getRequestContext(c);
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), {
    resourceType: "deployment",
    resourceId: id,
    action: "read",
  });
  // Verify the requesting user owns this deployment before streaming
  await deploymentService.getDeployment(id, ctx.organizationId);
  // Resume cursor: explicit ?since= (the client's history-snapshot max seq),
  // falling back to the EventSource Last-Event-ID header on native reconnect.
  const sinceRaw = c.req.query("since") ?? c.req.header("Last-Event-ID");
  const sinceSeq = sinceRaw != null && sinceRaw !== "" ? Number(sinceRaw) : undefined;
  return streamBuildSession(c, id, undefined, Number.isFinite(sinceSeq) ? sinceSeq : undefined);
}

export async function rollback(c: Context) {
  const result = await getPlatformKernel().deployments.rollback(operationContext(c), param(c, "id"));
  applyOperationContext(c, result.context);
  return c.json({ data: result.data });
}

/** GET /deployments/:id/restore-plan — how a rollback here would run. */
export async function restorePlan(c: Context) {
  const result = await getPlatformKernel().deployments.restorePlan(operationContext(c), param(c, "id"));
  applyOperationContext(c, result.context);
  return c.json({ data: result.data });
}

export async function pin(c: Context) {
  const body = await c.req.json<{ pinned?: boolean }>().catch(() => ({}));
  const result = await getPlatformKernel().deployments.pin(operationContext(c), param(c, "id"), body);
  applyOperationContext(c, result.context);
  return c.json({ data: result.data });
}

export async function reject(c: Context) {
  const result = await getPlatformKernel().deployments.reject(operationContext(c), param(c, "id"));
  applyOperationContext(c, result.context);
  return c.json(result.data);
}

export async function keep(c: Context) {
  const result = await getPlatformKernel().deployments.keep(operationContext(c), param(c, "id"));
  applyOperationContext(c, result.context);
  return c.json(result.data);
}

export async function skipPortCheck(c: Context) {
  const body = await c.req.json<{ target: number | string }>();
  const result = await getPlatformKernel().deployments.skipPortCheck(operationContext(c), param(c, "id"), body);
  applyOperationContext(c, result.context);
  return c.json(result.data);
}

export async function cancel(c: Context) {
  const result = await getPlatformKernel().deployments.cancel(operationContext(c), param(c, "id"));
  applyOperationContext(c, result.context);
  return c.json(result.data, result.data.pending ? 202 : 200);
}

export async function remove(c: Context) {
  const result = await getPlatformKernel().deployments.remove(operationContext(c), param(c, "id"));
  applyOperationContext(c, result.context);
  return c.json(result.data);
}

export async function restart(c: Context) {
  const result = await getPlatformKernel().deployments.restart(operationContext(c), param(c, "id"));
  applyOperationContext(c, result.context);
  return c.json({ data: result.data });
}

export async function containerInfo(c: Context) {
  const result = await getPlatformKernel().deployments.containerInfo(operationContext(c), param(c, "id"));
  applyOperationContext(c, result.context);
  return c.json({ data: result.data });
}

export async function containerUsage(c: Context) {
  const result = await getPlatformKernel().deployments.containerUsage(operationContext(c), param(c, "id"));
  applyOperationContext(c, result.context);
  return c.json({ data: result.data });
}

/**
 * GET /deployments/:id/pending — what this specific deploy is waiting on.
 *
 * Same builders as the project-scoped view (see pending-actions.service), so the
 * two can't describe one condition differently. This is the one to poll while
 * watching a deploy: a held prompt appears here with its deadline and the exact
 * body that answers it.
 */
export async function pendingActions(c: Context) {
  const result = await getPlatformKernel().deployments.pendingActions(operationContext(c), param(c, "id"));
  applyOperationContext(c, result.context);
  return c.json({ data: result.data });
}

export async function buildRespond(c: Context) {
  const body = await c.req.json<{ action: string }>();
  const result = await getPlatformKernel().deployments.respond(operationContext(c), param(c, "id"), body);
  applyOperationContext(c, result.context);
  return c.json(result.data);
}

/**
 * POST /deployments/prepare - resolve project info from GitHub or local path.
 *
 * Body (GitHub): { source: "github", owner, repo, branch? }
 * Body (local):  { source: "local", path: "/abs/path" }
 * Callers may omit `source` and send { owner, repo }; treated as GitHub.
 */
export async function prepare(c: Context) {
  c.header("Cache-Control", "no-store");
  try {
    const result = await getPlatformKernel().deployments.prepare(operationContext(c), await c.req.json());
    applyOperationContext(c, result.context);
    return c.json(result.data);
  } catch (err) {
    if (err instanceof AppError) throw err;
    return c.json({ error: err instanceof Error ? err.message : "Failed to initialize deploy" }, 400);
  }
}

export async function buildAccess(c: Context) {
  try {
    const result = await getPlatformKernel().deployments.buildAccess(operationContext(c), await c.req.json());
    applyOperationContext(c, result.context);
    return c.json({ success: true, ...result.data });
  } catch (err) {
    if (err instanceof AppError) throw err;
    return c.json({ success: false, message: err instanceof Error ? err.message : "Failed to start deployment" }, 400);
  }
}

export async function buildStatus(c: Context) {
  const result = await getPlatformKernel().deployments.buildStatus(operationContext(c), param(c, "id"));
  applyOperationContext(c, result.context);
  return c.json(result.data);
}

/**
 * POST /deployments/:id/redeploy - redeploy from an existing deployment.
 *
 * Body (optional):
 *   { useExistingCommit?: boolean } — when true, rebuilds against the SAME
 *   commit SHA the old deployment used (fallback for users whose artifact
 *   has been purged from the rollback window). Default (omitted/false)
 *   resolves the latest commit on the branch — the auto-redeploy semantic.
 */
export async function buildRedeploy(c: Context) {
  const body = await c.req.json<{ useExistingCommit?: boolean }>().catch(() => ({}));
  const result = await getPlatformKernel().deployments.redeploy(operationContext(c), param(c, "id"), body);
  applyOperationContext(c, result.context);
  return c.json({ success: true, ...result.data });
}

/**
 * POST /deployments/:id/build - start a build for a queued deployment.
 * Kicks off the build pipeline, then streams build logs via SSE.
 * Client can reconnect via GET /:id/stream.
 */
export async function buildStart(c: Context) {
  const result = await getPlatformKernel().deployments.start(operationContext(c), param(c, "id"));
  applyOperationContext(c, result.context);
  return streamBuildSession(c, result.data.deployment_id, {
    event: "started", data: JSON.stringify({ type: "started", ...result.data }),
  });
}

export async function sslStatus(c: Context) {
  const body = await c.req.json<{ domain: string }>();
  if (!body.domain) {
    return c.json({ success: false, error: "domain is required" }, 400);
  }
  const result = await getPlatformKernel().deployments.sslStatus(operationContext(c), body);
  applyOperationContext(c, result.context);
  return c.json(result.data);
}

export async function sslRenew(c: Context) {
  const body = await c.req.json<{ domain: string; includeWww?: boolean }>();
  if (!body.domain) {
    return c.json({ success: false, error: "domain is required" }, 400);
  }
  const result = await getPlatformKernel().deployments.renewSsl(operationContext(c), body);
  applyOperationContext(c, result.context);
  return c.json(result.data);
}
