/** HTTP adapters for project-owned edge rules. */
import type { Context } from "hono";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { operationContext, operationData } from "../../lib/operation-context";
import { param } from "../../lib/controller-helpers";

const operations = () => getPlatformKernel().projects;
export async function listRouteRules(c: Context) {
  return c.json({ rules: await operationData(c, operations().listRouteRules(operationContext(c), param(c, "id"))) });
}
export async function createRouteRule(c: Context) {
  return c.json({ rule: await operationData(c, operations().createRouteRule(operationContext(c), param(c, "id"), await c.req.json())) }, 201);
}
export async function updateRouteRule(c: Context) {
  return c.json({ rule: await operationData(c, operations().updateRouteRule(operationContext(c), param(c, "id"), {
    ...await c.req.json(), ruleId: param(c, "ruleId"),
  })) });
}
export async function deleteRouteRule(c: Context) {
  return c.json(await operationData(c, operations().removeRouteRule(operationContext(c), param(c, "id"), param(c, "ruleId"))));
}
