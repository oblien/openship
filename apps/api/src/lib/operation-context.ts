import type { Context } from "hono";
import { freezeContext, type ExecutionContext, type OperationResult } from "@repo/platform";
import { getRequestContext } from "./request-context";
import { resolveCallSource, resolveCallClientId } from "./call-source";

export function operationContext(c: Context): ExecutionContext {
  return freezeContext({ ...freezeContext(getRequestContext(c)), source: resolveCallSource(c), sourceClientId: resolveCallClientId(c) });
}

export function applyOperationContext(c: Context, context: ExecutionContext): void {
  c.set("scopedOrganizationId", context.organizationId);
  c.set("ctx", { ...context, hono: c });
  c.set("operationAuditRecorded", true);
  c.set("operationContextApplied", true);
}

export async function operationData<T>(c: Context, work: Promise<OperationResult<T>>): Promise<T> {
  const { context, data } = await work;
  applyOperationContext(c, context);
  return data;
}
