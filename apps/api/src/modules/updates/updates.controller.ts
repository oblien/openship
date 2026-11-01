/** HTTP adapters over shared update discovery and deployment operations. */
import type { Context } from "hono";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { operationContext, operationData } from "../../lib/operation-context";
import { param } from "../../lib/controller-helpers";
export async function advisories(c: Context) {
  return c.json({
    data: await operationData(c, getPlatformKernel().updates.advisories(operationContext(c))),
  });
}
export async function security(c: Context) {
  return c.json({
    data: await operationData(
      c,
      getPlatformKernel().updates.security(operationContext(c), param(c, "projectId")),
    ),
  });
}
export async function checkSecurity(c: Context) {
  return c.json({
    data: await operationData(
      c,
      getPlatformKernel().updates.checkSecurity(operationContext(c), param(c, "projectId")),
    ),
  });
}
export async function securityPolicy(c: Context) {
  return c.json({
    data: await operationData(
      c,
      getPlatformKernel().updates.securityPolicy(
        operationContext(c),
        param(c, "projectId"),
        await c.req.json(),
      ),
    ),
  });
}
export async function applySecurity(c: Context) {
  const data = await operationData(
    c,
    getPlatformKernel().updates.applySecurity(
      operationContext(c),
      param(c, "projectId"),
      await c.req.json(),
    ),
  );
  return c.json({ data }, data.awaiting_actions ? 202 : 200);
}
export async function listUpdates(c: Context) {
  const behindOnly = ["1", "true"].includes((c.req.query("behind") ?? "").toLowerCase());
  return c.json({
    data: await operationData(
      c,
      getPlatformKernel().updates.list(operationContext(c), { behindOnly }),
    ),
  });
}
export async function triggerScan(c: Context) {
  return c.json({
    data: await operationData(c, getPlatformKernel().updates.scan(operationContext(c))),
  });
}
export async function applyUpdate(c: Context) {
  return c.json({
    data: await operationData(
      c,
      getPlatformKernel().updates.apply(operationContext(c), param(c, "projectId")),
    ),
  });
}
export async function updateRuntime(c: Context) {
  const data = await operationData(
    c,
    getPlatformKernel().updates.updateRuntime(
      operationContext(c),
      param(c, "projectId"),
      await c.req.json(),
    ),
  );
  return c.json({ data }, data.awaiting_actions ? 202 : 200);
}
export async function checkRuntime(c: Context) {
  return c.json({
    data: await operationData(
      c,
      getPlatformKernel().updates.checkRuntime(
        operationContext(c),
        param(c, "projectId"),
        await c.req.json(),
      ),
    ),
  });
}
