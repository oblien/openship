import type { Context, Next } from "hono";
import { randomUUID } from "node:crypto";
import { repos } from "@repo/db";
import { auth } from "../lib/auth";
import { env, trustedOrigins } from "../config/env";
import { ensureLocalUser } from "../lib/local-user";
import { resolveActiveOrganizationId } from "./active-organization";
import { zeroAuthAllowed } from "./zero-auth-guard";
import { hashPatToken } from "../lib/pat";
import { isPatToken, parseBearerToken } from "../lib/bearer";
import {
  buildRequestContext,
  type PrincipalKind,
  type RequestContext,
  type RequestContextRole,
  type SessionKind,
} from "../lib/request-context";

declare module "hono" {
  interface ContextVariableMap {
    ctx: RequestContext;
  }
}

/**
 * Session authentication middleware.
 *
 * Unified flow across every deploy mode:
 *   1. Try the real Better Auth session. If present, stamp the request
 *      and continue.
 *      - DB / machinery errors throw (HIGH F2): we 503 with a code, we
 *        do NOT fall through to zero-auth.
 *      - When the request authenticated via `Authorization: Bearer`
 *        AND its Origin matches a browser-origin trustedOrigin, we
 *        REJECT (HIGH F14). Bearer is for CLI/server-to-server only;
 *        an XSS-exfiltrated session token presented as Bearer from
 *        the dashboard would otherwise defeat httpOnly cookies.
 *   2. No session → consult `getAuthMode()`.
 *   3. authMode !== "none" → 401.
 *   4. authMode === "none" → loopback guardrail (CRITICAL #4):
 *        - Desktop OR `OPENSHIP_ALLOW_ZERO_AUTH=true` is required.
 *        - The request must come from a loopback TCP peer
 *          (kernel-reported, not the Host header). Reverse-proxy
 *          misconfig spoofing Host can no longer escalate to admin.
 *
 * Active-org resolution is delegated to `resolveActiveOrganizationId` —
 * the single source of truth that prefers team orgs over empty personal
 * workspaces (see middleware/active-organization.ts).
 *
 * Supports both cookie-based sessions (dashboard) and Bearer tokens (CLI/API).
 */

function hasBearerHeader(c: Context): boolean {
  const raw = c.req.header("authorization") ?? c.req.header("Authorization");
  return typeof raw === "string" && /^bearer\s+/i.test(raw);
}

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Sentinel: the PAT path fully handled the request (ran next()). */
const PAT_HANDLED = Symbol("pat-handled");

/**
 * Shared bearer prechecks for both the PAT and OAuth-MCP paths: org confinement
 * (a bound token/binding rejects a mismatched X-Organization-Id) and read-only
 * (reject mutations). Returns an error Response to short-circuit, or null to
 * proceed. Messages are caller-supplied so each surface keeps its wording; the
 * codes (TOKEN_ORG_SCOPE / TOKEN_READ_ONLY) are shared.
 */
export function enforceBoundOrgAndReadOnly(
  c: Context,
  opts: {
    boundOrg: string | null;
    readOnly: boolean;
    scoped: boolean;
    orgScopeMessage: string;
    readOnlyMessage: string;
  },
): Response | null {
  // Fail closed on a scoped principal with no bound org. A scoped token's grants
  // are looked up by token id with the (org, user) arguments DISCARDED
  // (grant-source.ts), and wildcard/list-scope checks take their org from
  // X-Organization-Id (permission.ts resolveRequestScopeOrg). With no bound org to
  // pin that header against, the header alone would decide which org the token's
  // capabilities apply in — a trust input we don't want, now that an org-singleton
  // "*" grant actually authorizes something. Membership is still required, so this
  // was never cross-tenant; rejecting keeps the header from selecting the tenant.
  //
  // Unreachable for tokens minted today (mint binds ctx.organizationId, which is
  // non-null), so this guards older rows and any OAuth-MCP binding recorded
  // without one.
  if (opts.scoped && !opts.boundOrg) {
    return c.json(
      {
        error:
          "This access token is scoped but not bound to an organization. Re-create it from an organization context.",
        code: "TOKEN_ORG_UNBOUND",
      },
      403,
    );
  }
  if (opts.boundOrg) {
    const requestedOrg = c.req.header("x-organization-id")?.trim();
    if (requestedOrg && requestedOrg !== opts.boundOrg) {
      return c.json({ error: opts.orgScopeMessage, code: "TOKEN_ORG_SCOPE" }, 403);
    }
  }
  if (opts.readOnly && MUTATION_METHODS.has(c.req.method.toUpperCase())) {
    return c.json({ error: opts.readOnlyMessage, code: "TOKEN_READ_ONLY" }, 403);
  }
  return null;
}

