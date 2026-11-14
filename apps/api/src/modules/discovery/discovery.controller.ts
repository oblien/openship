import type { Context } from "hono";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { operationContext, operationData } from "../../lib/operation-context";
import { param } from "../../lib/controller-helpers";

/** The discovery operations for the (frozen) platform kernel. */
const operations = () => getPlatformKernel().discovery;

export async function getDiscovery(c: Context) {
  return c.json(await operationData(c, operations().status(operationContext(c), param(c, "id"))));
}

export async function configureDiscovery(c: Context) {
  return c.json(
    await operationData(c, operations().configure(operationContext(c), param(c, "id"), await c.req.json())),
  );
}

export async function rescanDiscovery(c: Context) {
  return c.json(await operationData(c, operations().rescan(operationContext(c), param(c, "id"))));
}

/** The service key arrives URL-encoded in the path (`id:my-app`). */
export async function suppressDiscoveryService(c: Context) {
  return c.json(await operationData(c, operations().suppress(operationContext(c), param(c, "id"), { serviceKey: param(c, "serviceKey") })));
}

export async function unsuppressDiscoveryService(c: Context) {
  return c.json(await operationData(c, operations().unsuppress(operationContext(c), param(c, "id"), { serviceKey: param(c, "serviceKey") })));
}

export async function forgetDiscoveryService(c: Context) {
  return c.json(await operationData(c, operations().forget(operationContext(c), param(c, "id"), { serviceKey: param(c, "serviceKey") })));
}
