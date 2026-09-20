/** HTTP adapters over shared managed-container operations. */
import type { Context } from "hono";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { operationContext, operationData } from "../../lib/operation-context";
import { operationEvents } from "../../lib/operation-stream";
import { param } from "../../lib/controller-helpers";
import type { ServerContainerInput } from "@repo/contracts";

const operations = () => getPlatformKernel().servers;
const component = (c: Context) => ({ component: param(c, "component") }) as ServerContainerInput;

export async function listServerContainers(c: Context) {
  return c.json(await operationData(c, operations().listContainers(operationContext(c), param(c, "id"))));
}
export async function listAllContainers(c: Context) {
  return c.json(await operationData(c, operations().listAllContainers(operationContext(c))));
}
export async function scanAllContainers(c: Context) {
  return c.json(await operationData(c, operations().scanAllContainers(operationContext(c))));
}
export async function containersBehind(c: Context) {
  return c.json(await operationData(c, operations().containersBehind(operationContext(c))));
}
export async function containerIssues(c: Context) {
  return c.json(await operationData(c, operations().containerIssues(operationContext(c))));
}
export async function listApplyingContainers(c: Context) {
  return c.json(await operationData(c, operations().applyingContainers(operationContext(c))));
}
export async function applyAllContainers(c: Context) {
  return c.json(await operationData(c, operations().applyAllContainers(operationContext(c), await c.req.json().catch(() => ({})))));
}
export async function scanServerContainers(c: Context) {
  return c.json(await operationData(c, operations().scanContainers(operationContext(c), param(c, "id"))));
}
export async function applyServerContainerStream(c: Context) {
  return operationEvents(c, signal => operations().openContainerApplyStream(operationContext(c), param(c, "id"), {
    ...component(c), intent: c.req.query("intent") === "repair" ? "repair" : "update",
  }, { signal }));
}
export async function getServerContainerApplySession(c: Context) {
  return c.json(await operationData(c, operations().containerApplySession(operationContext(c), param(c, "id"), component(c))));
}
export async function attachServerContainerStream(c: Context) {
  return operationEvents(c, signal => operations().openContainerApplyEvents(operationContext(c), param(c, "id"), component(c), { signal }));
}
