import type { PermissionGrantInput, InviteWithGrantsInput } from "@repo/contracts";
import { assertAccountMutation, assertOrgAdmin, createInvitationWithGrants, materializeForUser, lockOrganization } from "./organization.service";
import { db, schema, eq, and, type DatabaseTransaction } from "@repo/db";
import { createResourceGrantRepo } from "@repo/db/repos";
import { withInvitationLifecycleLock } from "../../lib/invitation-lifecycle-lock";
import { listAuthorizedProjects } from "../../lib/authorized-projects";
import { checkPermissionOnResource } from "../../lib/authorization";
import { canUseGitHubRepo } from "../github/github-access";
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

import { repos, type Permission, type ResourceType } from "@repo/db";
import { AppError, generateId } from "@repo/core";
import type { ExecutionContext } from "../../../context";
import { buildBackgroundContext } from "../../lib/background-context";
import { audit, operationAuditContext } from "../../lib/audit-emitter";
import { auth } from "@repo/platform/engine/lib/auth";
import { resolveOrgOwner } from "@repo/platform/engine/lib/org-actor";
import { createGitHubSource } from "@repo/platform/engine/modules/github/sources/index";
import { fetchOrgCloudProjects } from "@repo/platform/engine/lib/cloud/projects";
import { resolveOrgCloudUserId } from "@repo/platform/engine/lib/cloud/transport";
import { env } from "@repo/platform/engine/config/index";
import { GRANTABLE_RESOURCE_TYPES } from "@repo/core";
import {
  isCloudOnlyGrantType,
  isOrgSingletonResourceType,
  isSelfHostedOnlyGrantType,
  isSensitiveGrantType,
  parseSourceAccessScope,
  serializeSourceAccessScope,
  PLATFORM_GRANT_DESCRIPTIONS,
  RESOURCE_TYPE_LABELS,
  type GrantableResourceType,
  type SourceAccessScope,
} from "@repo/core";

// ─── Constants + helpers ────────────────────────────────────────────────────

// The grantable surface lives in lib/grantable-types.ts so the satisfiability
// ratchet test can bind to the same list this endpoint validates against — a copy
// would let the two drift, which is how an unsatisfiable type gets offered.
const ALLOWED_RESOURCE_TYPES: readonly ResourceType[] = GRANTABLE_RESOURCE_TYPES;

const ALLOWED_PERMISSIONS: Permission[] = ["read", "write", "admin", "create"];

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
  fixedScope = false,
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
        if (env.CLOUD_MODE || fixedScope) return false;
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
export async function orgMeta(ctx: ExecutionContext) {
  const organizationId = ctx.organizationId;
  const org = await repos.organization.findById(organizationId);
  const members = await repos.member
    .listByOrganization(organizationId)
    .catch(() => []);
  return {
      organizationId,
      isTeam: org?.isTeam === true,
      memberCount: members.length,
    };
}

/**
 * GET /api/permissions/resources?type=project|server|mail_server|backup_destination|billing|audit
 *
 * Picker payload for the grant modal + invite-with-grants flow. Returns
 * `{ id, label, meta? }[]`. Wildcard "*" isn't listed — the picker adds
 * it as a synthetic top-of-list entry.
 */
