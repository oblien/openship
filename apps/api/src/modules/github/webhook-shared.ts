/**
 * Shared helpers for the GitHub webhook handler family.
 *
 * Leaf module: imports nothing from the dispatcher (github.webhook.ts) or
 * the handler families (webhook-push / webhook-installation /
 * webhook-check-run), so the dispatcher can import the handlers and the
 * handlers can import these helpers without a cycle.
 */

import { buildBackgroundContext } from "@repo/platform/engine/lib/background-context";
import type { ExecutionContext as RequestContext } from "@repo/platform";

/** Background ctx for webhook-triggered work — webhooks have no human
 *  session, so the caller resolves the org OWNER (via resolveOrgOwner)
 *  and passes its userId here for token resolution + audit attribution. */
export function webhookActorCtx(userId: string, organizationId: string, label: string): RequestContext {
  return buildBackgroundContext({ userId, organizationId, label });
}
