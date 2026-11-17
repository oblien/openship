import type { Context } from "hono";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { requestApiPublicUrl } from "@repo/platform/engine/lib/public-url";
import { operationContext, applyOperationContext } from "../../../lib/operation-context";
import { readOptionalJsonBody } from "../../../lib/request-body";

export async function createSession(c: Context) {
  const result = await getPlatformKernel().sources.open(operationContext(c), await readOptionalJsonBody(c), { apiBaseUrl: requestApiPublicUrl(c.req.raw) });
  applyOperationContext(c, result.context);
  return c.json({ success: true, ...result.data });
}
export async function uploadRelay(c: Context) {
  const result = await getPlatformKernel().sources.upload(operationContext(c), c.req.param("sessionId")!, c.req.header("x-upload-ticket") ?? c.req.query("ticket") ?? "", c.req.raw.body!);
  applyOperationContext(c, result.context);
  return c.json(result.data);
}
export async function scanSession(c: Context) {
  const sessionId = c.req.param("sessionId")!;
  const result = await getPlatformKernel().sources.scan(operationContext(c), sessionId, await readOptionalJsonBody(c));
  applyOperationContext(c, result.context);
  c.header("Cache-Control", "no-store");
  return c.json({ success: true, sessionId, ...result.data });
}
export async function revealSessionEnv(c: Context) {
  const result = await getPlatformKernel().sources.reveal(operationContext(c), c.req.param("sessionId")!, await c.req.json());
  applyOperationContext(c, result.context);
  return c.json({ success: true, environment: result.data });
}
