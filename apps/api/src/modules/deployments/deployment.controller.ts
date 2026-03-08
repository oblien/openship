/**
 * Deployment controller — Hono request handlers.
 */

import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { getUserId, param } from "../../lib/controller-helpers";
import * as deploymentService from "./deployment.service";
import type { TTriggerDeployBody } from "./deployment.schema";

// ─── Handlers ────────────────────────────────────────────────────────────────

export async function list(c: Context) {
  const userId = getUserId(c);
  const projectId = c.req.query("projectId");
  const environment = c.req.query("environment");
  const page = Number(c.req.query("page") ?? 1);
  const perPage = Number(c.req.query("perPage") ?? 20);

  const result = await deploymentService.listDeployments(userId, {
    projectId: projectId ?? undefined,
    environment: environment ?? undefined,
    page,
    perPage,
  });

  return c.json({
    data: result.rows,
    total: result.total,
    page: result.page,
    perPage: result.perPage,
  });
}

export async function create(c: Context) {
  const userId = getUserId(c);
  const body = await c.req.json<TTriggerDeployBody>();
  const result = await deploymentService.triggerDeployment(userId, body);
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
 * SSE endpoint for streaming build logs in real-time.
 * GET /deployments/:id/stream?sessionId=bld_xxx
 */
export async function stream(c: Context) {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) {
    return c.json({ error: "sessionId query parameter required" }, 400);
  }

  return streamSSE(c, async (sseStream) => {
    let closed = false;

    const writer = (event: string, data: string): boolean => {
      if (closed) return false;
      try {
        void sseStream.writeSSE({ event, data });
        return true;
      } catch {
        return false;
      }
    };

    const { success, unsubscribe } = deploymentService.subscribeToBuildSession(sessionId, writer);

    if (!success) {
      await sseStream.writeSSE({ event: "error", data: JSON.stringify({ error: "Session not found" }) });
      return;
    }

    // Keep the stream open until client disconnects or session ends
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

export async function rollback(c: Context) {
  const userId = getUserId(c);
  const id = param(c, "id");
  const dep = await deploymentService.rollbackDeployment(id, userId);
  return c.json({ data: dep });
}

export async function cancel(c: Context) {
  const userId = getUserId(c);
  const id = param(c, "id");
  await deploymentService.cancelDeployment(id, userId);
  return c.json({ message: "deployment cancelled" });
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

export async function buildLogs(c: Context) {
  const userId = getUserId(c);
  const id = param(c, "id");
  const logEntries = await deploymentService.getBuildLogs(id, userId);
  return c.json({ data: logEntries });
}
