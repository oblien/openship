import { freezeContext, type ExecutionContext as RequestContext, type ContextRole as RequestContextRole } from "../../context";

/**
 * Build a RequestContext for BACKGROUND tasks that have no Hono request
 * (webhook deliveries, crons, queue workers, install-callback handlers).
 *
 * Callers MUST already know which user + org they're acting on behalf of —
 * this helper does NOT resolve org from memberships[0] or any other
 * lookup. If you don't know the org, you have a routing bug.
 *
 * The returned ctx has the same shape as a request-built one EXCEPT
 * it carries only application identity and fixed organization scope.
 */
export function buildBackgroundContext(opts: {
  userId: string;
  organizationId: string;
  role?: RequestContextRole;
  membershipId?: string;
  traceId?: string;
  label?: string;   // operator-facing label for traces: "webhook:github", "cron:anniversary"
}): RequestContext {
  return freezeContext({
    userId: opts.userId,
    user: { id: opts.userId, email: "", name: null },
    organizationId: opts.organizationId,
    role: opts.role ?? "owner",
    membershipId: opts.membershipId ?? `bg_${opts.userId}_${opts.organizationId}`,
    sessionId: opts.label ? `bg:${opts.label}` : "background",
    sessionKind: "bearer" as const,
    clientIp: null,
    userAgent: opts.label ? `openship-bg:${opts.label}` : "openship-bg",
    traceId: opts.traceId ?? `bg_${Math.random().toString(36).slice(2)}`,
    source: "system",
    scopeMode: "fixed",
  });
}
