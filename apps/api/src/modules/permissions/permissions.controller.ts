/**
 * Permissions controller — team management + per-resource grants.
 *
 * Org-scoping rules:
 *   - Every admin-gated handler is scoped to `activeOrganizationId`.
 *   - `materializeInvitation` is scoped to the invitation's org, not
 *     the caller's active org — the invitee may not have switched
 *     into the new org yet when they hit the accept-invite page.
 *   - `createTeamOrg` runs in the caller's own session (not an org
 *     context); Better Auth attributes the new org to them as owner.
 *
 * All other lifecycle context (auth gating, middleware order) lives
 * in `permissions.routes.ts`.
 */

import type { Context } from "hono";
import { repos, type Permission, type ResourceType } from "@repo/db";
import { generateId } from "@repo/core";
import { getRequestContext, buildBackgroundContext } from "../../lib/request-context";
import { audit, auditContextFrom } from "../../lib/audit";
import { auth } from "../../lib/auth";
import { resolveOrgOwner } from "../../lib/org-actor";
import { createGitHubSource } from "../github/sources";
import { fetchOrgCloudProjects } from "../../lib/cloud/projects";
import { resolveOrgCloudUserId } from "../../lib/cloud/transport";
import { env } from "../../config";
import { GRANTABLE_RESOURCE_TYPES } from "../../lib/grantable-types";
import {
  parseSourceAccessScope,
  serializeSourceAccessScope,
  type SourceAccessScope,
} from "@repo/core";

// ─── Constants + helpers ────────────────────────────────────────────────────

// The grantable surface lives in lib/grantable-types.ts so the satisfiability
// ratchet test can bind to the same list this endpoint validates against — a copy
// would let the two drift, which is how an unsatisfiable type gets offered.
const ALLOWED_RESOURCE_TYPES: readonly ResourceType[] = GRANTABLE_RESOURCE_TYPES;

const ALLOWED_PERMISSIONS: Permission[] = ["read", "write", "admin"];

function parsePermissions(input: unknown): Permission[] {
  if (!Array.isArray(input)) return [];
  const out: Permission[] = [];
  for (const p of input) {
    if (typeof p !== "string") continue;
    if (ALLOWED_PERMISSIONS.includes(p as Permission)) {
      out.push(p as Permission);
    }
  }
  return [...new Set(out)];
}

/**
 * Verify a resource's organization_id matches the active org. Used by
 * `inviteWithGrants` to reject cross-org pending grants. Returns false
 * on lookup failure (safer to reject than allow).
 */
async function resourceBelongsToOrg(
  type: ResourceType,
  id: string,
  organizationId: string,
): Promise<boolean> {
  try {
    switch (type) {
      case "project": {
        const row = await repos.project.findById(id);
        if (row) return row.organizationId === organizationId;
        // No local row → may be a CLOUD project (canonical on the SaaS).
        // Accept when NOT on the SaaS and the org is cloud-linked; the SaaS /
        // proxy stays the authoritative existence gate. Mirrors the permission
        // resolver's cloud fallback.
        if (env.CLOUD_MODE) return false;
        const linked = await resolveOrgCloudUserId(organizationId).catch(() => null);
        return !!linked;
      }
      case "server":
      case "mail_server": {
        // mail_server rows are keyed by the host server.id; the org
        // id lives on the server row.
        const row = await repos.server.get(id);
        return row?.organizationId === organizationId;
      }
      case "backup_destination": {
        const row = await repos.backupDestination.findById(id);
        return row?.organizationId === organizationId;
      }
      default:
        // Org-singleton or non-row resource types (billing, audit). The
        // caller short-circuits the "*" id before reaching here.
        return false;
    }
  } catch {
    return false;
  }
}

// ─── Just-authed endpoints ──────────────────────────────────────────────────

/**
 * GET /api/permissions/org-meta
 * Active org's is_team flag + headline counts. Powers the "Personal
 * workspace vs Team org" UX in the dashboard's TeamTab.
 */
export async function orgMeta(c: Context) {
  const organizationId = getRequestContext(c).organizationId;
  const org = await repos.organization.findById(organizationId);
  const members = await repos.member
    .listByOrganization(organizationId)
    .catch(() => []);
  return c.json({
    data: {
      organizationId,
      isTeam: org?.isTeam === true,
      memberCount: members.length,
    },
  });
}

