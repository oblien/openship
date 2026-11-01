/** HTTP directory browsing; the shared operation enforces native source roots. */
import type { Context } from "hono";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { operationContext, operationData } from "../../lib/operation-context";

export async function browse(c: Context) {
  return c.json(await operationData(c, getPlatformKernel().system.browse(operationContext(c), { path: c.req.query("path") || undefined })));
}
