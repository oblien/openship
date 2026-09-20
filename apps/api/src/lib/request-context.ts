import type { Context } from "hono";
import type {
  ContextRole,
  ContextUser,
  CredentialRestrictions,
  ExecutionContext,
  PrincipalKind,
  SessionKind,
} from "@repo/platform";

export type RequestContextRole = ContextRole;
export type RequestContextUser = ContextUser;
export type { SessionKind, PrincipalKind };

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
export interface RequestContext extends ExecutionContext {
  /** HTTP compatibility only. Shared/native operations use ExecutionContext. */
  readonly hono?: Context;
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
  principalKind?: PrincipalKind | null;
  tokenScope?: { tokenId: string } | null;
  credential?: CredentialRestrictions | null;
  scopeMode?: "fixed" | "resource";
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
    principalKind: input.principalKind ?? null,
    tokenScope: input.tokenScope ?? null,
    credential: input.credential ?? null,
    scopeMode: input.scopeMode ?? "resource",
    clientIp: input.clientIp,
    userAgent: input.userAgent,
    traceId: input.traceId,
    hono: input.hono,
  };
}

/** Compatibility helper for internal organization selection. Application
 *  operations use the shared authorizer's resolved context instead. */
export function withScopedOrg(ctx: RequestContext, scopedOrganizationId: string): RequestContext {
  if (ctx.organizationId === scopedOrganizationId) return ctx;
  return { ...ctx, organizationId: scopedOrganizationId };
}

export { buildBackgroundContext } from "@repo/platform/engine/lib/background-context";
