import type { Context } from "hono";
import { audit, auditContextFrom } from "../../lib/audit";
import { getRequestContext } from "../../lib/request-context";
import { streamSSE } from "../../lib/sse";
import { AppError } from "@repo/core";
import type { TRemoveSwarmStackBody, TScaleSwarmServiceBody } from "./swarm-source.schema";
import { swarmOperations } from "./swarm-operations.service";

function logOptions(c: Context) {
  const tailValue = c.req.query("tail");
  const tail = tailValue === undefined ? undefined : Number(tailValue);
  if (tail !== undefined && (!Number.isInteger(tail) || tail < 1 || tail > 1_000)) {
    throw new AppError("Log tail must be an integer from 1 to 1,000.", 400, "SWARM_LOG_TAIL_INVALID");
  }
  const since = c.req.query("since");
  if (since !== undefined && (!since.trim() || since.length > 128 || !/^[0-9T:.+\-Zsmhdw]+$/i.test(since))) {
    throw new AppError("Log since must be an RFC3339 timestamp or Docker duration.", 400, "SWARM_LOG_SINCE_INVALID");
  }
  const timestampsValue = c.req.query("timestamps");
  if (timestampsValue !== undefined && timestampsValue !== "true" && timestampsValue !== "false") {
    throw new AppError("timestamps must be true or false.", 400, "SWARM_LOG_TIMESTAMPS_INVALID");
  }
  return {
    ...(tail !== undefined ? { tail } : {}),
    ...(since !== undefined ? { since } : {}),
    ...(timestampsValue !== undefined ? { timestamps: timestampsValue === "true" } : {}),
    ...(c.req.query("taskId") ? { taskId: c.req.query("taskId")! } : {}),
  };
}

export async function scale(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json<TScaleSwarmServiceBody>();
  const result = await swarmOperations.scale({
    projectId: c.req.param("id")!,
    organizationId: ctx.organizationId,
    serviceName: c.req.param("serviceName")!,
    replicas: body.replicas,
    persistence: body.persistence,
  });
  audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
    eventType: "swarm.service.scaled",
    resourceType: "project",
    resourceId: c.req.param("id")!,
    after: {
      serviceName: result.serviceName,
      replicas: result.replicas,
      persistence: result.persistence,
      sourcePersisted: result.sourcePersisted,
      state: result.state,
    },
  });
  return c.json(result);
}

export async function restart(c: Context) {
  const ctx = getRequestContext(c);
  const result = await swarmOperations.restart({
    projectId: c.req.param("id")!,
    organizationId: ctx.organizationId,
    serviceName: c.req.param("serviceName")!,
  });
  audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
    eventType: "swarm.service.restarted",
    resourceType: "project",
    resourceId: c.req.param("id")!,
    after: {
      serviceName: result.serviceName,
      serviceId: result.serviceId,
      previousTaskIds: result.previousTaskIds,
      state: result.state,
    },
  });
  return c.json(result);
}

export async function logs(c: Context) {
  const ctx = getRequestContext(c);
  const result = await swarmOperations.logs({
    projectId: c.req.param("id")!,
    organizationId: ctx.organizationId,
    serviceName: c.req.param("serviceName")!,
    ...logOptions(c),
  });
  return c.json({ data: result });
}

export async function logStream(c: Context) {
  const ctx = getRequestContext(c);
  const input = {
    projectId: c.req.param("id")!,
    organizationId: ctx.organizationId,
    serviceName: c.req.param("serviceName")!,
    ...logOptions(c),
  };
  return streamSSE(c, async (sseStream) => {
    let stop: (() => void) | null = null;
    try {
      const stream = await swarmOperations.streamLogs(input, (entry) => {
        void sseStream.writeSSE({ event: "log", data: JSON.stringify(entry) });
      });
      stop = stream.stop;
      sseStream.onAbort(() => stop?.());
      await stream.done;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to stream Swarm service logs.";
      await sseStream.writeSSE({ event: "error", data: JSON.stringify({ error: message }) });
      stop?.();
    }
  });
}

export async function remove(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json<TRemoveSwarmStackBody>();
  const result = await swarmOperations.remove({
    projectId: c.req.param("id")!,
    organizationId: ctx.organizationId,
    confirmedStackName: body.confirmedStackName,
    expectedSourceVersion: body.expectedSourceVersion,
  });
  audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
    eventType: "swarm.stack.removed",
    resourceType: "project",
    resourceId: c.req.param("id")!,
    after: result,
  });
  return c.json(result);
}
