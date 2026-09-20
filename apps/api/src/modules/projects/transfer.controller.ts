/** HTTP status/envelope adapters for the shared project transfer operations. */
import type { Context } from "hono";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { param } from "../../lib/controller-helpers";
import { operationContext, operationData } from "../../lib/operation-context";

export async function transferToCloud(c: Context) {
  const result = await operationData(c, getPlatformKernel().projects.transferToCloud(operationContext(c), param(c, "id")));
  return c.json(result, !result.ok || result.warning ? 207 : 200);
}

export async function transferToSelfHosted(c: Context) {
  return c.json(await operationData(c, getPlatformKernel().projects.transferToSelfHosted(operationContext(c), param(c, "id"))));
}
