import { buildBackgroundContext } from "@repo/platform/engine/lib/background-context";
import type { ExecutionContext as RequestContext } from "@repo/platform";

/** Background ctx for webhook-triggered work — webhooks have no human
 *  session, so the caller resolves the org OWNER (via resolveOrgOwner)
 *  and passes its userId here for token resolution + audit attribution. */
export function webhookActorCtx(userId: string, organizationId: string, label: string): RequestContext {
  return buildBackgroundContext({ userId, organizationId, label });
}
