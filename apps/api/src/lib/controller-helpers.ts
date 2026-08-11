/**
 * Shared controller helpers — small primitives used across Hono handlers.
 *
 * Auth identity lives in RequestContext (see `lib/request-context.ts`).
 * Controllers read it via `getRequestContext(c)`; services take `ctx`
 * (or specific fields) as parameters. No identity shims live here.
 *
 * ─── LINT RULES (controllers + services) ─────────────────────────────────────
 *
 * These patterns are FORBIDDEN in new code — enforced by review:
 *
 *   1. `memberships[0].organizationId` (or any first-membership picking)
 *      OUTSIDE the canonical resolver. The active org is already in
 *      `ctx.organizationId` — reach for that instead. Picking the first
 *      membership is a "wrong tenant" vulnerability waiting to happen.
 *
 *   2. Services / repos taking `(userId: string, organizationId: string)`
 *      positionally. Take `ctx: RequestContext` instead, so the call site
 *      can't swap the two strings and so adding role / sessionKind /
 *      traceId checks later doesn't fan out a signature change to every
 *      caller. Services that need ONLY one id as a DB key may keep the
 *      single positional (see request-context.ts JSDoc for the rule).
 *
 *   3. New helpers taking `c: Context` purely to extract ctx. Take
 *      `ctx: RequestContext` directly — that proves the helper runs
 *      post-auth and lets unit tests skip the Hono harness. Middleware
 *      and route-level wiring are allowed to take `c` (they ARE the
 *      Hono surface); services are not.
 *
 *   4. Local `*BackgroundCtx` / leaf-synth helpers that wrap
 *      `buildBackgroundContext`. There is exactly ONE synth helper —
 *      `buildBackgroundContext` in `lib/request-context.ts`. Call it at
 *      the entry point (webhook handler, cron, install callback) and
 *      pass ctx down; never synthesize at a leaf.
 *
 *   5. Direct `c.get("user")` / `c.get("activeOrganizationId")` reads in
 *      handler code. Use `getRequestContext(c).userId` /
 *      `.organizationId`. Only the canonical builders may read these
 *      raw — see the exception list below.
 *
 *   6. Re-introducing `getUserId(c)` / `getActiveOrganizationId(c)`.
 *      Both shims were removed; `getRequestContext(c)` is the only
 *      reader. Re-adding them is a regression.
 *
 * Allowed exceptions (these layers populate or precede ctx):
 *   - `middleware/auth.ts` — builds the RequestContext (`c.set("ctx", …)`)
 *     from Better Auth's session + the active-org resolver.
 *   - `middleware/active-organization.ts:resolveActiveOrganizationId` —
 *     the canonical memberships → org resolver that feeds authMiddleware.
 *     Its outputs become `ctx.organizationId`; nothing downstream should
 *     re-run this logic. Plus its `requireRole` middleware reads
 *     `c.get("activeOrganizationId")` as a documented fallback distinct
 *     from `ctx.organizationId` (which can be rebound by permission.assert).
 *   - `lib/permission.ts:resolveRequestScopeOrg` — the pre-ctx scope
 *     resolver that reads header + session-active for list/create routes.
 *   - `lib/permission.ts:assert` — mutates ctx via the `ctx.hono` escape
 *     hatch to rebind `c.var.ctx` to the scoped-org variant; takes
 *     `RequestContext` (not `c`).
 *   - `lib/route-permission.ts:requirePermission` — Hono middleware. Reads
 *     route params from `c` directly; uses `getRequestContext(c)` for
 *     identity.
 *   - WebSocket upgrade handlers (`terminal.controller.ts`,
 *     `service-terminal.controller.ts`) — bypass Hono's auth middleware
 *     by design. They re-derive identity via Better Auth's getSession +
 *     `resolveActiveOrganizationId`. Each must comment "not ctx-scoped:
 *     WebSocket upgrade path".
 *   - GitHub webhook + install-callback paths (`github/github.webhook.ts`,
 *     `cloud/cloud-github.service.ts`) — no per-request ctx; resolve
 *     org from the webhook payload, fall back via `memberships[0]?…?? "org_<userId>"`
 *     for unattributable installs (each carries a FOLLOW-UP comment).
 *   - `lib/cloud-session-auth.ts` + cloud Bearer routes
 *     (`cloud-saas.controller.ts`) — read `c.get("user")` / `c.get("session")`
 *     populated by the Bearer middleware, not by authMiddleware. The
 *     SaaS surface doesn't run authMiddleware on Bearer routes.
 *   - `modules/system/setup.controller.ts` (bootstrap path) — runs under
 *     internalAuth pre-onboarding, before any org exists.
 *   - `buildBackgroundContext` itself in `lib/request-context.ts` — the
 *     ONE synth helper. Callers pass userId+orgId explicitly; the helper
 *     never looks them up.
 */

import type { Context } from "hono";
import {
  type PlatformTarget,
  type PlatformConfig,
} from "@repo/adapters";
import { env } from "../config/env";
import { isOblienConfigured } from "./platform-mode";

