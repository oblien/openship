/**
 * Deployment controller — Hono request handlers.
 */

import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { getUserId, param } from "../../lib/controller-helpers";
import * as deploymentService from "./deployment.service";
import * as buildService from "./build.service";
import * as sslService from "./ssl.service";
import * as prepareService from "./prepare.service";
import { env } from "../../config";

// ─── Handlers ────────────────────────────────────────────────────────────────

export async function list(c: Context) {
  const userId = getUserId(c);
  const projectId = c.req.query("projectId");
  const environment = c.req.query("environment");
  const page = Number(c.req.query("page") ?? 1);
  const perPage = Number(c.req.query("perPage") ?? 50);

  const result = await deploymentService.listDeployments(userId, {
    projectId: projectId ?? undefined,
    environment: environment ?? undefined,
    page,
    perPage,
  });

  return c.json({
    success: true,
    data: result.rows,
    total: result.total,
    page: result.page,
    perPage: result.perPage,
  });
}

export async function create(c: Context) {
  const userId = getUserId(c);
  const body = await c.req.json<{ projectId: string; branch?: string; commitSha?: string; environment?: string }>();
  const result = await buildService.triggerDeployment(userId, body);
  return c.json({ data: result }, 202);
}

export async function getById(c: Context) {
  const userId = getUserId(c);
  const id = param(c, "id");
  const dep = await deploymentService.getDeployment(id, userId);
  return c.json({ data: dep });
}

export async function logs(c: Context) {
  const userId = getUserId(c);
  const id = param(c, "id");
  const tail = c.req.query("tail") ? Number(c.req.query("tail")) : undefined;
  const logEntries = await deploymentService.getDeploymentLogs(id, userId, tail);
  return c.json({ data: logEntries });
}

/**
 * Shared SSE streaming helper — subscribes to a build session and
 * keeps the connection open until the client disconnects or session ends.
 */
