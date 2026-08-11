import type { Context } from "hono";

export type RequestContextRole = "owner" | "admin" | "member" | "restricted";
export type SessionKind = "cookie" | "bearer" | "zero-auth";

export interface RequestContextUser {
  id: string;
  email: string;
  name: string | null;
}

/**
 * Request-scoped context object. ONE source of truth for who the caller
 * is and what org they're acting in. Built by authMiddleware after the
 * existing identity + activeOrg resolution; rebound by permission.assert
 * when it resolves a different org for the route's resource.
 *
 * Services should accept `(ctx: RequestContext, ...)` instead of taking
 * `userId` and `organizationId` separately. Reading `ctx.organizationId`
 * yields the permission-scoped org for resource-bound routes and the
 * session active-org for org-singleton routes.
 *
 * Do NOT extend this with feature flags, project-id, deployment-id, etc.
 * Resource scoping comes from path params + assertResourceInOrg, not ctx.
 */
export interface RequestContext {
  userId: string;
  user: RequestContextUser;

  // The active org for THIS request. Resolved by authMiddleware via
  // resolveActiveOrganizationId. After permission.assert succeeds for a
  // resource-bound route, this is REPLACED with the scoped org id so
  // services automatically see the right tenant.
  organizationId: string;
  role: RequestContextRole;
  membershipId: string;

  sessionId: string;
  sessionKind: SessionKind;

  /**
   * Present ONLY for a scoped personal access token. When set, the caller is a
   * scoped-token principal: permission checks force `restricted` behavior and
   * source grants from the token (personal_access_token_grant) instead of the
   * user's member grants. Absent for sessions and unscoped tokens.
   */
  tokenScope?: { tokenId: string } | null;

  clientIp: string | null;
  userAgent: string | null;

  traceId: string;

  // Escape hatch for the rare case where a CONTROLLER needs the raw
  // Hono context (streaming responses, raw body access, mid-handler
  // `c.set` for downstream middleware). Services MUST NOT take this —
  // services take `ctx: RequestContext` and read fields off it. Reading
  // typed fields off ctx is always preferred over `c.get("user")` /
  // `c.get("activeOrganizationId")`, which are now reachable only
  // through this escape hatch.
  hono: Context;
}

/**
 * Read the RequestContext from a Hono context. Throws if missing — i.e.
 * the route forgot authMiddleware. This is the SOLE supported reader of
 * `ctx.userId` / `ctx.organizationId` in route handlers; the legacy
 * `getUserId(c)` / `getActiveOrganizationId(c)` helpers were removed in
 * the migration. Services never call this — they take `ctx` as a param.
 */
export function getRequestContext(c: Context): RequestContext {
  const ctx = c.get("ctx" as never) as RequestContext | undefined;
  if (!ctx) {
    throw new Error(
      "No RequestContext in Hono context. authMiddleware must run before any handler that reads ctx.",
    );
  }
  return ctx;
}

/** Internal helper used by middleware to construct ctx from already-
 *  resolved pieces. NOT exported for general use — call sites use
 *  getRequestContext. */
export interface BuildRequestContextInput {
  user: RequestContextUser;
  organizationId: string;
  role: RequestContextRole;
  membershipId: string;
  sessionId: string;
  sessionKind: SessionKind;
  tokenScope?: { tokenId: string } | null;
  clientIp: string | null;
  userAgent: string | null;
  traceId: string;
  hono: Context;
}

export function buildRequestContext(input: BuildRequestContextInput): RequestContext {
  return {
    userId: input.user.id,
    user: input.user,
    organizationId: input.organizationId,
    role: input.role,
    membershipId: input.membershipId,
    sessionId: input.sessionId,
    sessionKind: input.sessionKind,
    tokenScope: input.tokenScope ?? null,
    clientIp: input.clientIp,
    userAgent: input.userAgent,
    traceId: input.traceId,
    hono: input.hono,
  };
}

/** Internal helper used by permission.assert to replace ctx.organizationId
 *  with the scoped org id after permission resolution. */
export function withScopedOrg(ctx: RequestContext, scopedOrganizationId: string): RequestContext {
  if (ctx.organizationId === scopedOrganizationId) return ctx;
  return { ...ctx, organizationId: scopedOrganizationId };
}

/**
 * Build a RequestContext for BACKGROUND tasks that have no Hono request
 * (webhook deliveries, crons, queue workers, install-callback handlers).
 *
 * Callers MUST already know which user + org they're acting on behalf of —
 * this helper does NOT resolve org from memberships[0] or any other
 * lookup. If you don't know the org, you have a routing bug.
 *
 * The returned ctx has the same shape as a request-built one EXCEPT
 * `hono` is a getter that throws — background work has no Hono ctx and
 * any caller reaching for it is doing something wrong.
 */
export function buildBackgroundContext(opts: {
  userId: string;
  organizationId: string;
  role?: RequestContextRole;
  membershipId?: string;
  traceId?: string;
  label?: string;   // operator-facing label for traces: "webhook:github", "cron:anniversary"
}): RequestContext {
  return {
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
    get hono(): Context {
      throw new Error("buildBackgroundContext: background ctx has no Hono request");
    },
  };
}
