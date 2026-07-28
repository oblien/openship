/**
 * Permission resolver — the SINGLE SOURCE OF TRUTH for access decisions.
 *
 * Design (post-refactor):
 *
 *   1. Resources own their own scope. Every resource has `organization_id`.
 *      Access is decided by: load resource → read its org_id → check the
 *      caller's membership in that org.
 *
 *   2. There is no "active organization" mutating as a side effect of GETs.
 *      The org context for list/create endpoints comes EXPLICITLY from the
 *      request, in this priority order:
 *        1. X-Organization-Id header (set by API clients + dashboard JS)
 *        2. Session's "default org" cookie (UX fallback)
 *        3. (future) API key's bound org
 *
 *   3. The `member(user_id, organization_id, role)` table is THE relation.
 *      Every access decision hinges on a membership lookup against the
 *      resource's org. Resources do NOT carry user_id for access — that's
 *      what audit_event is for.
 *
 *   4. Detail endpoints derive org from the resource. Auto-switch is gone.
 *
 * Resource inheritance for restricted-role grants: domain/deployment/
 * service/env_var → project; backup_run/backup_restore → backup_destination;
 * build_session → project (via deployment).
 *
 * Throws `NotFoundError` (404) on deny — IDOR-safe, never confirms the
 * existence of resources the caller isn't permitted to see.
 */

import type { Context } from "hono";
import { NotFoundError } from "@repo/core";
import { repos } from "@repo/db";
import type { Permission, ResourceType } from "@repo/db";
import { getRequestContext, withScopedOrg, type RequestContext } from "./request-context";
import { grantSourceFor, type GrantSource } from "./grant-source";
import { env } from "../config";
import { resolveOrgCloudUserId } from "./cloud/transport";

/** Grantable resource roots — the types that can be the target of a grant. */
const GRANTABLE_ROOTS: ResourceType[] = [
  "project",
  "server",
  "mail_server",
  "backup_destination",
  "billing",
  "audit",
  // Org-singleton features — listed so the resolver accepts their tags
  // even though restricted-role grants on them are unusual in practice.
  "analytics",
  "github",
  // GitHub access-control grant targets (default-deny, owner-granted):
  // installation-level + single-repo, alongside the org-wide "github".
  "github_installation",
  "github_repository",
  "permissions",
  "settings",
  "job",
  "terminal",
  "cloud",
];

/** Resource types accepted by permission.check — includes leaves. */
export type CheckedResourceType =
  | ResourceType
  | "deployment"
  | "domain"
  | "service"
  | "env_var"
  | "backup_run"
  | "backup_restore"
  | "build_session";