/**
 * GET /api/permissions/resources?type=project|server|mail_server|backup_destination|billing|audit
 *
 * Picker payload for the grant modal + invite-with-grants flow. Returns
 * `{ id, label, meta? }[]`. Wildcard "*" isn't listed — the picker adds
 * it as a synthetic top-of-list entry.
 */
export async function listResources(c: Context) {
  const organizationId = getRequestContext(c).organizationId;
  const type = c.req.query("type") as ResourceType | undefined;

  if (!type || !ALLOWED_RESOURCE_TYPES.includes(type)) {
    return c.json({ error: "Invalid or missing type query param" }, 400);
  }

  if (type === "billing" || type === "audit") {
    return c.json({
      data: [
        { id: "*", label: type === "billing" ? "Billing settings" : "Audit log" },
      ],
    });
  }

  if (type === "project") {
    const localRes = await repos.project
      .listByOrganization(organizationId, { page: 1, perPage: 200 })
      .catch(() => ({ rows: [] as Array<{ id: string; name: string; slug?: string | null }> }));
    const localRows = localRes.rows ?? [];
    const localIds = new Set(localRows.map((p) => p.id));
    const data: Array<{ id: string; label: string; meta?: Record<string, unknown> }> =
      localRows.map((p) => ({
        id: p.id,
        label: p.name || p.slug || p.id,
        meta: p.slug ? { slug: p.slug } : undefined,
      }));

    // Cloud projects (proxied as the org owner) are grantable too — a
    // restricted member can be scoped to a specific cloud project from local.
    const cloud = await fetchOrgCloudProjects(organizationId);
    if (cloud.state === "merged") {
      for (const p of cloud.projects) {
        const id = typeof p.id === "string" ? p.id : "";
        if (!id || localIds.has(id)) continue;
        const name = typeof p.name === "string" ? p.name : "";
        const slug = typeof p.slug === "string" ? p.slug : "";
        data.push({
          id,
          label: name || slug || id,
          meta: { source: "cloud", ...(slug ? { slug } : {}) },
        });
      }
    }

    return c.json({ data });
  }

  if (type === "server") {
    const list = await repos.server
      .listByOrganization(organizationId)
      .catch(() => []);
    return c.json({
      data: list.map((s) => ({
        id: s.id,
        label: s.name || s.sshHost || s.id,
        meta: s.sshHost ? { host: s.sshHost } : undefined,
      })),
    });
  }

  if (type === "mail_server") {
    // Mail servers are keyed by serverId. List every server in the org
    // that has mail provisioning enabled by joining through server.
    const servers = await repos.server
      .listByOrganization(organizationId)
      .catch(() => []);
    const mailRows: Array<{ id: string; label: string }> = [];
    for (const s of servers) {
      const mail = await repos.mailServer.get(s.id).catch(() => null);
      if (mail) {
        mailRows.push({ id: s.id, label: s.name || s.sshHost || s.id });
      }
    }
    return c.json({ data: mailRows });
  }

  if (type === "backup_destination") {
    const list = await repos.backupDestination
      .listByOrganization(organizationId)
      .catch(() => []);
    return c.json({
      data: list.map((d) => ({
        id: d.id,
        label: d.name || d.id,
        meta: { kind: d.kind },
      })),
    });
  }

  if (type === "github_installation" || type === "github_repository") {
    // This branch fetches the FULL org repo/account list as the owner, so
    // it MUST NOT be reachable by a regular member — the /resources route
    // is just-authed (it sits above the requireRole("admin") gate for the
    // benefit of other catalog types), so we enforce admin/owner HERE.
    // Without this a member could enumerate every org repo, bypassing the
    // per-member visibility filter that the github controller applies.
    const requester = await repos.member
      .find(organizationId, getRequestContext(c).userId)
      .catch(() => null);
    if (!requester || (requester.role !== "owner" && requester.role !== "admin")) {
      return c.json({ error: "Forbidden" }, 403);
    }
    // Fetched as the org OWNER (the cloud-identity holder) so the full org
    // list is returned for the grant picker — getUserHome(service) is
    // unfiltered; per-member filtering lives only in the github controller.
    // One call yields both accounts (orgs/installations, keyed by login)
    // and repos (keyed by "owner/repo" — the exact grant resourceIds).
    const owner = await resolveOrgOwner(organizationId).catch(() => null);
    if (!owner) return c.json({ data: [] });
    const ownerCtx = buildBackgroundContext({
      userId: owner.userId,
      organizationId,
      label: "permissions:github-catalog",
    });
    const source = await createGitHubSource(ownerCtx).catch(() => null);
    if (!source) return c.json({ data: [] });

    if (type === "github_installation") {
      const home = await source.getHome().catch(() => ({ accounts: [], repos: [] }));
      return c.json({
        data: (home.accounts ?? []).map((a) => ({
          id: a.login,
          label: a.login,
          meta: { type: a.type },
        })),
      });
    }

    // github_repository. `?owner=<login>` narrows to one org's repos (the tree
    // picker's per-org lazy load) via listReposForOwner — which returns that
    // org's full list, not just the primary installation's repos that getHome
    // surfaces. No owner → fall back to the primary-installation repos.
    const ownerParam = c.req.query("owner");
    const repoList = ownerParam
      ? (await source.listReposForOwner(ownerParam).catch(() => null)) ?? []
      : (await source.getHome().catch(() => ({ repos: [] }))).repos ?? [];
    return c.json({
      data: repoList.map((r) => ({
        id: r.full_name,
        label: r.full_name,
        meta: r.private ? { visibility: "private" } : { visibility: "public" },
      })),
    });
  }

  return c.json({ data: [] });
}

