/**
 * Rate-limit middleware — thin adapter over `lib/rate-limit`.
 *
 * The middleware reads the per-route policy from the spec (set by
 * `secureRouter` from the route declaration), resolves the right
 * subject id (IP / userId / orgId / global), and delegates to
 * `rateLimit()`. The store + algorithm live in `lib/rate-limit`.
 *
 * `rateLimiterFor` binds a per-route policy; `authRouteLimiter` selects the
 * policy for Better Auth's raw routes. `floodGuard` runs before authentication
 * using an independent coarse per-IP bucket on standalone installations.
 *
 * The old in-memory Map + bypass-by-path string match are gone — every
 * route has an explicit policy (default or named) and SaaS multi-
 * instance gets correct aggregate enforcement via Redis.
 */

import type { Context, Next, MiddlewareHandler } from "hono";
import { isLoopbackPeer, peerAddress } from "./loopback-peer";
import { rateLimit, type PolicyId } from "../lib/rate-limit";
import { POLICIES } from "../lib/rate-limit/policies";
import { getRequestContext } from "../lib/request-context";
import { env } from "@repo/platform/engine/config/index";

function resolveSubjectId(c: Context, subject: "ip" | "user" | "org" | "global"): string | null {
  if (subject === "global") return "global";
  if (subject === "ip") {
    const ip = c.var.clientIp;
    if (ip) return ip;
    // Local dev: no proxy header is fine if the connection is loopback.
    const peer = peerAddress(c);
    return peer && isLoopbackPeer(peer) ? peer : null;
  }
  // user / org — read from RequestContext if authed.
  try {
    const ctx = getRequestContext(c);
    return subject === "user" ? ctx.userId : ctx.organizationId;
  } catch {
    // Pre-auth or auth-missing route — fall back to IP. The policy
    // SHOULD use ip for unauthed routes; this fallback is a safety net.
    const ip = c.var.clientIp;
    if (ip) return ip;
    const peer = peerAddress(c);
    return peer && isLoopbackPeer(peer) ? peer : null;
  }
}

async function enforce(c: Context, policyId: PolicyId): Promise<Response | null> {
  // Local dev / on-host: a loopback connection with NO trusted proxy in front
  // is the operator or the dev server itself — exempt it from the ORDINARY
  // limits, or every dev request buckets under 127.0.0.1 and 429s en masse (the
  // dashboard fires many github/home + get-session + health/env calls per
  // render). SaaS sets TRUST_PROXY and limits by the real X-Forwarded-For
  // client, so this can't fire there.
  //
  // CRITICAL: NEVER exempt the auth/login gate. Behind a same-host reverse proxy
  // that forwards over loopback without TRUST_PROXY/OPENSHIP_PUBLIC_URL set (an
  // easy operator misconfig), EVERY internet request arrives as a loopback peer
  // — exempting `auth-tight`/`auth-loose` would silently disable sign-in
  // brute-force throttling. The auth gate always enforces (proxied traffic
  // buckets under one loopback key when no client IP is trustable).
  const isAuthGate = policyId === "auth-tight" || policyId === "auth-loose";
  if (
    !isAuthGate &&
    !env.TRUST_PROXY &&
    !env.OPENSHIP_PUBLIC_URL &&
    isLoopbackPeer(peerAddress(c))
  ) {
    return null;
  }

  const policy = POLICIES[policyId];
  const subjectId = resolveSubjectId(c, policy.subject);
  if (!subjectId) {
    return c.json({ error: "Missing client IP — request must come through the proxy" }, 400);
  }
  const result = await rateLimit({ policy: policyId, subjectId });
  if (!result.allowed) {
    c.header("Retry-After", String(Math.ceil(result.resetMs / 1000)));
    c.header("X-RateLimit-Limit", String(policy.limit));
    c.header("X-RateLimit-Remaining", "0");
    c.header("X-RateLimit-Reset", String(Math.ceil((Date.now() + result.resetMs) / 1000)));
    return c.json({ error: "Too many requests" }, 429);
  }
  c.header("X-RateLimit-Limit", String(policy.limit));
  c.header("X-RateLimit-Remaining", String(result.remaining));
  c.header("X-RateLimit-Reset", String(Math.ceil((Date.now() + result.resetMs) / 1000)));
  return null;
}

