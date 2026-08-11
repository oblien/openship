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
import { repos } from "@repo/db";

export interface AuditContext {
  organizationId: string;
  actorUserId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface AuditEventInput {
  eventType: string;
  resourceType?: string | null;
  resourceId?: string | null;
  before?: unknown;
  after?: unknown;
}

export const audit = {
  /** Awaited write. See module header. */
  async record(ctx: AuditContext, event: AuditEventInput): Promise<void> {
    try {
      await repos.auditEvent.create({
        organizationId: ctx.organizationId,
        actorUserId: ctx.actorUserId ?? null,
        eventType: event.eventType,
        resourceType: event.resourceType ?? null,
        resourceId: event.resourceId ?? null,
        before: (event.before ?? null) as never,
        after: (event.after ?? null) as never,
        ipAddress: ctx.ipAddress ?? null,
        userAgent: ctx.userAgent ?? null,
      });
    } catch (err) {
      console.error("[audit] failed to record event", event.eventType, err);
    }
  },

  /** Fire-and-forget. Errors are swallowed by `record`. See module header. */
  recordAsync(ctx: AuditContext, event: AuditEventInput): void {
    void this.record(ctx, event);
  },
};

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
  };
}