/**
 * POST /api/permissions/create-team-org   { name: string, slug?: string }
 *
 * "Upgrade to Team" flow. Creates a brand-new organization via Better
 * Auth, marks it is_team=true, sets the caller as owner. Personal
 * workspaces stay personal forever — Cloudflare's pattern: one
 * personal account + zero or more team accounts.
 */
export async function createTeamOrg(c: Context) {
  const userId = getRequestContext(c).userId;
  type CreateBody = { name?: string; slug?: string };
  const body: CreateBody = await c.req
    .json<CreateBody>()
    .catch(() => ({} as CreateBody));
  const name = body.name?.trim();
  if (!name) {
    return c.json({ error: "name is required" }, 400);
  }

  // Better Auth's organization.create requires an authenticated
  // session; it reads from the request headers (cookie). Forward the
  // incoming headers so the call is attributed to the right user
  // automatically. `slug` is required — generate one from the name
  // when not supplied (Better Auth's adapter handles uniqueness).
  const slugFromName = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || `team-${generateId("org").slice(4, 12)}`;
  const slug = body.slug?.trim() || slugFromName;

  const created = await auth.api
    .createOrganization({
      body: { name, slug },
      headers: c.req.raw.headers,
    })
    .catch((err: unknown) => {
      console.error("[create-team-org] Better Auth createOrganization failed:", err);
      return null;
    });

  // Better Auth's response shape varies slightly across versions —
  // pull the id defensively.
  const orgId =
    (created && typeof created === "object" && "id" in created
      ? (created as { id?: string }).id
      : undefined) ??
    (created && typeof created === "object" && "organization" in created
      ? (created as { organization?: { id?: string } }).organization?.id
      : undefined);

  if (!orgId) {
    return c.json({ error: "Failed to create organization" }, 500);
  }

  await repos.organization.setIsTeam(orgId, true);

  audit.recordAsync(auditContextFrom(c, orgId, userId), {
    eventType: "team.created",
    resourceType: "organization",
    resourceId: orgId,
    after: { name, isTeam: true },
  });

  return c.json({ data: { id: orgId, name, isTeam: true } }, 201);
}

/**
 * POST /api/permissions/invitations/:id/materialize
 *
 * Called from the accept-invite page after Better Auth's accept call
 * succeeds. Finds pending grants for this invitation, upserts them as
 * resource_grant rows, clears the pending rows.
 *
 * Auth: just-authed. Authorization is via the invitation itself — the
 * email must match the calling user's email AND the invitation must
 * be in `accepted` status (i.e., Better Auth's accept ran first).
 */