/**
 * Bind a Hono middleware to a single named policy. Use for ad-hoc
 * route mounts that bypass `secureRouter` (rare — most routes get
 * their policy via the spec).
 */
export function rateLimiterFor(policyId: PolicyId): MiddlewareHandler {
  return async (c, next) => {
    const rejected = await enforce(c, policyId);
    if (rejected) return rejected;
    // Tell the global default limiter not to apply its own policy on top.
    c.set("rateLimitApplied" as never, true);
    await next();
  };
}

/**
 * Bound pre-auth work before a session lookup. This independent bucket must
 * not mark a route policy as applied or suppress its authoritative limit.
 * Cloud mode and explicit edge trust delegate the coarse ceiling upstream;
 * per-route auth/user limits remain active in both modes.
 */
export async function floodGuard(c: Context, next: Next): Promise<void | Response> {
  if (env.CLOUD_MODE || env.OPENSHIP_TRUST_EDGE || c.req.path.startsWith("/api/health")) {
    await next();
    return;
  }
  const rejected = await enforce(c, "flood-ip");
  if (rejected) return rejected;
  await next();
}

/**
 * The Better Auth tree is a raw Hono catch-all rather than a secureRouter, so
 * its one limiter must choose a policy centrally. POSTs are credential writes;
 * the public invitation preview is also tight because its path contains a
 * bearer claim. Ordinary session/OAuth GETs retain the anonymous read limit.
 */
export function authRouteRateLimitPolicy(method: string, path: string): PolicyId {
  if (method.toUpperCase() === "POST") return "auth-tight";
  if (path.startsWith("/api/auth/invitation-preview/")) return "auth-tight";
  return "default-anon";
}

export const authRouteLimiter: MiddlewareHandler = async (c, next) => {
  const policy = authRouteRateLimitPolicy(c.req.method, c.req.path);
  const rejected = await enforce(c, policy);
  if (rejected) return rejected;
  c.set("rateLimitApplied" as never, true);
  await next();
};

/**
 * Default limiter for raw cloud routes outside secureRouter. If a preceding
 * middleware already applied a route policy, leave that policy authoritative.
 * Otherwise choose the anonymous or authenticated default from the context.
 * This adapter must not be mounted before secureRouter authentication.
 */
export async function rateLimiter(c: Context, next: Next): Promise<void | Response> {
  // Health/bootstrap endpoints are NEVER rate-limited. The dashboard MUST
  // reach GET /health/env to render at all (it refuses to guess deploy/auth
  // mode), and the orchestrator + load balancers poll /health for liveness.
  // Because server-side SSR calls all originate from ONE IP (the dashboard
  // host; loopback in dev), a burst of renders would otherwise drain the
  // per-IP `default-anon` bucket and 429 the health probe — turning a
  // transient spike into a full dashboard outage (429 → getDeploymentInfo →
  // login 500). These endpoints expose only public deploy metadata, so
  // exempting them carries no data risk.
  if (c.req.path.startsWith("/api/health")) {
    await next();
    return;
  }

  // Per-route middleware already enforced its policy — skip the default.
  if (c.get("rateLimitApplied" as never)) {
    await next();
    return;
  }
  // Pick anon vs authed default based on whether ctx is present.
  let policy: PolicyId = "default-anon";
  try {
    getRequestContext(c);
    policy = "default-authed";
  } catch {
    /* no ctx — anon route */
  }
  const rejected = await enforce(c, policy);
  if (rejected) return rejected;
  await next();
}
