/** HTTP envelope for the shared project health view. */
import type { Context } from "hono";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { operationContext, operationData } from "../../lib/operation-context";
import { param } from "../../lib/controller-helpers";

export async function listProjectIncidents(c: Context) {
  return c.json(await operationData(c, getPlatformKernel().projects.getIncidents(operationContext(c), param(c, "id"))));
}