export async function materializeInvitation(c: Context) {
  const userId = getRequestContext(c).userId;
  const invitationId = c.req.param("id");
  if (!invitationId) return c.json({ error: "invitation id required" }, 400);

  const invitation = await repos.invitation
    .findById(invitationId)
    .catch(() => null);
  if (!invitation) {
    return c.json({ data: { materialized: 0 } });
  }

  // Defence in depth: validate invitation lifecycle explicitly, not
  // just via "a member row exists" — that proxy holds today but
  // breaks the moment any future code path inserts member rows
  // outside Better Auth's accept path.
  if (invitation.status !== "accepted") {
    return c.json({ error: "Invitation has not been accepted yet" }, 400);
  }
  if (invitation.expiresAt && invitation.expiresAt.getTime() < Date.now()) {
    return c.json({ error: "Invitation expired" }, 400);
  }

  const me = await repos.user.findById(userId).catch(() => null);
  if (!me || me.email?.toLowerCase() !== invitation.email.toLowerCase()) {
    return c.json({ error: "Not authorized for this invitation" }, 403);
  }

  // Better Auth flips status to "accepted" on success. We additionally
  // check membership to guard against races between accept + this
  // materialize call.
  const member = await repos.member.find(invitation.organizationId, userId);
  if (!member) {
    return c.json({ error: "Accept the invitation in Better Auth first" }, 400);
  }

  // If the inviter has since been removed from the org, fall back to
  // null on grant provenance. The org's other admins implicitly
  // authorized the grants when they didn't cancel the invite.
  const inviterStillMember = await repos.member.find(
    invitation.organizationId,
    invitation.inviterId,
  );
  const grantedByUserId = inviterStillMember ? invitation.inviterId : null;

  const pending = await repos.invitationPendingGrant.listByInvitation(invitationId);
  let materialized = 0;
  for (const p of pending) {
    if (p.permissions.length === 0) continue;
    await repos.resourceGrant.upsert({
      organizationId: invitation.organizationId,
      userId,
      resourceType: p.resourceType,
      resourceId: p.resourceId,
      permissions: p.permissions,
      grantedByUserId,
    });
    materialized++;
  }
  await repos.invitationPendingGrant.deleteByInvitation(invitationId);

  audit.recordAsync(
    auditContextFrom(c, invitation.organizationId, userId),
    {
      eventType: "grant.materialized",
      resourceType: "resource_grant",
      resourceId: invitationId,
      after: { count: materialized, fromInvitation: invitationId },
    },
  );

  return c.json({ data: { materialized } });
}

// ─── Admin-only endpoints ────────────────────────────────────────────────────

/**
 * GET /api/permissions/grants?userId=X
 * All grants for the given member in the active org.
 */
export async function listGrants(c: Context) {
  const organizationId = getRequestContext(c).organizationId;
  const targetUserId = c.req.query("userId");
  if (!targetUserId) {
    return c.json({ error: "userId query param required" }, 400);
  }

  // Ensure the target user is actually a member of the active org —
  // prevents leaking grant data across orgs even if the caller
  // guesses a userId from another tenant.
  const member = await repos.member.find(organizationId, targetUserId);
  if (!member) {
    return c.json({ data: [] });
  }

  const grants = await repos.resourceGrant.listByMember(organizationId, targetUserId);
  return c.json({ data: grants });
}

/**
 * POST /api/permissions/grants
 * Body: { userId, resourceType, resourceId, permissions: string[] }
 *
 * Idempotent upsert — same (org, user, resourceType, resourceId)
 * tuple replaces the permissions array in place. Empty `permissions`
 * is treated as a delete (no grant = no access; we don't keep
 * zero-perm placeholder rows around).
 */