export async function listResources(ctx: ExecutionContext, input: { type: string; owner?: string }) {
  const organizationId = ctx.organizationId;
  const type = input.type as ResourceType;

  if (!type || !ALLOWED_RESOURCE_TYPES.includes(type)) {
    throw responseError({ error: "Invalid or missing type query param" }, 400);
  }

  // A platform feature has no catalog: its only id is "*", so the "row" IS the
  // feature. Generalized off the shared singleton set rather than naming types, so
  // making a new feature grantable needs no edit here.
  if (isOrgSingletonResourceType(type)) {
    // A type whose routes don't exist in this mode would be a tab whose catalog can
    // only ever be empty. Say so honestly instead of offering a dead grant.
    const absentHere = env.CLOUD_MODE
      ? isSelfHostedOnlyGrantType(type)
      : isCloudOnlyGrantType(type);
    if (absentHere) return [];
    return [
        {
          id: "*",
          label: RESOURCE_TYPE_LABELS[type as GrantableResourceType] ?? type,
          meta: {
            feature: true,
            ...(PLATFORM_GRANT_DESCRIPTIONS[type as GrantableResourceType]
              ? { description: PLATFORM_GRANT_DESCRIPTIONS[type as GrantableResourceType] }
              : {}),
            ...(isSensitiveGrantType(type) ? { sensitive: true } : {}),
          },
        },
      ];
  }

  if (type === "project") {
    const localRows = await listAuthorizedProjects(ctx, organizationId);
    const localIds = new Set(localRows.map((p) => p.id));
    const data: Array<{ id: string; label: string; meta?: Record<string, unknown> }> =
      localRows.map((p) => ({
        id: p.id,
        label: p.name || p.slug || p.id,
        meta: p.slug ? { slug: p.slug } : undefined,
      }));

    // Cloud projects (proxied as the org owner) are grantable too — a
    // restricted member can be scoped to a specific cloud project from local.
    const cloud = ctx.scopeMode === "fixed" ? { state: "unavailable" } as const : await fetchOrgCloudProjects(organizationId);
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

    return data;
  }

  if (type === "server") {
    const list = await permittedRows(ctx, "server", await repos.server.listByOrganization(organizationId));
    return list.map((s) => ({
        id: s.id,
        label: s.name || s.sshHost || s.id,
        meta: s.sshHost ? { host: s.sshHost } : undefined,
      }));
  }

  if (type === "mail_server") {
    // Mail servers are keyed by serverId. List every server in the org
    // that has mail provisioning enabled by joining through server.
    const servers = await repos.server
      .listByOrganization(organizationId)
      .catch(() => []);
    const mailRows: Array<{ id: string; label: string }> = [];
    for (const s of await permittedRows(ctx, "mail_server", servers)) {
      const mail = await repos.mailServer.get(s.id).catch(() => null);
      if (mail) {
        mailRows.push({ id: s.id, label: s.name || s.sshHost || s.id });
      }
    }
    return mailRows;
  }

  if (type === "backup_destination") {
    const list = await permittedRows(ctx, "backup_destination", await repos.backupDestination.listByOrganization(organizationId));
    return list.map((d) => ({
        id: d.id,
        label: d.name || d.id,
        meta: { kind: d.kind },
      }));
  }

  if (type === "github_installation" || type === "github_repository") {
    assertOrgAdmin(ctx);
    // This branch fetches the FULL org repo/account list as the owner, so
    // it MUST NOT be reachable by a regular member — the /resources route
    // is just-authed (it sits above the requireRole("admin") gate for the
    // benefit of other catalog types), so we enforce admin/owner HERE.
    // Without this a member could enumerate every org repo, bypassing the
    // per-member visibility filter that the github controller applies.
    const requester = await repos.member
      .find(organizationId, ctx.userId)
      .catch(() => null);
    if (!requester || (requester.role !== "owner" && requester.role !== "admin")) {
      throw responseError({ error: "Forbidden" }, 403);
    }
    // Fetched as the org OWNER (the cloud-identity holder) so the full org
    // list is returned for the grant picker — getUserHome(service) is
    // unfiltered; per-member filtering lives only in the github controller.
    // One call yields both accounts (orgs/installations, keyed by login)
    // and repos (keyed by "owner/repo" — the exact grant resourceIds).
    const owner = await resolveOrgOwner(organizationId).catch(() => null);
    if (!owner) return [];
    const ownerCtx = buildBackgroundContext({
      userId: owner.userId,
      organizationId,
      label: "permissions:github-catalog",
    });
    const source = await createGitHubSource(ownerCtx).catch(() => null);
    if (!source) return [];

    if (type === "github_installation") {
      const home = await source.getHome().catch(() => ({ accounts: [], repos: [] }));
      return (home.accounts ?? []).map((a) => ({
          id: a.login,
          label: a.login,
          meta: { type: a.type },
        }));
    }

    // github_repository. `?owner=<login>` narrows to one org's repos (the tree
    // picker's per-org lazy load) via listReposForOwner — which returns that
    // org's full list, not just the primary installation's repos that getHome
    // surfaces. No owner → fall back to the primary-installation repos.
    const ownerParam = input.owner;
    const repoList = ownerParam
      ? (await source.listReposForOwner(ownerParam).catch(() => null)) ?? []
      : (await source.getHome().catch(() => ({ repos: [] }))).repos ?? [];
    return repoList.map((r) => ({
        id: r.full_name,
        label: r.full_name,
        meta: r.private ? { visibility: "private" } : { visibility: "public" },
      }));
  }

  return [];
}