// Re-export the platform accessor so existing callers that do
// `import { platform } from "@/lib/controller-helpers"` keep working
// without changing every site.
export { getPlatform as platform } from "@repo/adapters";

/**
 * Assert a resource belongs to the caller's active organization. Throws
 * a 404-shaped error if it doesn't, to avoid leaking existence across
 * orgs (404, not 403 — IDOR-safe). NULL `organizationId` fails closed.
 */
import { NotFoundError } from "@repo/core";

export function assertResourceInOrg<T extends { organizationId?: string | null }>(
  resource: T | null | undefined,
  resourceLabel: string,
  organizationId: string,
  resourceId?: string,
): asserts resource is T {
  if (!resource || resource.organizationId !== organizationId) {
    throw new NotFoundError(resourceLabel, resourceId);
  }
}

/** Extract and validate a required route parameter */
export function param(c: Context, name: string): string {
  const val = c.req.param(name);
  if (!val) throw new Error(`Missing route param: ${name}`);
  return val;
}

/**
 * Returns true when the server row exists AND belongs to the caller's
 * active organization. Mail / branding / admin controllers use this to
 * short-circuit with 404 for cross-tenant access attempts BEFORE making
 * SSH or HTTP calls against the server.
 *
 * NotFoundError-shaped 404 (not 403) is correct here — exposing
 * "exists but not yours" is itself a cross-tenant existence leak.
 */
import type { RequestContext } from "./request-context";
import { repos } from "@repo/db";

export async function isServerInOrg(
  ctx: RequestContext,
  serverId: string,
): Promise<boolean> {
  const server = await repos.server.getInOrganization(serverId, ctx.organizationId);
  return server != null;
}

/**
 * Local-only route guard. Returns a 404 Response when CLOUD_MODE is on,
 * or `null` when the route may proceed.
 *
 * Use at the top of self-hosted-only handlers:
 *
 *   export async function handler(c: Context) {
 *     const guard = assertNotCloud(c);
 *     if (guard) return guard;
 *     // ... cloud-impossible work ...
 *   }
 *
 * This is defense-in-depth on top of routing-level gates — even if a
 * route ever gets mounted in cloud mode by mistake, the handler refuses
 * to execute the cloud-impossible code path.
 */
export function assertNotCloud(c: Context): Response | null {
  if (env.CLOUD_MODE) {
    return c.json({ error: "Not available in cloud mode" }, 404);
  }
  return null;
}

/**
 * Desktop-only route guard. Returns a 404 Response unless the platform target
 * resolves to "desktop", or `null` when the route may proceed.
 *
 * Pairs with `localOnly` for desktop-exclusive features (e.g. SSH port-forward
 * tunnels): `localOnly` keeps them out of SaaS, this also keeps them out of a
 * self-hosted VPS — where forwarding a remote port to "localhost" is
 * meaningless. Defense-in-depth on top of routing-level gates.
 */
export function assertDesktop(c: Context): Response | null {
  if (resolvePlatformConfig().target !== "desktop") {
    return c.json({ error: "Not available in this mode" }, 404);
  }
  return null;
}

// ─── Platform resolution ─────────────────────────────────────────────────────

/**
 * Resolve the deployment target from environment config.
 *
 * CLOUD_MODE (SaaS hosting) and DEPLOY_MODE=cloud (Oblien runtime) both
 * need the cloud platform adapter, so either triggers the cloud config.
 * Auth/billing concerns are gated separately by CLOUD_MODE alone.
 *
 * Priority:
 *   1. CLOUD_MODE=true or DEPLOY_MODE=cloud → "cloud" (Oblien runtime)
 *   2. DEPLOY_MODE=desktop → "desktop"
 *   3. Default → "selfhosted" with docker or bare runtime
 */
export function resolvePlatformConfig(): PlatformConfig {
  if (isOblienConfigured()) {
    return {
      target: "cloud",
      cloudClientId: env.OBLIEN_CLIENT_ID,
      cloudClientSecret: env.OBLIEN_CLIENT_SECRET,
    };
  }

  if (env.DEPLOY_MODE === "desktop") {
    return { target: "desktop" };
  }

  // Self-hosted: docker or bare
  return {
    target: "selfhosted",
    runtime: env.DEPLOY_MODE === "bare" ? "bare" : "docker",
  };
}

// ─── Project access ──────────────────────────────────────────────────────────


// Access-control model:
//   - Route-level `requirePermission` middleware loads the resource and
//     verifies org membership before the controller runs.
//   - For list/create endpoints, the org is resolved from the
//     X-Organization-Id header (or the session default cookie).
//   - Service layers receive `organizationId` directly from controllers
//     and use `assertResourceInOrg(...)` for defense-in-depth.
//
// For a user-scoped access check, use `permission.assert(getRequestContext(c), {...})` or
// `assertResourceInOrg(resource, ...)`.
//
// Note: permission.assert takes RequestContext (not raw c) because it
// declares its identity needs in its signature. The Hono escape hatch
// (ctx.hono) is used internally for the side effects (rebind ctx,
// stash scopedOrganizationId).