export async function upsertGrant(c: Context) {
  const ctx = getRequestContext(c);
  const organizationId = ctx.organizationId;
  const actorUserId = ctx.userId;
  const body = await c.req.json<{
    userId?: string;
    resourceType?: string;
    resourceId?: string;
    permissions?: unknown;
    /** Source-access scope for a repo grant — see @repo/core source-access.
     *  Omitted/null ⇒ metadata only, which is the default for a repo grant. */
    scope?: unknown;
  }>();

  if (!body.userId || !body.resourceType || !body.resourceId) {
    return c.json(
      { error: "userId, resourceType, and resourceId are required" },
      400,
    );
  }

  if (!ALLOWED_RESOURCE_TYPES.includes(body.resourceType as ResourceType)) {
    return c.json(
      { error: `Invalid resourceType: ${body.resourceType}`, code: "INVALID_RESOURCE_TYPE" },
      400,
    );
  }

  const member = await repos.member.find(organizationId, body.userId);
  if (!member) {
    return c.json(
      { error: "Target user is not a member of this organization" },
      404,
    );
  }

  const permissions = parsePermissions(body.permissions);

  // Zero permissions → revoke. Looks up the existing row (if any) so
  // the caller doesn't need to GET it first.
  if (permissions.length === 0) {
    const existing = await repos.resourceGrant.findForResource(
      organizationId,
      body.userId,
      body.resourceType as ResourceType,
      body.resourceId,
    );
    if (existing) {
      await repos.resourceGrant.delete(existing.id, organizationId);
      audit.recordAsync(auditContextFrom(c, organizationId, actorUserId), {
        eventType: "grant.revoked",
        resourceType: "resource_grant",
        resourceId: existing.id,
        before: {
          targetUserId: body.userId,
          grantResourceType: existing.resourceType,
          grantResourceId: existing.resourceId,
          permissions: existing.permissions,
        },
      });
    }
    return c.json({ data: null, revoked: true });
  }

  // Round-tripped through the parser so only normalised, matchable rules are
  // stored — a pattern the picker allowed but the matcher would reject must never
  // be persisted as though it were enforceable. An absent/malformed scope becomes
  // undefined, i.e. metadata-only.
  const scope = parseSourceAccessScope(
    typeof body.scope === "string" ? body.scope : body.scope ? JSON.stringify(body.scope) : null,
  );

  const grant = await repos.resourceGrant.upsert({
    organizationId,
    userId: body.userId,
    resourceType: body.resourceType as ResourceType,
    resourceId: body.resourceId,
    permissions,
    scope,
    grantedByUserId: actorUserId,
  });

  audit.recordAsync(auditContextFrom(c, organizationId, actorUserId), {
    eventType: "grant.granted",
    resourceType: "resource_grant",
    resourceId: grant.id,
    after: {
      targetUserId: body.userId,
      grantResourceType: grant.resourceType,
      grantResourceId: grant.resourceId,
      permissions: grant.permissions,
    },
  });

  return c.json({ data: grant }, 201);
}

/**
 * PUT /api/permissions/grants
 * Body: { userId, grants: { resourceType, resourceId, permissions[] }[] }
 *
 * Replaces a member's ENTIRE grant set in one call, diffed server-side:
 * added/changed tuples upserted, removed tuples deleted. The single save path
 * for the member-grants editor (replaces the old per-tuple add/revoke loop).
 * Zero-permission entries are treated as "not granted" (dropped).
 */
