/** HTTP adapters; catalog verification and explicit apply consent stay in the engine. */
import type { Context } from "hono";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { param } from "../../lib/controller-helpers";
import { operationContext, operationData } from "../../lib/operation-context";

const operations = () => getPlatformKernel().servers;
export async function listServerModules(c: Context) {
  return c.json(await operationData(c, operations().listModules(operationContext(c), param(c, "id"))));
}
export async function scanServerModules(c: Context) {
  return c.json(await operationData(c, operations().scanModules(operationContext(c), param(c, "id"))));
}
export async function applyServerModuleUpdate(c: Context) {
  return c.json(await operationData(c, operations().applyModule(operationContext(c), param(c, "id"), { module: param(c, "module") })));
}
