/**
 * Audit emitter wrappers for Better Auth organization-plugin hooks.
 *
 * Better Auth's `organizationHooks` fire OUTSIDE the Hono request cycle —
 * no `c: Context` is available, so we can't pull IP/UA the way controllers
 * do. We still emit the audit row with `organizationId` + `actorUserId`
 * (the user the plugin says triggered the event) for forensic continuity;
 * IP/UA are simply null on these rows.
 *
 * All writes go through `audit.record` (synchronous) — losing a member.*
 * or organization.* row is a real forensic gap, so we accept the latency
 * hit. The emitter itself swallows errors so a failed audit insert never
 * breaks the underlying member/invitation/org mutation.
 */

import { audit, type AuditContext, type AuditEventInput } from "../../lib/audit";

interface HookActor {
  organizationId: string;
  actorUserId?: string | null;
}

function ctx({ organizationId, actorUserId }: HookActor): AuditContext {
  return {
    organizationId,
    actorUserId: actorUserId ?? null,
    ipAddress: null,
    userAgent: null,
  };
}

export const memberAudit = {
  /** Fire-and-await an audit row for an organization/member/invitation event. */
  async emit(actor: HookActor, event: AuditEventInput): Promise<void> {
    await audit.record(ctx(actor), event);
  },
};