/**
 * POST /api/permissions/create-team-org   { name: string, slug?: string }
 *
 * "Upgrade to Team" flow. Creates a brand-new organization via Better
 * Auth, marks it is_team=true, sets the caller as owner. Personal
 * workspaces stay personal forever — Cloudflare's pattern: one
 * personal account + zero or more team accounts.
 */
export async function createTeamOrg(ctx: ExecutionContext, body: { name: string; slug?: string }) {
  assertAccountMutation(ctx);
  const userId = ctx.userId;
  const name = body.name?.trim();
  if (!name) {
    throw responseError({ error: "name is required" }, 400);
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
      body: { name, slug, userId, keepCurrentActiveOrganization: true },
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
    throw responseError({ error: "Failed to create organization" }, 500);
  }

  await repos.organization.setIsTeam(orgId, true);

  audit.recordAsync({ ...operationAuditContext(ctx), organizationId: orgId, actorUserId: userId }, {
    eventType: "team.created",
    resourceType: "organization",
    resourceId: orgId,
    after: { name, isTeam: true },
  });

  return { id: orgId, name, isTeam: true };
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
export async function materializeInvitation(ctx: ExecutionContext, invitationId: string) {
  return withInvitationLifecycleLock(invitationId, async () => {
    const invitation = await repos.invitation.findById(invitationId);
    if (!invitation) return { materialized: 0 };
    if (ctx.scopeMode === "fixed" && invitation.organizationId !== ctx.organizationId)
      throw responseError({ error: "Invitation not found" }, 404);
    const materialized = await materializeForUser(invitationId, ctx.userId);
    audit.recordAsync({ ...operationAuditContext(ctx), organizationId: invitation.organizationId }, {
      eventType: "grant.materialized", resourceType: "resource_grant", resourceId: invitationId,
      after: { count: materialized, fromInvitation: invitationId },
    });
    return { materialized };
  });
}

// ─── Admin-only endpoints ────────────────────────────────────────────────────

/**
 * GET /api/permissions/grants?userId=X
 * All grants for the given member in the active org.
 */
export async function listGrants(ctx: ExecutionContext, input: { userId: string }) {
  assertOrgAdmin(ctx);
  const organizationId = ctx.organizationId;
  const targetUserId = input.userId;
  if (!targetUserId) {
    throw responseError({ error: "userId query param required" }, 400);
  }

  // Ensure the target user is actually a member of the active org —
  // prevents leaking grant data across orgs even if the caller
  // guesses a userId from another tenant.
  const member = await repos.member.find(organizationId, targetUserId);
  if (!member) {
    return [];
  }

  const grants = await repos.resourceGrant.listByMember(organizationId, targetUserId);
  return grants;
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
export async function upsertGrant(ctx: ExecutionContext, body: PermissionGrantInput & { userId: string }) {
  assertOrgAdmin(ctx);
  const organizationId = ctx.organizationId;
  const actorUserId = ctx.userId;


  if (!body.userId || !body.resourceType || !body.resourceId) {
    throw responseError({ error: "userId, resourceType, and resourceId are required" }, 400);
  }

  if (!ALLOWED_RESOURCE_TYPES.includes(body.resourceType as ResourceType)) {
    throw responseError({ error: `Invalid resourceType: ${body.resourceType}`, code: "INVALID_RESOURCE_TYPE" }, 400);
  }

  // Same rule as replaceGrants: a feature grant is only reachable at "*".
  if (isOrgSingletonResourceType(body.resourceType) && body.resourceId !== "*") {
    throw responseError({
        error: `${body.resourceType} is granted for the whole organization — use "*" as the resource id`,
        code: "SINGLETON_REQUIRES_WILDCARD",
      }, 400);
  }

  const member = await repos.member.find(organizationId, body.userId);
  if (!member) {
    throw responseError({ error: "Target user is not a member of this organization" }, 404);
  }

  const permissions = parsePermissions(body.permissions);

  // Zero permissions → revoke. Looks up the existing row (if any) so
  // the caller doesn't need to GET it first.
  if (permissions.length === 0) {
    const existing = await db.transaction(async tx => {
      await lockGrantMember(tx, ctx, body.userId);
      const grants = createResourceGrantRepo(tx);
      const row = await grants.findForResource(organizationId, body.userId, body.resourceType as ResourceType, body.resourceId);
      if (!row || row.resourceId !== body.resourceId) return null;
      await grants.delete(row.id, organizationId);
      return row;
    });
    if (existing) {
      audit.recordAsync(operationAuditContext(ctx), {
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
    return null;
  }

  // Round-tripped through the parser so only normalised, matchable rules are
  // stored — a pattern the picker allowed but the matcher would reject must never
  // be persisted as though it were enforceable. An absent/malformed scope becomes
  // undefined, i.e. metadata-only.
  const [normalized] = await normalizeGrants(ctx, [body]);
  const grant = await db.transaction(async tx => {
    await lockGrantMember(tx, ctx, body.userId);
    return createResourceGrantRepo(tx).upsert({
      ...normalized!, organizationId, userId: body.userId,
      resourceType: normalized!.resourceType as ResourceType,
      grantedByUserId: actorUserId,
    });
  });

  audit.recordAsync(operationAuditContext(ctx), {
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

  return grant;
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
export async function replaceGrants(ctx: ExecutionContext, body: { userId: string; grants: PermissionGrantInput[] }) {
  assertOrgAdmin(ctx);
  const organizationId = ctx.organizationId;
  const actorUserId = ctx.userId;

  if (!body.userId) throw responseError({ error: "userId is required" }, 400);
  if (!Array.isArray(body.grants)) throw responseError({ error: "grants array is required" }, 400);

  const member = await repos.member.find(organizationId, body.userId);
  if (!member) {
    throw responseError({ error: "Target user is not a member of this organization" }, 404);
  }

  const normalized = await normalizeGrants(ctx, body.grants);
  const desired = new Map(normalized.map(g => [`${g.resourceType}:${g.resourceId}`, g]));
  const { existing, next } = await db.transaction(async tx => {
    await lockGrantMember(tx, ctx, body.userId);
    const resourceGrants = createResourceGrantRepo(tx);
  const existing = await resourceGrants.listByMember(organizationId, body.userId);
  const existingByKey = new Map(existing.map((g) => [`${g.resourceType}:${g.resourceId}`, g]));
  const permsKey = (p: Permission[]) => [...p].sort().join(",");

  for (const g of existing) {
    if (!desired.has(`${g.resourceType}:${g.resourceId}`)) {
      await resourceGrants.delete(g.id, organizationId);
    }
  }
  // Scope has to take part in change detection. Comparing permissions alone would
  // silently skip the upsert when ONLY the source scope changed — so narrowing a
  // repo from the whole tree to `src/**`, or revoking content access entirely,
  // would appear to save and change nothing.
  const scopeKey = (s?: SourceAccessScope | null) => JSON.stringify(serializeSourceAccessScope(s) ?? null);

  for (const [key, d] of desired) {
    const prev = existingByKey.get(key);
    const changed =
      !prev ||
      permsKey(prev.permissions) !== permsKey(d.permissions) ||
      scopeKey(prev.scope) !== scopeKey(d.scope);
    if (changed) {
      await resourceGrants.upsert({
        organizationId,
        userId: body.userId,
        resourceType: d.resourceType as ResourceType,
        resourceId: d.resourceId,
        permissions: d.permissions,
        scope: d.scope,
        grantedByUserId: actorUserId,
      });
    }
  }

  const next = await resourceGrants.listByMember(organizationId, body.userId);
    return { existing, next };
  });
  audit.recordAsync(operationAuditContext(ctx), {
    eventType: "grant.replaced",
    resourceType: "resource_grant",
    resourceId: body.userId,
    before: { count: existing.length },
    after: { count: next.length },
  });
  return next;
}

/**
 * DELETE /api/permissions/grants/:id
 *
 * Org-scoped: the WHERE filter on (id, organizationId) means a caller
 * cannot delete a grant in another org even if they guess the id.
 */
export async function deleteGrant(ctx: ExecutionContext, id: string) {
  assertOrgAdmin(ctx);
  const organizationId = ctx.organizationId;
  const actorUserId = ctx.userId;
  if (!id) throw responseError({ error: "id required" }, 400);

  // Fetch first so the audit row carries the full before-state. If
  // the grant doesn't belong to this org (or doesn't exist) the
  // lookup returns null and we short-circuit with a 404 instead of
  // silently running a no-op DELETE.
  const existing = await db.transaction(async tx => {
    await lockOrganization(tx, ctx);
    const grants = createResourceGrantRepo(tx);
    const row = await grants.findById(id, organizationId);
    if (!row) throw responseError({ error: "Grant not found" }, 404);
    await grants.delete(id, organizationId);
    return row;
  });

  audit.recordAsync(operationAuditContext(ctx), {
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

  return { revoked: true };
}

/**
 * GET /api/permissions/invitations
 *
 * Pending invitations in the active org, each annotated with its
 * pending grants so admins see what permissions the invitee will get
 * the moment they accept.
 */
export async function listInvitations(ctx: ExecutionContext) {
  assertOrgAdmin(ctx);
  const organizationId = ctx.organizationId;
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
          ...(g.scope ? { scope: g.scope } : {}),
        })),
      };
    }),
  );
  return out;
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
export async function inviteWithGrants(ctx: ExecutionContext, body: InviteWithGrantsInput) {
  assertOrgAdmin(ctx);
  const grants = await normalizeGrants(ctx, body.grants ?? []);
  return createInvitationWithGrants(ctx, { ...body, grants });
}


function responseError(body: { error: string; code?: string }, status: number): AppError {
  return new AppError(body.error, status, body.code ?? (status === 404 ? "NOT_FOUND" : status === 403 ? "FORBIDDEN" : "VALIDATION_ERROR"));
}

async function lockGrantMember(tx: DatabaseTransaction, ctx: ExecutionContext, userId: string) {
  await lockOrganization(tx, ctx);
  const [member] = await tx.select({ id: schema.member.id }).from(schema.member)
    .where(and(eq(schema.member.organizationId, ctx.organizationId), eq(schema.member.userId, userId))).for("update");
  if (!member) throw responseError({ error: "Target user is not a member of this organization" }, 404);
}

/** One grant validator for individual updates, bulk replacement, and invitations. */
export async function normalizeGrants(ctx: ExecutionContext, input: readonly PermissionGrantInput[]): Promise<PermissionGrantInput[]> {
  const desired = new Map<string, PermissionGrantInput>();
  for (const raw of input) {
    const resourceType = raw.resourceType as ResourceType, resourceId = raw.resourceId;
    if (!resourceId || !ALLOWED_RESOURCE_TYPES.includes(resourceType))
      throw responseError({ error: `Invalid grant: ${String(resourceType)}/${resourceId}`, code: "INVALID_RESOURCE_TYPE" }, 400);
    const permissions = parsePermissions(raw.permissions);
    if (!permissions.length) continue;
    if (isOrgSingletonResourceType(resourceType) && resourceId !== "*")
      throw responseError({ error: `${resourceType} is granted for the whole organization — use "*" as the resource id`, code: "SINGLETON_REQUIRES_WILDCARD" }, 400);
    const github = resourceType === "github_installation" || resourceType === "github_repository";
    if (resourceId !== "*" && !github && !isOrgSingletonResourceType(resourceType) &&
        !(await resourceBelongsToOrg(resourceType, resourceId, ctx.organizationId, ctx.scopeMode === "fixed")))
      throw responseError({ error: `Resource not in this organization: ${resourceType}/${resourceId}`, code: "RESOURCE_NOT_IN_ORG" }, 400);
    const action = permissions.includes("admin") ? "admin" : permissions.includes("write") ? "write" : "read";
    const allowed = github
      ? await canUseGitHubRepo(ctx, { owner: resourceId.split("/")[0]!, repo: resourceType === "github_repository" ? resourceId.split("/")[1] ?? null : null }, action === "read" ? "read" : "write", { ownerLevel: "authority" })
      : await checkPermissionOnResource(ctx, { resourceType, resourceId, action });
    if (!allowed) throw responseError({ error: "The requested grant exceeds your access", code: "GRANT_EXCEEDS_ACCESS" }, 403);
    const scope = parseSourceAccessScope(raw.scope ? JSON.stringify(raw.scope) : null);
    desired.set(`${resourceType}:${resourceId}`, { resourceType, resourceId, permissions, ...(scope ? { scope } : {}) });
  }
  return [...desired.values()];
}

async function permittedRows<T extends { id: string }>(ctx: ExecutionContext, resourceType: ResourceType, rows: T[]): Promise<T[]> {
  if (ctx.role !== "restricted" && !ctx.tokenScope) return rows;
  const visible = await Promise.all(rows.map(row => checkPermissionOnResource(ctx, { resourceType, resourceId: row.id, action: "read" })));
  return rows.filter((_row, index) => visible[index]);
}