/**
 * Shared tail for both bearer paths: build the RequestContext via the single
 * `applyAuthedRequest` seam, run the handler, and signal the request was fully
 * handled. `patScope` undefined → acts with the user's role; scoped → restricted
 * principal (identical to a scoped PAT).
 */
async function finishBearer(
  c: Context,
  next: Next,
  user: { id: string; email?: string | null; name?: string | null },
  principalId: string,
  boundOrg: string | null,
  patScope: { tokenId: string; scoped: boolean } | undefined,
  principalKind: PrincipalKind,
): Promise<typeof PAT_HANDLED> {
  await applyAuthedRequest(
    c,
    user,
    { id: principalId, activeOrganizationId: boundOrg },
    "bearer",
    patScope,
    principalKind,
  );
  await next();
  return PAT_HANDLED;
}

function originIsBrowserTrusted(c: Context): boolean {
  const origin = c.req.header("origin");
  if (!origin) return false;
  return trustedOrigins.includes(origin);
}

/**
 * A resolved bearer credential — a PAT or an OAuth MCP token — reduced to the
 * identity + scope the permission stack needs. Shared by `tryBearerAuth` (per
 * request) and the MCP route's `tools/list` capability filter, so the
 * token→principal lookup lives in ONE place and can't drift.
 */
export interface ResolvedBearer {
  kind: "pat" | "oauth";
  userId: string;
  /** Org the credential is bound to (null → resolve the user's default). */
  organizationId: string | null;
  scoped: boolean;
  readOnly: boolean;
  /**
   * PAT id / OAuth binding id — the grant key for a scoped principal. For an
   * OAuth token with NO consent binding this is a synthetic
   * `oauth-unbound:<clientId>` key (deny-all: restricted with zero grants).
   */
  tokenId: string;
  /** tokenId is a real personal_access_token row (a PAT, or a bound OAuth client). */
  hasBinding: boolean;
  /** Principal id stamped on the RequestContext (`pat:…` / `oauth:…`). */
  principalId: string;
}

/**
 * Resolve a bearer token to its identity — or null if it isn't a recognized /
 * valid credential (the caller decides 401-vs-fall-through by kind). A PAT
 * resolves via its hashed row; an OAuth MCP token via `getMcpSession` + its
 * consent binding (no binding → deny-all posture). Pure lookup, no side effects.
 */
export async function resolveBearerIdentity(
  token: string,
  headers: Headers,
): Promise<ResolvedBearer | null> {
  if (isPatToken(token)) {
    const pat = await repos.personalAccessToken.findActiveByHash(hashPatToken(token));
    if (!pat) return null;
    return {
      kind: "pat",
      userId: pat.userId,
      organizationId: pat.organizationId,
      scoped: pat.scoped,
      readOnly: pat.readOnly,
      tokenId: pat.id,
      hasBinding: true,
      principalId: `pat:${pat.id}`,
    };
  }

  let session: Awaited<ReturnType<typeof auth.api.getMcpSession>>;
  try {
    session = await auth.api.getMcpSession({ headers });
  } catch {
    return null; // not an OAuth token (or introspection failed)
  }
  if (!session) return null;

  // The client's authorized scope (org + read-only + grants) lives on a binding
  // row keyed by (user, client), written at consent. No binding → the token
  // never passed consent → DENY EVERYTHING (a scoped principal with a grant key
  // that has no rows), rather than fall through to the user's full role.
  const binding = await repos.personalAccessToken.findOAuthBinding(session.userId, session.clientId);
  return {
    kind: "oauth",
    userId: session.userId,
    organizationId: binding?.organizationId ?? null,
    scoped: binding ? binding.scoped : true,
    readOnly: binding?.readOnly ?? false,
    tokenId: binding?.id ?? `oauth-unbound:${session.clientId}`,
    hasBinding: !!binding,
    principalId: `oauth:${session.clientId}`,
  };
}

