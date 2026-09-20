import { repos } from "@repo/db";
import type { ExecutionContext } from "@repo/platform";
type AuditSource = NonNullable<ExecutionContext["source"]>;
const pending = new Set<Promise<void>>();

export async function flushAudit(): Promise<void> {
  while (pending.size) await Promise.all([...pending]);
}

export interface AuditContext {
  organizationId: string;
  actorUserId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  /** Where the action came in from. Filled by `auditContextFrom`. */
  source?: AuditSource | null;
  /** Which client of that surface — `oauth:<clientId>` / `pat:<tokenId>`. Only
   *  MCP dispatch sets it; see call-source.ts. */
  sourceClientId?: string | null;
}

/** Actor attribution for every transport over a shared application operation. */
export function operationAuditContext(ctx: ExecutionContext): AuditContext {
  return {
    organizationId: ctx.organizationId, actorUserId: ctx.userId,
    ipAddress: ctx.clientIp, userAgent: ctx.userAgent,
    source: ctx.source ?? "api", sourceClientId: ctx.sourceClientId,
  };
}

export interface AuditEventInput {
  eventType: string;
  resourceType?: string | null;
  resourceId?: string | null;
  before?: unknown;
  after?: unknown;
  /** Overrides the context's source. For emitters with no request to read
   *  (crons, Better Auth hooks, webhook deliveries). */
  source?: AuditSource | null;
  /** Overrides the context's client id. For the MCP endpoint itself, which knows
   *  the calling client before any sub-request has carried the signed header. */
  sourceClientId?: string | null;
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
        source: event.source ?? ctx.source ?? null,
        sourceClientId: event.sourceClientId ?? ctx.sourceClientId ?? null,
      });
    } catch (err) {
      console.error("[audit] failed to record event", event.eventType, err);
    }
  },

  /** Fire-and-forget. Errors are swallowed by `record`. See module header. */
  recordAsync(ctx: AuditContext, event: AuditEventInput): void {
    const write = this.record(ctx, event);
    pending.add(write);
    void write.finally(() => pending.delete(write));
  },
};
