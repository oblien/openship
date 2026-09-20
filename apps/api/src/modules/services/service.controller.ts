/** HTTP envelopes over the shared authorized service operations. */
import type { Context } from "hono";
import type { OperationResult } from "@repo/platform";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { operationContext, applyOperationContext } from "../../lib/operation-context";
import { param } from "../../lib/controller-helpers";
import { streamSSE } from "../../lib/sse";

async function result<T>(c: Context, work: Promise<OperationResult<T>>): Promise<T> {
  const { context, data } = await work;
  applyOperationContext(c, context);
  return data;
}
const operations = () => getPlatformKernel().services;

export async function list(c: Context) {
  const data = await result(c, operations().list(operationContext(c), param(c, "id")));
  return c.json({ success: true, services: data });
}

export async function getById(c: Context) {
  const data = await result(
    c,
    operations().get(operationContext(c), param(c, "id"), param(c, "serviceId")),
  );
  return c.json({ success: true, service: data });
}

export async function create(c: Context) {
  const data = await result(
    c,
    operations().create(operationContext(c), param(c, "id"), await c.req.json()),
  );
  return c.json({ success: true, service: data }, 201);
}

export async function update(c: Context) {
  const data = await result(
    c,
    operations().update(
      operationContext(c),
      param(c, "id"),
      param(c, "serviceId"),
      await c.req.json(),
    ),
  );
  return c.json({ success: true, service: data });
}

export async function remove(c: Context) {
  const data = await result(
    c,
    operations().remove(operationContext(c), param(c, "id"), param(c, "serviceId")),
  );
  return c.json(data);
}

export async function acceptDrift(c: Context) {
  const data = await result(
    c,
    operations().acceptDrift(operationContext(c), param(c, "id"), param(c, "serviceId")),
  );
  return c.json({ success: true, service: data });
}

export async function keepDrift(c: Context) {
  const data = await result(
    c,
    operations().keepDrift(operationContext(c), param(c, "id"), param(c, "serviceId")),
  );
  return c.json({ success: true, service: data });
}

export async function listEnvVars(c: Context) {
  const data = await result(
    c,
    operations().listEnvVars(operationContext(c), param(c, "id"), param(c, "serviceId"), {
      environment: c.req.query("environment") || undefined,
    } as Parameters<ReturnType<typeof operations>["listEnvVars"]>[3]),
  );
  return c.json({ success: true, vars: data });
}

export async function setEnvVars(c: Context) {
  const data = await result(
    c,
    operations().setEnvVars(
      operationContext(c),
      param(c, "id"),
      param(c, "serviceId"),
      await c.req.json(),
    ),
  );
  return c.json(data);
}

export async function revealEnv(c: Context) {
  const data = await result(
    c,
    operations().revealEnv(
      operationContext(c),
      param(c, "id"),
      param(c, "serviceId"),
      await c.req.json().catch(() => ({})),
    ),
  );
  return c.json({ success: true, environment: data });
}

export async function volumeSizes(c: Context) {
  const data = await result(
    c,
    operations().volumeSizes(operationContext(c), param(c, "id"), param(c, "serviceId")),
  );
  return c.json(data);
}

export async function activeContainers(c: Context) {
  const data = await result(c, operations().activeContainers(operationContext(c), param(c, "id")));
  return c.json({ success: true, containers: data });
}

export async function syncFromCompose(c: Context) {
  const data = await result(
    c,
    operations().sync(operationContext(c), param(c, "id"), await c.req.json()),
  );
  return c.json({ success: true, services: data });
}

export async function startContainer(c: Context) {
  const data = await result(
    c,
    operations().start(operationContext(c), param(c, "id"), param(c, "serviceId")),
  );
  return c.json(data);
}

export async function stopContainer(c: Context) {
  const data = await result(
    c,
    operations().stop(operationContext(c), param(c, "id"), param(c, "serviceId")),
  );
  return c.json(data);
}

export async function restartContainer(c: Context) {
  const data = await result(
    c,
    operations().restart(operationContext(c), param(c, "id"), param(c, "serviceId"), {
      force: ["true", "1"].includes(c.req.query("force") ?? ""),
    }),
  );
  return c.json(data);
}

export async function applyEnvironment(c: Context) {
  const data = await result(
    c,
    operations().applyEnvironment(operationContext(c), param(c, "id"), param(c, "serviceId")),
  );
  return c.json(data);
}

export async function runtimeLogs(c: Context) {
  const data = await result(
    c,
    operations().runtimeLogs(operationContext(c), param(c, "id"), param(c, "serviceId"), {
      tail: c.req.query("tail") ? Number(c.req.query("tail")) : undefined,
    }),
  );
  return c.json({ data });
}

export async function execInService(c: Context) {
  const data = await result(
    c,
    operations().exec(
      operationContext(c),
      param(c, "id"),
      param(c, "serviceId"),
      await c.req.json(),
    ),
  );
  return c.json({ data });
}

export async function runtimeLogStream(c: Context) {
  const ctx = operationContext(c);
  const projectId = param(c, "id");
  const serviceId = param(c, "serviceId");
  const input = { tail: c.req.query("tail") ? Number(c.req.query("tail")) : undefined };
  return streamSSE(c, async (stream) => {
    const abort = new AbortController();
    stream.onAbort(() => abort.abort());
    try {
      for await (const event of operations().streamLogs(ctx, projectId, serviceId, input, {
        signal: abort.signal,
      })) {
        await stream.writeSSE(event);
      }
    } catch (error) {
      if (!abort.signal.aborted)
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({
            error: error instanceof Error ? error.message : "Failed to stream logs",
          }),
        });
    } finally {
      abort.abort();
    }
  });
}