/**
 * Bearer auth — a PAT (`opsh_pat_…`) or an OAuth MCP access token. Both resolve
 * via `resolveBearerIdentity` and converge on the SAME scoped-principal path
 * (`enforceBoundOrgAndReadOnly` → `finishBearer` → `applyAuthedRequest` → the
 * permission stack). The only edge differences: a browser-origin PAT is
 * rejected while a browser-origin OAuth token falls through to the session
 * path's guard; and an unresolved credential is a 401 for a PAT vs a
 * fall-through for a non-PAT (which may be a cookie-session bearer).
 *
 * Returns null (not a bearer / fall through), an error Response, or PAT_HANDLED
 * after a successful auth + next().
 */
async function tryBearerAuth(c: Context, next: Next): Promise<Response | typeof PAT_HANDLED | null> {
  const token = parseBearerToken(c);
  if (!token) return null; // no Authorization: Bearer → session path
  const isPat = isPatToken(token);

  // Bearer is a CLI/API credential: from a browser-trusted origin a PAT is
  // rejected outright; an OAuth token falls through so the session path's F14
  // guard handles it uniformly.
  if (originIsBrowserTrusted(c)) {
    return isPat
      ? c.json(
          { error: "Access tokens are not allowed from browser origins", code: "BEARER_NOT_ALLOWED_FROM_BROWSER" },
          401,
        )
      : null;
  }

  const resolved = await resolveBearerIdentity(token, c.req.raw.headers);
  if (!resolved) {
    // A PAT that didn't resolve is invalid; a non-PAT that didn't resolve isn't
    // an OAuth MCP token → let the session path try it.
    return isPat
      ? c.json({ error: "Invalid or expired access token", code: "INVALID_TOKEN" }, 401)
      : null;
  }

  const user = await repos.user.findById(resolved.userId);
  if (!user) return c.json({ error: "Invalid or expired access token", code: "INVALID_TOKEN" }, 401);

  const denied = enforceBoundOrgAndReadOnly(c, {
    boundOrg: resolved.organizationId,
    readOnly: resolved.readOnly,
    scoped: resolved.scoped,
    orgScopeMessage:
      resolved.kind === "pat"
        ? "This access token is scoped to a different organization"
        : "This authorization is scoped to a different organization",
    readOnlyMessage:
      resolved.kind === "pat" ? "This access token is read-only" : "This MCP authorization is read-only",
  });
  if (denied) return denied;

  // Usage tracking only for a real token row (skip the synthetic unbound key).
  if (resolved.hasBinding) {
    void repos.personalAccessToken.touchLastUsed(resolved.tokenId).catch(() => {});
  }

  const patScope = resolved.scoped ? { tokenId: resolved.tokenId, scoped: true } : undefined;
  return finishBearer(
    c,
    next,
    user,
    resolved.principalId,
    resolved.organizationId,
    patScope,
    resolved.kind,
  );
}

export async function authMiddleware(c: Context, next: Next) {
  // ── 0. Bearer credential (PAT `opsh_pat_…` or OAuth MCP token) ──────
  // Handled before Better Auth so a bearer is never mis-parsed as a cookie
  // session. Both kinds resolve through one path (resolveBearerIdentity);
  // null → not a valid bearer for us → fall through to the session path.
  const bearerResult = await tryBearerAuth(c, next);
  if (bearerResult !== null) return bearerResult === PAT_HANDLED ? undefined : bearerResult;

  // ── 1. Real session ─────────────────────────────────────────────────
  let session: Awaited<ReturnType<typeof auth.api.getSession>> | null;
  try {
    session = await auth.api.getSession({
      headers: c.req.raw.headers,
    });
  } catch (err) {
    // HIGH F2: a thrown error from getSession (DB outage, decryption
    // failure, etc.) MUST NOT silently fall through to the zero-auth
    // path. Return a 503 with a typed code so callers can distinguish
    // "no session" (cookie missing) from "session machinery broken".
    console.error("[auth] getSession threw:", err);
    return c.json(
      { error: "Authentication service unavailable", code: "AUTH_UNAVAILABLE" },
      503,
    );
  }

  if (session) {
    // HIGH F14: refuse Bearer-from-browser. Bearer is meant for CLI /
    // server-to-server flows. If the request carries a Bearer token AND
    // its Origin is one of our browser-trusted origins, it's almost
    // certainly an XSS-exfiltrated session token being replayed past
    // the httpOnly cookie defence. Block.
    if (hasBearerHeader(c) && originIsBrowserTrusted(c)) {
      return c.json(
        {
          error: "Bearer tokens are not allowed from browser origins",
          code: "BEARER_NOT_ALLOWED_FROM_BROWSER",
        },
        401,
      );
    }

    // Bearer header presence is what distinguishes a CLI/API token from
    // a browser cookie session — both flow through Better Auth's
    // getSession, but only Bearer carries the Authorization header.
    const sessionKind: SessionKind = hasBearerHeader(c) ? "bearer" : "cookie";
    await applyAuthedRequest(
      c,
      session.user,
      session.session as {
        id?: string;
        activeOrganizationId?: string | null;
      },
      sessionKind,
    );
    return next();
  }

  // ── 2+3. No session → the zero-auth synthetic-admin path. Gated by the
  // shared guard (canonical authMode + operator opt-in + loopback peer) so this
  // and the public /upgrade-to-auth bootstrap route can never diverge. See
  // zeroAuthAllowed() for the full rationale (CRITICAL #4).
  const gate = await zeroAuthAllowed(c);
  if (!gate.ok) {
    if (!gate.reason.startsWith("authMode=")) {
      console.warn(`[auth] zero-auth refused: ${gate.reason}`);
    }
    return c.json({ error: "Unauthorized" }, 401);
  }

  const user = await ensureLocalUser();
  c.set("session", { id: "zero-auth", userId: user.id });
  await applyAuthedRequest(c, user, { id: "zero-auth" }, "zero-auth");
  return next();
}

