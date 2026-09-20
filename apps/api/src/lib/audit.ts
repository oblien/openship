/**
 * Audit emitter — fire-and-forget for non-critical events, sync for
 * security-sensitive events.
 *
 * Two entry points:
 *   - `audit.record(ctx, event)`       awaited write. Use for security-
 *                                       sensitive events (auth, member,
 *                                       billing) where losing the row
 *                                       is a real forensic gap.
 *   - `audit.recordAsync(ctx, event)`  fire-and-forget. Use for high-
 *                                       volume events (deployments,
 *                                       settings) where adding latency
 *                                       to every action isn't acceptable.
 *
 * Both swallow errors — a failed audit insert never breaks the action
 * the user performed; failures emit a console.error and the caller's
 * request continues.
 */

import type { Context } from "hono";
export { audit, type AuditContext, type AuditEventInput } from "@repo/platform/engine/lib/audit-emitter";
import type { AuditContext } from "@repo/platform/engine/lib/audit-emitter";
import { resolveCallClientId, resolveCallSource, type AuditSource } from "./call-source";

export function auditContextFrom(
  c: Context,
  organizationId: string,
  actorUserId?: string | null,
): AuditContext {
  return {
    organizationId,
    actorUserId: actorUserId ?? null,
    ipAddress: c.var.clientIp,
    userAgent: c.req.header("user-agent") ?? null,
    source: resolveCallSource(c),
    sourceClientId: resolveCallClientId(c),
  };
}
