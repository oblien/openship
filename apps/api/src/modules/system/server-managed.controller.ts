/** Typed managed-server controls over the shared application operations. */
import type { Context } from "hono";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { param } from "../../lib/controller-helpers";
import { operationContext, operationData } from "../../lib/operation-context";
const operations = () => getPlatformKernel().servers;

export async function managedInfo(c: Context) {
  c.header("Cache-Control", "private, no-store");
  return c.json(
    await operationData(c, operations().managedInfo(operationContext(c), param(c, "id"))),
  );
}
export async function managedBootLogs(c: Context) {
  c.header("Cache-Control", "private, no-store");
  return c.json(
    await operationData(
      c,
      operations().managedBootLogs(operationContext(c), param(c, "id"), await c.req.json()),
    ),
  );
}
export async function managedSshStatus(c: Context) {
  c.header("Cache-Control", "private, no-store");
  return c.json(
    await operationData(c, operations().managedSshStatus(operationContext(c), param(c, "id"))),
  );
}
export async function setManagedSsh(c: Context) {
  c.header("Cache-Control", "private, no-store");
  return c.json(
    await operationData(
      c,
      operations().setManagedSsh(operationContext(c), param(c, "id"), await c.req.json()),
    ),
  );
}
export async function setManagedSshKey(c: Context) {
  c.header("Cache-Control", "private, no-store");
  return c.json(
    await operationData(
      c,
      operations().setManagedSshKey(operationContext(c), param(c, "id"), await c.req.json()),
    ),
  );
}
export async function setManagedSshPassword(c: Context) {
  c.header("Cache-Control", "private, no-store");
  return c.json(
    await operationData(
      c,
      operations().setManagedSshPassword(operationContext(c), param(c, "id"), await c.req.json()),
    ),
  );
}
export async function managedSshConnection(c: Context) {
  c.header("Cache-Control", "private, no-store");
  return c.json(
    await operationData(
      c,
      operations().managedSshConnection(operationContext(c), param(c, "id"), await c.req.json()),
    ),
  );
}
export async function managedRuntimeStatus(c: Context) {
  c.header("Cache-Control", "private, no-store");
  return c.json(
    await operationData(c, operations().managedRuntimeStatus(operationContext(c), param(c, "id"))),
  );
}
export async function enableManagedRuntime(c: Context) {
  c.header("Cache-Control", "private, no-store");
  return c.json(
    await operationData(
      c,
      operations().enableManagedRuntime(operationContext(c), param(c, "id"), await c.req.json()),
    ),
  );
}
export async function managedRuntimeCredential(c: Context) {
  c.header("Cache-Control", "private, no-store");
  return c.json(
    await operationData(
      c,
      operations().managedRuntimeCredential(
        operationContext(c),
        param(c, "id"),
        await c.req.json(),
      ),
    ),
  );
}
export async function rotateManagedRuntimeCredential(c: Context) {
  c.header("Cache-Control", "private, no-store");
  return c.json(
    await operationData(
      c,
      operations().rotateManagedRuntimeCredential(
        operationContext(c),
        param(c, "id"),
        await c.req.json(),
      ),
    ),
  );
}
export async function managedWorkloads(c: Context) {
  c.header("Cache-Control", "private, no-store");
  return c.json(
    await operationData(c, operations().managedWorkloads(operationContext(c), param(c, "id"))),
  );
}
export async function managedWorkloadLogs(c: Context) {
  c.header("Cache-Control", "private, no-store");
  return c.json(
    await operationData(
      c,
      operations().managedWorkloadLogs(operationContext(c), param(c, "id"), await c.req.json()),
    ),
  );
}
export async function createManagedWorkload(c: Context) {
  c.header("Cache-Control", "private, no-store");
  return c.json(
    await operationData(
      c,
      operations().createManagedWorkload(operationContext(c), param(c, "id"), await c.req.json()),
    ),
  );
}
export async function controlManagedWorkload(c: Context) {
  c.header("Cache-Control", "private, no-store");
  return c.json(
    await operationData(
      c,
      operations().controlManagedWorkload(operationContext(c), param(c, "id"), await c.req.json()),
    ),
  );
}