/**
 * Stamp the request with user + session + resolved active org. Shared
 * by every successful auth path so the smart-default org resolution
 * runs in exactly one place.
 *
 * Also constructs the request-scoped RequestContext (single source of
 * truth for user/org/role/session/etc.) and stashes it under `ctx`.
 * The legacy `user`/`session`/`activeOrganizationId` setters stay in
 * place because 296+ call sites still read them through getUserId /
 * getActiveOrganizationId — those helpers are now thin shims that
 * tunnel to ctx, but third-party / older paths still read raw keys.
 */
async function applyAuthedRequest(
  c: Context,
  user: { id: string; email?: string | null; name?: string | null },
  session:
    | { id?: string; activeOrganizationId?: string | null }
    | null,
  sessionKind: SessionKind,
  patScope?: { tokenId: string; scoped: boolean },
  principalKind?: PrincipalKind,
): Promise<void> {
  c.set("user", user);
  if (session && sessionKind !== "zero-auth") c.set("session", session);
  const orgId = await resolveActiveOrganizationId(
    user.id,
    session?.activeOrganizationId ?? null,
  );
  if (orgId) c.set("activeOrganizationId", orgId);

  // Build the RequestContext. If the user has no org membership yet
  // (brand-new signup, mid-provisioning) we skip ctx — downstream
  // handlers that call getRequestContext will get a clear error
  // pointing at the missing org, which is correct behavior: org-bound
  // routes shouldn't have run anyway.
  if (!orgId) return;

  const membership = await repos.member.find(orgId, user.id);
  // Zero-auth's synthetic user is owner of its personal org via
  // provisionUser, so this lookup succeeds there too. If it doesn't,
  // we still skip ctx rather than crash — better-auth-shield and
  // other middlewares will reject the request appropriately.
  if (!membership) return;

  // A scoped PAT acts as a restricted principal whose grants come from the
  // token (permission.assert / github-access read them via tokenScope), so
  // force the role here regardless of the owner's actual membership role.
  const role: RequestContextRole = patScope?.scoped
    ? "restricted"
    : ((membership.role ?? "member") as RequestContextRole);
  const clientIp = (c.get("clientIp") as string | null | undefined) ?? null;
  const userAgent = c.req.header("user-agent")?.trim() || null;

  c.set(
    "ctx",
    buildRequestContext({
      user: {
        id: user.id,
        email: (user as { email?: string | null }).email ?? "",
        name: (user as { name?: string | null }).name ?? null,
      },
      organizationId: orgId,
      role,
      membershipId: membership.id,
      sessionId: session?.id ?? "zero-auth",
      sessionKind,
      principalKind: principalKind ?? null,
      tokenScope: patScope?.scoped ? { tokenId: patScope.tokenId } : null,
      clientIp,
      userAgent,
      traceId: randomUUID(),
      hono: c,
    }),
  );
}