export interface PermissionInput {
  resourceType: CheckedResourceType;
  resourceId: string;
  action: Permission;
  /**
   * Set to `"list"` for endpoints that operate on a COLLECTION (list, create-
   * in-org) rather than a specific resource. The org comes from the request
   * scope (header/cookie) instead of being derived from a resource.
   *
   * For singletons like billing/audit, pass resourceId="*" and omit scope.
   */
  scope?: "list";
  /** Set by the dedicated project-create route so the "own projects" scope can
   *  allow creation without allowing other collection-write routes (ensure/
   *  scan/import) that could touch existing projects. */
  projectCreate?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Resource → org resolution                                          */
/* ------------------------------------------------------------------ */

interface ResolvedResource {
  orgId: string;
  rootType: ResourceType;
  rootId: string;
}

async function loadRootOrgId(
  type: ResourceType,
  id: string,
): Promise<string | null> {
  switch (type) {
    case "project": {
      const p = await repos.project.findById(id);
      return p?.organizationId ?? null;
    }
    case "server": {
      const s = await repos.server.get(id).catch(() => null);
      return s?.organizationId ?? null;
    }
    case "mail_server": {
      // Mail-server rows are keyed by server.id; the org id lives on server.
      const s = await repos.server.get(id).catch(() => null);
      return s?.organizationId ?? null;
    }
    case "backup_destination": {
      const d = await repos.backupDestination.findById(id);
      return d?.organizationId ?? null;
    }
    case "billing":
    case "audit":
      // Org-singletons — the id IS the org id (or "*" for list scope).
      // List scope is handled upstream; here we just accept the org id.
      return id === "*" ? null : id;
    default:
      return null;
  }
}

/**
 * Walk from a (possibly leaf) resource to its grantable root and return
 * the org_id that owns it. Returns null if the resource doesn't exist.
 */
async function resolveResourceOrg(
  resourceType: CheckedResourceType,
  resourceId: string,
): Promise<ResolvedResource | null> {
  if (GRANTABLE_ROOTS.includes(resourceType as ResourceType)) {
    const orgId = await loadRootOrgId(resourceType as ResourceType, resourceId);
    if (!orgId) return null;
    return { orgId, rootType: resourceType as ResourceType, rootId: resourceId };
  }

  switch (resourceType) {
    case "deployment": {
      const dep = await repos.deployment.findById(resourceId);
      if (!dep?.projectId) return null;
      const orgId = await loadRootOrgId("project", dep.projectId);
      return orgId ? { orgId, rootType: "project", rootId: dep.projectId } : null;
    }
    case "domain": {
      const d = await repos.domain.findById(resourceId);
      if (!d?.projectId) return null;
      const orgId = await loadRootOrgId("project", d.projectId);
      return orgId ? { orgId, rootType: "project", rootId: d.projectId } : null;
    }
    case "service": {
      const s = await repos.service.findById(resourceId);
      if (!s?.projectId) return null;
      const orgId = await loadRootOrgId("project", s.projectId);
      return orgId ? { orgId, rootType: "project", rootId: s.projectId } : null;
    }
    case "env_var": {
      // env_var.id → project.id → project.organizationId. Resolves so
      // restricted members with a project write-grant can mutate that
      // project's env vars (matches the header docstring's promise that
      // env_var inherits its grantable root from project).
      const ev = await repos.project.findEnvVarById(resourceId).catch(() => null);
      if (!ev?.projectId) return null;
      const orgId = await loadRootOrgId("project", ev.projectId);
      return orgId ? { orgId, rootType: "project", rootId: ev.projectId } : null;
    }
    case "backup_policy": {
      const policy = await repos.backupPolicy.findById(resourceId).catch(() => null);
      if (!policy?.destinationId) return null;
      const orgId = await loadRootOrgId("backup_destination", policy.destinationId);
      return orgId
        ? { orgId, rootType: "backup_destination", rootId: policy.destinationId }
        : null;
    }
    case "backup_run": {
      const run = await repos.backupRun.findById(resourceId).catch(() => null);
      if (!run?.destinationId) return null;
      const orgId = await loadRootOrgId("backup_destination", run.destinationId);
      return orgId
        ? { orgId, rootType: "backup_destination", rootId: run.destinationId }
        : null;
    }
    case "backup_restore": {
      const r = await repos.backupRestore.findById(resourceId).catch(() => null);
      if (!r?.destinationId) return null;
      const orgId = await loadRootOrgId("backup_destination", r.destinationId);
      return orgId
        ? { orgId, rootType: "backup_destination", rootId: r.destinationId }
        : null;
    }
    case "build_session": {
      const bs = await repos.deployment.findBuildSession(resourceId).catch(() => null);
      if (!bs?.deploymentId) return null;
      const dep = await repos.deployment.findById(bs.deploymentId);
      if (!dep?.projectId) return null;
      const orgId = await loadRootOrgId("project", dep.projectId);
      return orgId ? { orgId, rootType: "project", rootId: dep.projectId } : null;
    }
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Request scope resolution (for list/create endpoints)               */
/* ------------------------------------------------------------------ */

/**
 * Resolve the org context for list/create endpoints. Priority:
 *   1. X-Organization-Id header (explicit, authoritative)
 *   2. session.activeOrganizationId (cookie's stored default — UX fallback)
 *   3. null (caller must specify)
 *
 * Returns the org id or null if nothing is set.
 */
export function resolveRequestScopeOrg(c: Context): string | null {
  const header =
    c.req.header("X-Organization-Id") ?? c.req.header("x-organization-id");
  if (header && header.trim()) return header.trim();

  const sessionOrgId = c.get("activeOrganizationId");
  if (typeof sessionOrgId === "string" && sessionOrgId.trim()) {
    return sessionOrgId;
  }

  return null;
}

/**
 * Project-rooted resource types — the ones that, when absent from the local DB,
 * may be a CLOUD project (canonical on the SaaS) rather than genuinely missing.
 */
export const PROJECT_ROOTED: ReadonlySet<CheckedResourceType> = new Set([
  "project",
  "deployment",
  "domain",
  "service",
  "env_var",
  "build_session",
]);

/**
 * Cloud fallback for the org lookup in `assert`: when a project-rooted resource
 * has no local row, it may live on the SaaS. Return the request-scope org IFF
 * that org has a cloud link to proxy through; otherwise null (→ 404, IDOR-safe).
 *
 * The role check in `checkPermission` then runs against this org: owner/admin/
 * member pass; `restricted` passes only with an explicit per-project grant on
 * the cloud project id (see the cloud fallback in the restricted arm). The SaaS
 * remains the authoritative per-project gate; a bogus id still 404s once proxied.
 */
async function resolveCloudFallbackOrg(
  c: Context,
  resourceType: CheckedResourceType,
): Promise<string | null> {
  if (env.CLOUD_MODE) return null; // the SaaS IS canonical — no upstream to fall back to
  if (!PROJECT_ROOTED.has(resourceType)) return null;
  const scopeOrg = resolveRequestScopeOrg(c);
  if (!scopeOrg) return null;
  const ownerUserId = await resolveOrgCloudUserId(scopeOrg).catch(() => null);
  return ownerUserId ? scopeOrg : null;
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Resource-type policy for the non-restricted roles (owner/admin/member) —
 * pure, no DB. Owner: everything. Admin: all but billing. Member: all but
 * billing/audit. The single source of truth used by both `checkPermission`
 * (per call) and the MCP tool-list filter (per listing), so "can call" and
 * "is listed" can't drift. Restricted is grant-based — handled by the caller.
 */
export function roleAllowsResourceType(
  role: "owner" | "admin" | "member",
  resourceType: CheckedResourceType,
): boolean {
  if (role === "owner") return true;
  if (role === "admin") return resourceType !== "billing";
  return resourceType !== "billing" && resourceType !== "audit";
}

/**
 * Pure resolver — userId + orgId in, boolean out. Used in places where
 * a Hono context isn't available (background jobs, hooks).
 *
 * For resource-detail input, the CALLER is responsible for already having
 * verified that organizationId matches the resource's org. Prefer `assert()`
 * with a context — it does the verification for you.
 */
export async function checkPermission(
  userId: string,
  organizationId: string,
  input: PermissionInput,
  opts?: {
    /** Force a role regardless of membership — scoped tokens pass "restricted". */
    roleOverride?: "owner" | "admin" | "member" | "restricted";
    /** Where to read grants from — the token's grants for a scoped PAT. */
    grants?: GrantSource;
  },
): Promise<boolean> {
  const member = await repos.member.find(organizationId, userId);
  if (!member) return false;

  const role =
    opts?.roleOverride ??
    ((member.role ?? "member") as "owner" | "admin" | "member" | "restricted");

  // Non-restricted roles (owner/admin/member): the resource-type policy lives in
  // `roleAllowsResourceType` so it's the single source shared with the MCP
  // tool-list filter (no drift between "can call" and "is listed").
  if (role !== "restricted") {
    return roleAllowsResourceType(role, input.resourceType);
  }

  // Restricted: only explicit grants.
  const source = opts?.grants ?? repos.resourceGrant;

  // Collection-level project actions (resourceId "*") authorized by a project
  // "*" grant — read directly, since resolveResourceOrg can't resolve "*". This
  // ONLY grants the "create" capability's two abilities; every other "*" action
  // falls through to the existing (deny) behavior below, so no other scope
  // changes. The "create" verb is collection-only: it never satisfies a
  // per-resource read/write/admin check (the switch below + specific-over-
  // wildcard fallback), so a create-only grant can't reach existing projects.
  if (input.resourceType === "project" && input.resourceId === "*") {
    const wildcard = await source.findForResource(organizationId, userId, "project", "*");
    if (wildcard) {
      // CREATE: only on the dedicated create route, only with a create-capable
      // grant. Other collection-write routes (ensure/scan/import) can touch
      // existing projects, so they stay denied for a create-only grant.
      if (
        input.action === "write" &&
        input.projectCreate === true &&
        wildcard.permissions.includes("create")
      ) {
        return true;
      }
      // LIST: a create-capable grant may list; the caller filters results to the
      // grant's concrete (self-created) project ids, so it sees only its own.
      if (input.action === "read" && wildcard.permissions.includes("create")) {
        return true;
      }
    }
  }

  let root = await resolveResourceOrg(input.resourceType, input.resourceId);
  if (!root) {
    // A `project` with no local row is a CLOUD project (canonical on the
    // SaaS). `assert` only reaches here with a resolved `organizationId` when
    // the cloud fallback fired (the org is cloud-linked), so honor a grant
    // keyed by the cloud project id itself. Scoped to the directly-granted
    // `project` type — cloud sub-resources can't be resolved to their parent
    // locally, and are covered by the project-level grant on their routes.
    if (!env.CLOUD_MODE && input.resourceType === "project" && input.resourceId !== "*") {
      root = { orgId: organizationId, rootType: "project", rootId: input.resourceId };
    } else {
      return false;
    }
  }
  const grant = await source.findForResource(
    organizationId,
    userId,
    root.rootType,
    root.rootId,
  );
  if (!grant) return false;

  // Exhaustive switch — adding a new Permission value (delete/list/etc.)
  // without updating this arm fails the build via the `never` check.
  switch (input.action) {
    case "read":
      return grant.permissions.some((p) => p === "read" || p === "write" || p === "admin");
    case "write":
      return grant.permissions.some((p) => p === "write" || p === "admin");
    case "admin":
      return grant.permissions.includes("admin");
    case "create":
      // "create" is a collection-only capability (handled above for "*"); it is
      // never a per-resource action, so it grants nothing on a specific id.
      return false;
    default: {
      const _exhaustive: never = input.action;
      return false;
    }
  }
}

/**
 * Resolve the org an authz check for `input` runs against: the request-scope org
 * for list scope / org-singletons (resourceId "*"), else the resource's OWN org
 * (with the cloud-project fallback — a project with no local row may be a CLOUD
 * project canonical on the SaaS). Shared by `assert` + `checkPermissionOnResource`
 * so use-time and mint-time org resolution can never drift.
 */
async function resolveInputOrg(
  ctx: RequestContext,
  input: PermissionInput,
): Promise<string | null> {
  if (input.scope === "list" || input.resourceId === "*") {
    return resolveRequestScopeOrg(ctx.hono);
  }
  const resource = await resolveResourceOrg(input.resourceType, input.resourceId);
  return resource?.orgId ?? (await resolveCloudFallbackOrg(ctx.hono, input.resourceType));
}

/**
 * A scoped PAT is evaluated as a `restricted` principal whose grants come from
 * the token, so even an owner's scoped token can't exceed the token's grants.
 * Shared by `assert` + `checkPermissionOnResource`.
 */
function permissionOpts(ctx: RequestContext) {
  return ctx.tokenScope
    ? { roleOverride: "restricted" as const, grants: grantSourceFor(ctx) }
    : undefined;
}

/**
 * Like `assert` but returns a boolean and has NO request-scope side effects —
 * it resolves the resource's OWN org (as `assert` does) and checks the caller's
 * access against THAT org, rather than trusting the caller's active org.
 *
 * Token-mint validation MUST use this, not `checkPermission(userId,
 * ctx.organizationId, …)`: the latter resolves the minter's role in their OWN
 * org and (for a non-restricted role) returns `roleAllowsResourceType` WITHOUT
 * verifying the granted resource belongs to that org — so a grant naming another
 * org's resource id would be accepted at mint (privilege escalation, SaaS audit).
 * This makes mint-time acceptance consistent with `assert`'s use-time check.
 */
export async function checkPermissionOnResource(
  ctx: RequestContext,
  input: PermissionInput,
): Promise<boolean> {
  const organizationId = await resolveInputOrg(ctx, input);
  if (!organizationId) return false;
  return checkPermission(ctx.userId, organizationId, input, permissionOpts(ctx));
}

/**
 * Assert version — throws 404 on deny so out-of-permission resources
 * don't leak existence via 403s. The IDOR-safe pattern.
 *
 * Derives org from the resource (detail endpoints) or the request scope
 * (list/create endpoints), then runs the role check.
 *
 * Takes RequestContext (not raw Hono Context) so the caller's intent
 * is explicit in the signature — the function declares it needs an
 * authenticated user + an active org. The Hono escape hatch on ctx
 * (`ctx.hono`) is used for the side effects below.
 *
 * SIDE EFFECTS on success:
 *   - `ctx.hono.set("scopedOrganizationId", orgId)` for legacy readers
 *     of the stash variable (read directly via `c.get`, no helper).
 *   - Rebinds `ctx.hono.var.ctx` to the scoped-org variant so any later
 *     `getRequestContext(c)` in the same request returns
 *     `organizationId === scoped`, not the session-active org.
 *
 * The passed `ctx` local is NOT mutated — it's a value copy. Callers
 * that want the scoped ctx after this returns must re-read it via
 * `getRequestContext(c)`.
 */
export async function assert(ctx: RequestContext, input: PermissionInput): Promise<void> {
  const c = ctx.hono;

  // Resolve the resource's OWN org (list/singleton → request scope) + gate on
  // role. Shared with checkPermissionOnResource so mint-time acceptance and
  // use-time enforcement can't drift. On deny we throw NotFoundError (not 403)
  // so out-of-permission resources don't leak existence — the IDOR-safe pattern.
  const organizationId = await resolveInputOrg(ctx, input);
  if (!organizationId) {
    throw new NotFoundError(input.resourceType, input.resourceId);
  }

  const allowed = await checkPermission(ctx.userId, organizationId, input, permissionOpts(ctx));
  if (!allowed) {
    throw new NotFoundError(input.resourceType, input.resourceId);
  }

  c.set("scopedOrganizationId", organizationId);

  // Rebind ctx.organizationId so service-layer code reading
  // getRequestContext(c).organizationId automatically sees the
  // resource-scoped tenant (not the session's stale active-org). This
  // is the WHOLE point of routing services through ctx: a member of
  // org A acting on a project owned by org B (via a grant or admin
  // role) sees ctx.organizationId === B for the rest of this request.
  if (ctx.organizationId !== organizationId) {
    c.set("ctx" as never, withScopedOrg(ctx, organizationId));
  }
}

export const permission = {
  checkPermission,
  assert,
  resolveRequestScopeOrg,
};
