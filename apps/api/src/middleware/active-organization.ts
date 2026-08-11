/**
 * Active organization resolution.
 *
 * Every authenticated request operates within the user's "active org" —
 * either explicitly set on the session via Better Auth's `setActive` flow,
 * or implicitly resolved to the user's first membership.
 *
 * The active org id is set on Hono context as `activeOrganizationId` and
 * read via `getRequestContext(c).organizationId`. Repos
 * scope `WHERE organization_id = X`.
 *
 * `userId` is still stamped on every resource as the actor/creator —
 * preserved for forensic queries (who deployed, who restored).
 */

import type { Context, Next } from "hono";
import { repos } from "@repo/db";
import { getRequestContext } from "../lib/request-context";

/**
 * Resolve the active organization for an authenticated user — the
 * single source of truth for "what org am I scoped to right now".
 *
 * Resolution order:
 *   1. `session.activeOrganizationId` (set by Better Auth `setActive`)
 *      — validated as still being a membership; falls through on
 *      mismatch (the user may have been removed from that org since
 *      the session was issued).
 *   2. The user's first team org (Cloudflare model: a team org is
 *      where shared work lives; the personal workspace is the
 *      always-there fallback and is empty by default).
 *   3. First membership by creation order (single-org users land on
 *      their personal workspace).
 *   4. Null — caller decides whether to 403 or let the request proceed
 *      (org-free routes like /api/auth/* don't need this).
 *
 * Returns the resolved orgId or null. Does NOT mutate the context;
 * the caller is responsible for `c.set("activeOrganizationId", ...)`.
 */
export async function resolveActiveOrganizationId(
  userId: string,
  sessionOrgId: string | null,
): Promise<string | null> {
  const memberships = await repos.member.listByUser(userId).catch(() => []);
  if (memberships.length === 0) return null;
  const memberOrgIds = new Set(memberships.map((m) => m.organizationId));

  if (sessionOrgId && memberOrgIds.has(sessionOrgId)) {
    return sessionOrgId;
  }

  // TODO: is this clean way ? isnt resolve active org id shouldn't have fallbacks or what
  // Prefer a team org over an empty personal workspace. Batch lookup —
  // every authenticated request hits this resolver, an N+1 per
  // membership would be unacceptable. Sort the team-org candidates
  // deterministically by member.createdAt so the "first team org"
  // pick is stable across nodes (MEDIUM cleanup).
  const orgs = await repos.organization
    .findManyById(Array.from(memberOrgIds))
    .catch(() => []);
  const teamOrgIds = new Set(
    orgs.filter((o) => o?.isTeam === true).map((o) => o!.id),
  );
  if (teamOrgIds.size > 0) {
    const teamMemberships = memberships
      .filter((m) => teamOrgIds.has(m.organizationId))
      .sort((a, b) => {
        const ta =
          a.createdAt instanceof Date
            ? a.createdAt.getTime()
            : new Date(a.createdAt ?? 0).getTime();
        const tb =
          b.createdAt instanceof Date
            ? b.createdAt.getTime()
            : new Date(b.createdAt ?? 0).getTime();
        if (ta !== tb) return ta - tb;
        return a.organizationId.localeCompare(b.organizationId);
      });
    if (teamMemberships.length > 0) return teamMemberships[0].organizationId;
  }

  // not ctx-scoped: middleware boundary. This IS the canonical resolver
  // that BUILDS the per-request active org. The "memberships[0]"
  // fallback is acceptable HERE because no ctx exists yet — it's the
  // source from which ctx.organizationId gets populated. Foreground
  // services downstream must read ctx.organizationId rather than re-
  // running this fallback.
  return memberships[0].organizationId;
}

/**
 * Role-gated middleware factory. Use on admin/owner-only routes:
 *   members.use("/invite", requireRole("admin"));
 *
 * Roles in ascending privilege: member < admin < owner.
 *
 * HIGH F10: by default this reads the session's active org. That's the
 * correct scope for org-singleton routes (settings/billing/audit). For
 * routes that operate on a specific resource (project, deployment,
 * server, …), pair this with `permission.assert()` so the role check
 * runs against the resource's owning org, not whatever the user's
 * active-org pointer happens to be at the moment.
 *
 * Pass `targetOrg: "request"` to derive the target org from the
 * X-Organization-Id header (or session active org fallback) — useful
 * for create flows that don't carry a resource id yet but DO carry the
 * destination org explicitly.
 */
export interface RequireRoleOptions {
  /**
   *   "active"  (default) → use c.get("activeOrganizationId").
   *                         Correct for org-singleton routes.
   *   "request"           → use X-Organization-Id header, falling back
   *                         to session active org. Use on collection/
   *                         create routes that explicitly target an org
   *                         other than the user's default.
   *
   * Resource-scoped routes (e.g. /projects/:id, /servers/:id) MUST
   * derive the target org from the resource via permission.assert() —
   * requireRole does not load resources. The reason: a per-resource
   * routePermission middleware runs BEFORE requireRole in the chain
   * and already stashes the resolved org under "scopedOrganizationId".
   * When that key is present we prefer it (single source of truth).
   */
  targetOrg?: "active" | "request";
}

export function requireRole(
  min: "member" | "admin" | "owner",
  options: RequireRoleOptions = {},
) {
  const RANK = { member: 0, admin: 1, owner: 2 } as const;
  const targetOrg = options.targetOrg ?? "active";

  return async (c: Context, next: Next) => {
    // Middleware boundary: requireRole runs after authMiddleware (which
    // populates ctx), so we read userId from RequestContext. If a route
    // mounts requireRole without authMiddleware first, getRequestContext
    // throws — louder failure than silently returning 401.
    let userId: string;
    try {
      userId = getRequestContext(c).userId;
    } catch {
      return c.json({ error: "Unauthorized" }, 401);
    }

    // Resolution order — single source of truth across the request:
    //   1. permission.assert() stash (resource-scoped, authoritative)
    //   2. X-Organization-Id header when targetOrg=request
    //   3. session active org (default)
    let orgId: string | undefined =
      (c.get("scopedOrganizationId") as string | undefined) || undefined;

    if (!orgId && targetOrg === "request") {
      const headerOrg =
        c.req.header("X-Organization-Id") ?? c.req.header("x-organization-id");
      if (headerOrg && headerOrg.trim()) orgId = headerOrg.trim();
    }

    if (!orgId) {
      orgId = c.get("activeOrganizationId") as string | undefined;
    }

    if (!orgId) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const m = await repos.member.find(orgId, userId);
    if (!m) {
      return c.json({ error: "Not a member of this organization" }, 403);
    }
    const role = (m.role as "member" | "admin" | "owner") ?? "member";
    if (RANK[role] < RANK[min]) {
      return c.json(
        { error: `Requires ${min} role`, code: "INSUFFICIENT_ROLE" },
        403,
      );
    }
    await next();
  };
}