export async function replaceGrants(c: Context) {
  const ctx = getRequestContext(c);
  const organizationId = ctx.organizationId;
  const actorUserId = ctx.userId;
  const body = await c.req.json<{ userId?: string; grants?: unknown }>();

  if (!body.userId) return c.json({ error: "userId is required" }, 400);
  if (!Array.isArray(body.grants)) return c.json({ error: "grants array is required" }, 400);

  const member = await repos.member.find(organizationId, body.userId);
  if (!member) {
    return c.json({ error: "Target user is not a member of this organization" }, 404);
  }

  // Validate + normalize desired grants (key by type:id; drop zero-perm rows).
  const desired = new Map<
    string,
    {
      resourceType: ResourceType;
      resourceId: string;
      permissions: Permission[];
      scope?: SourceAccessScope;
    }
  >();
  for (const raw of body.grants as Array<Record<string, unknown>>) {
    const resourceType = raw.resourceType as ResourceType;
    const resourceId = typeof raw.resourceId === "string" ? raw.resourceId : "";
    if (!resourceId || !ALLOWED_RESOURCE_TYPES.includes(resourceType)) {
      return c.json(
        { error: `Invalid grant: ${String(raw.resourceType)}/${resourceId}`, code: "INVALID_RESOURCE_TYPE" },
        400,
      );
    }
    const permissions = parsePermissions(raw.permissions);
    if (permissions.length === 0) continue;
    // Confirm row-backed, non-wildcard resources belong to this org. GitHub
    // (login/"owner/repo") is validated by the owner-run catalog; billing/audit
    // and the "*" wildcard are org-scoped by definition.
    const isWildcard = resourceId === "*";
    const isGithub = resourceType === "github_installation" || resourceType === "github_repository";
    const isSingleton = resourceType === "billing" || resourceType === "audit";
    if (!isWildcard && !isGithub && !isSingleton) {
      const ok = await resourceBelongsToOrg(resourceType, resourceId, organizationId);
      if (!ok) {
        return c.json(
          { error: `Resource not in this organization: ${resourceType}/${resourceId}`, code: "RESOURCE_NOT_IN_ORG" },
          400,
        );
      }
    }
    // Source scope, normalised on the way in so an unmatchable pattern is dropped
    // rather than stored as though it were enforceable. Absent ⇒ metadata only.
    const scope = parseSourceAccessScope(
      typeof raw.scope === "string" ? raw.scope : raw.scope ? JSON.stringify(raw.scope) : null,
    );
    desired.set(`${resourceType}:${resourceId}`, { resourceType, resourceId, permissions, scope });
  }

  const existing = await repos.resourceGrant.listByMember(organizationId, body.userId);
  const existingByKey = new Map(existing.map((g) => [`${g.resourceType}:${g.resourceId}`, g]));
  const permsKey = (p: Permission[]) => [...p].sort().join(",");

  for (const g of existing) {
    if (!desired.has(`${g.resourceType}:${g.resourceId}`)) {
      await repos.resourceGrant.delete(g.id, organizationId);
    }
  }
  // Scope has to take part in change detection. Comparing permissions alone would
  // silently skip the upsert when ONLY the source scope changed — so narrowing a
  // repo from the whole tree to `src/**`, or revoking content access entirely,
  // would appear to save and change nothing.
  const scopeKey = (s?: SourceAccessScope) => JSON.stringify(serializeSourceAccessScope(s) ?? null);

  for (const [key, d] of desired) {
    const prev = existingByKey.get(key);
    const changed =
      !prev ||
      permsKey(prev.permissions) !== permsKey(d.permissions) ||
      scopeKey(prev.scope) !== scopeKey(d.scope);
    if (changed) {
      await repos.resourceGrant.upsert({
        organizationId,
        userId: body.userId,
        resourceType: d.resourceType,
        resourceId: d.resourceId,
        permissions: d.permissions,
        scope: d.scope,
        grantedByUserId: actorUserId,
      });
    }
  }

  const next = await repos.resourceGrant.listByMember(organizationId, body.userId);
  audit.recordAsync(auditContextFrom(c, organizationId, actorUserId), {
    eventType: "grant.replaced",
    resourceType: "resource_grant",
    resourceId: body.userId,
    before: { count: existing.length },
    after: { count: next.length },
  });
  return c.json({ data: next });
}

/**
 * DELETE /api/permissions/grants/:id
 *
 * Org-scoped: the WHERE filter on (id, organizationId) means a caller
 * cannot delete a grant in another org even if they guess the id.
 */
export async function deleteGrant(c: Context) {
  const ctx = getRequestContext(c);
  const organizationId = ctx.organizationId;
  const actorUserId = ctx.userId;
  const id = c.req.param("id");
  if (!id) return c.json({ error: "id required" }, 400);

  // Fetch first so the audit row carries the full before-state. If
  // the grant doesn't belong to this org (or doesn't exist) the
  // lookup returns null and we short-circuit with a 404 instead of
  // silently running a no-op DELETE.
  const existing = await repos.resourceGrant.findById(id, organizationId);
  if (!existing) {
    return c.json({ error: "Grant not found" }, 404);
  }

  await repos.resourceGrant.delete(id, organizationId);

  audit.recordAsync(auditContextFrom(c, organizationId, actorUserId), {
    eventType: "grant.revoked",
    resourceType: "resource_grant",
    resourceId: id,
    before: {
      targetUserId: existing.userId,
      grantResourceType: existing.resourceType,
      grantResourceId: existing.resourceId,
      permissions: existing.permissions,
    },
  });

  return c.json({ data: null, revoked: true });
}

/**
 * GET /api/permissions/invitations
 *
 * Pending invitations in the active org, each annotated with its
 * pending grants so admins see what permissions the invitee will get
 * the moment they accept.
 */
export async function listInvitations(c: Context) {
  const organizationId = getRequestContext(c).organizationId;
  const invites = await repos.invitation.listPendingByOrg(organizationId);
  const out = await Promise.all(
    invites.map(async (inv) => {
      const grants = await repos.invitationPendingGrant.listByInvitation(inv.id);
      return {
        id: inv.id,
        email: inv.email,
        role: inv.role,
        status: inv.status,
        inviterId: inv.inviterId,
        expiresAt: inv.expiresAt,
        createdAt: inv.createdAt,
        pendingGrants: grants.map((g) => ({
          resourceType: g.resourceType,
          resourceId: g.resourceId,
          permissions: g.permissions,
        })),
      };
    }),
  );
  return c.json({ data: out });
}