function streamBuildSession(c: Context, deploymentId: string, initialEvent?: { event: string; data: string }) {
  return streamSSE(c, async (sseStream) => {
    let closed = false;

    if (initialEvent) {
      await sseStream.writeSSE(initialEvent);
    }

    const writer = (event: string, data: string): boolean => {
      if (closed) return false;
      try {
        void sseStream.writeSSE({ event, data });
        return true;
      } catch {
        return false;
      }
    };

    const { success, unsubscribe } = buildService.subscribeToBuildSession(deploymentId, writer);

    if (!success) {
      await sseStream.writeSSE({ event: "error", data: JSON.stringify({ error: "Session not found" }) });
      return;
    }

    await new Promise<void>((resolve) => {
      const checkInterval = setInterval(() => {
        if (closed) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 1000);

      sseStream.onAbort(() => {
        closed = true;
        unsubscribe();
        clearInterval(checkInterval);
        resolve();
      });
    });
  });
}

/**
 * SSE endpoint for streaming build logs in real-time.
 * GET /deployments/:id/stream
 */
export async function stream(c: Context) {
  const userId = getUserId(c);
  const id = param(c, "id");
  // Verify the requesting user owns this deployment before streaming
  await deploymentService.getDeployment(id, userId);
  return streamBuildSession(c, id);
}

export async function rollback(c: Context) {
  const userId = getUserId(c);
  const id = param(c, "id");
  const dep = await deploymentService.rollbackDeployment(id, userId);
  return c.json({ data: dep });
}

export async function cancel(c: Context) {
  const userId = getUserId(c);
  const id = param(c, "id");
  try {
    const result = await buildService.cancelBuildSession(id, userId);
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to cancel deployment";
    return c.json({ success: false, error: message }, 400);
  }
}

export async function remove(c: Context) {
  const userId = getUserId(c);
  const id = param(c, "id");
  try {
    await deploymentService.deleteDeployment(id, userId);
    return c.json({ success: true, message: "Deployment deleted" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to delete deployment";
    return c.json({ success: false, error: message }, 400);
  }
}

export async function restart(c: Context) {
  const userId = getUserId(c);
  const id = param(c, "id");
  const dep = await deploymentService.restartDeployment(id, userId);
  return c.json({ data: dep });
}

export async function containerInfo(c: Context) {
  const userId = getUserId(c);
  const id = param(c, "id");
  const info = await deploymentService.getContainerInfo(id, userId);
  return c.json({ data: info });
}

export async function containerUsage(c: Context) {
  const userId = getUserId(c);
  const id = param(c, "id");
  const usage = await deploymentService.getContainerUsage(id, userId);
  return c.json({ data: usage });
}

export async function buildRespond(c: Context) {
  const userId = getUserId(c);
  const id = param(c, "id");
  const body = await c.req.json<{ action: string }>();
  if (!body.action) return c.json({ success: false, error: "Missing action" }, 400);
  const result = await buildService.respondToPrompt(id, userId, body.action);
  return c.json({ success: result });
}

// ─── Prepare (resolve project info) ────────────────────────────────────────────

/**
 * POST /deployments/prepare — resolve project info from GitHub or local path.
 *
 * Body (GitHub): { source: "github", owner, repo }
 * Body (local):  { source: "local", path: "/abs/path" }
 * Legacy:        { owner, repo }  (treated as GitHub)
 */
export async function prepare(c: Context) {
  const userId = getUserId(c);
  const body = await c.req.json<{
    source?: "github" | "local";
    owner?: string;
    repo?: string;
    path?: string;
  }>();

  // Determine source — legacy callers send { owner, repo } without source
  const source = body.source ?? (body.owner && body.repo ? "github" : undefined);

  try {
    let input: prepareService.Source;

    if (source === "github") {
      if (!body.owner || !body.repo) {
        return c.json({ error: "owner and repo are required" }, 400);
      }
      input = { source: "github", owner: body.owner, repo: body.repo, userId };
    } else if (source === "local") {
      if (env.CLOUD_MODE) {
        return c.json({ error: "Local projects are not available in cloud mode" }, 403);
      }
      if (!body.path) {
        return c.json({ error: "path is required" }, 400);
      }
      input = { source: "local", path: body.path };
    } else {
      return c.json({ error: "source must be 'github' or 'local'" }, 400);
    }

    const info = await prepareService.resolveProjectInfo(input);
    return c.json(info);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to initialize deploy";
    return c.json({ error: message }, 400);
  }
}

// ─── Build access / status / cancel / redeploy ───────────────────────────────

/**
 * POST /deployments/build/access — create deployment + build session for existing project.
 * Requires { projectId }. Returns { success, deployment_id, project_id }.
 */
export async function buildAccess(c: Context) {
  const userId = getUserId(c);
  const body = await c.req.json<buildService.BuildAccessInput>();

  if (!body.projectId) {
    return c.json({ success: false, message: "projectId is required" }, 400);
  }

  try {
    const result = await buildService.requestBuildAccess(userId, body);
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to start deployment";
    return c.json({ success: false, message }, 400);
  }
}

/**
 * GET /deployments/:id/build — get build session status and config.
 */
export async function buildStatus(c: Context) {
  const userId = getUserId(c);
  const id = param(c, "id");

  try {
    const result = await buildService.getBuildSessionStatus(id, userId);
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Build session not found";
    return c.json({ success: false, error: message }, 404);
  }
}

/**
 * POST /deployments/:id/redeploy — redeploy from an existing deployment.
 */
export async function buildRedeploy(c: Context) {
  const userId = getUserId(c);
  const id = param(c, "id");

  try {
    const result = await buildService.redeployBuildSession(id, userId);
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to redeploy";
    return c.json({ success: false, error: message }, 400);
  }
}

/**
 * POST /deployments/:id/build — start a build for a queued deployment.
 * Kicks off the build pipeline, then streams build logs via SSE.
 * Client can reconnect via GET /:id/stream.
 */
export async function buildStart(c: Context) {
  const userId = getUserId(c);
  const deploymentId = param(c, "id");

  let result;
  try {
    result = await buildService.startBuild(deploymentId, userId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to start build";
    return c.json({ success: false, error: message }, 400);
  }

  return streamBuildSession(c, deploymentId, {
    event: "started",
    data: JSON.stringify({
      type: "started",
      deployment_id: result.deployment_id,
      project_id: result.project_id,
    }),
  });
}

// ─── SSL ─────────────────────────────────────────────────────────────────────

/**
 * POST /deployments/ssl/status — check SSL status for a domain.
 */
export async function sslStatus(c: Context) {
  const userId = getUserId(c);
  const body = await c.req.json<{ domain: string }>();

  if (!body.domain) {
    return c.json({ success: false, error: "domain is required" }, 400);
  }

  try {
    const result = await sslService.getStatus(body.domain, userId);
    return c.json({ success: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to check SSL status";
    return c.json({ success: false, error: message }, 400);
  }
}

/**
 * POST /deployments/ssl/renew — renew SSL certificate for a domain.
 */
export async function sslRenew(c: Context) {
  const userId = getUserId(c);
  const body = await c.req.json<{ domain: string; includeWww?: boolean }>();

  if (!body.domain) {
    return c.json({ success: false, error: "domain is required" }, 400);
  }

  try {
    const result = await sslService.renew(body.domain, userId, body.includeWww);
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to renew SSL";
    return c.json({ success: false, error: message }, 400);
  }
}