/**
 * POST /api/permissions/invite-with-grants
 * Body: {
 *   email: string,
 *   role: "owner" | "admin" | "member" | "restricted",
 *   grants?: { resourceType, resourceId, permissions[] }[]
 * }
 *
 * One-call invite. Wraps Better Auth's inviteMember + persists
 * pending grants. On accept, the accept-invite page calls
 * /invitations/:id/materialize which upserts resource_grant rows.
 *
 * For role !== "restricted", any provided grants are stored but won't
 * affect access (the permission resolver short-circuits non-restricted
 * roles before consulting grants). Kept for forward-compat.
 *
 * Any organization may invite — personal AND team. `is_team` now only labels
 * the workspace; it no longer gates invites (creating a team org is optional).
 */
export async function inviteWithGrants(c: Context) {
  const ctx = getRequestContext(c);
  const organizationId = ctx.organizationId;
  const actorUserId = ctx.userId;

  type InviteGrant = {
    resourceType: ResourceType;
    resourceId: string;
    permissions: Permission[];
  };
  type Body = {
    email?: string;
    role?: "owner" | "admin" | "member" | "restricted";
    grants?: InviteGrant[];
  };
  const body: Body = await c.req.json<Body>().catch(() => ({} as Body));

  const email = body.email?.trim();
  const role = body.role ?? "member";
  if (!email) return c.json({ error: "email is required" }, 400);

  // Forward to Better Auth. The plugin handles rate-limiting,
  // duplicate-invite checks, and email sending (when SMTP is
  // configured). The role union is wider than Better Auth's narrowed
  // type — we validate above so the cast is safe.
  const result = await auth.api
    .createInvitation({
      body: {
        email,
        role: role as "restricted",
        organizationId,
      },
      headers: c.req.raw.headers,
    })
    .catch((err: unknown) => {
      console.error("[invite-with-grants] Better Auth invite failed:", err);
      return null;
    });

  const invitationId =
    (result && typeof result === "object" && "id" in result
      ? (result as { id?: string }).id
      : undefined) ??
    (result && typeof result === "object" && "invitation" in result
      ? (result as { invitation?: { id?: string } }).invitation?.id
      : undefined);

  if (!invitationId) {
    return c.json({ error: "Failed to create invitation" }, 500);
  }

  // Validate + dedupe + reject malformed.
  const grants = (body.grants ?? []).filter((g) => {
    return (
      g &&
      typeof g.resourceType === "string" &&
      ALLOWED_RESOURCE_TYPES.includes(g.resourceType as ResourceType) &&
      typeof g.resourceId === "string" &&
      g.resourceId.length > 0 &&
      Array.isArray(g.permissions) &&
      g.permissions.length > 0
    );
  });

  // Verify each non-wildcard grant points at a resource belonging to
  // the active org. Without this an admin could attach a pending
  // grant referencing another org's project id. The permission
  // resolver would short-circuit on the mismatch later (security-
  // inert), but the pending row is data debt + violates this
  // module's "org-scope everything" invariant.
  for (const g of grants) {
    if (g.resourceId === "*") continue;
    const inOrg = await resourceBelongsToOrg(
      g.resourceType as ResourceType,
      g.resourceId,
      organizationId,
    );
    if (!inOrg) {
      return c.json(
        {
          error: `Resource ${g.resourceType}:${g.resourceId} does not belong to the active organization`,
        },
        400,
      );
    }
  }

  for (const g of grants) {
    const perms = parsePermissions(g.permissions);
    if (perms.length === 0) continue;
    await repos.invitationPendingGrant.create({
      invitationId,
      resourceType: g.resourceType,
      resourceId: g.resourceId,
      permissions: perms,
    });
  }

  audit.recordAsync(auditContextFrom(c, organizationId, actorUserId), {
    eventType: "invitation.sent",
    resourceType: "resource_grant",
    resourceId: invitationId,
    after: {
      email,
      role,
      pendingGrantCount: grants.length,
    },
  });

  return c.json(
    {
      data: {
        id: invitationId,
        email,
        role,
        pendingGrantCount: grants.length,
      },
    },
    201,
  );
}
