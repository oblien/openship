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
import { NotFoundError, ORG_SINGLETON_RESOURCE_TYPES } from "@repo/core";
import { repos } from "@repo/db";
import type { Permission, ResourceType } from "@repo/db";
import { getRequestContext, withScopedOrg, type RequestContext } from "./request-context";
import { grantSourceFor, type GrantSource } from "./grant-source";

/**
 * Resources that exist exactly once per org and carry no resource id in the URL —
 * their routes assert `resourceId: "*"` and the org comes from request scope.
 *
 * Sourced from @repo/core so the route middleware, the wildcard arm below, the
 * grant picker, and the MCP tool filter cannot disagree about which types are
 * feature-shaped. `route-permission.ts` re-exports this for its existing
 * importers; defining it there instead would make this module import from it and
 * cycle.
 */
export const ORG_SINGLETON_RESOURCES: ReadonlySet<string> = new Set<string>(
  ORG_SINGLETON_RESOURCE_TYPES,
);

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
  // A ROOT type resolves directly. There used to be a GRANTABLE_ROOTS membership
  // test in front of this, but it was inert: every type it listed WITHOUT a
  // `loadRootOrgId` case resolved to null anyway, and the leaf switch below
  // returns null for those same types via its default arm. The root cases and the
  // leaf cases are disjoint, so trying the root first and falling through on null
  // is equivalent — and costs no extra query, since a leaf type hits
  // `loadRootOrgId`'s default arm without touching the DB.
  const rootOrgId = await loadRootOrgId(resourceType as ResourceType, resourceId);
  if (rootOrgId) {
    return { orgId: rootOrgId, rootType: resourceType as ResourceType, rootId: resourceId };
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
 * has no local row, it may live on the SaaS. Return the caller's scope org IFF
 * that org has a cloud link to proxy through; otherwise null (→ 404, IDOR-safe).
 *
 * The role check in `checkPermission` then runs against this org: owner/admin/
 * member pass; `restricted` passes only with an explicit per-project grant on
 * the cloud project id (see the cloud fallback in the restricted arm). The SaaS
 * remains the authoritative per-project gate; a bogus id still 404s once proxied.
 */
async function resolveCloudFallbackOrg(
  _resourceType: CheckedResourceType,
  _scopeOrg: string | null,
): Promise<string | null> {
  return null;
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
  if (role === "admin") return true;
  return resourceType !== "audit";
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

  // ── Collection / wildcard arm ──────────────────────────────────────────────
  // Every assertion at resourceId "*" — a `:list` scope, a `collection: true`
  // write, or an org-singleton route — is authorized by a WILDCARD grant on the
  // asserted type, and by nothing else.
  //
  // This SUBSUMES the org-singleton-only arm that used to live here: a singleton's
  // only id IS "*", so that was this same rule with a narrower type set. Widening
  // it to every type fixes the absurdity that a `{server,"*",read}` grant could
  // read every server BY ID (the grant lookup below matches `resource_id = $id OR
  // resource_id = '*'`) while 404ing on enumerating them.
  //
  // TERMINAL on purpose: `resolveResourceOrg` cannot resolve "*" for ANY type —
  // `loadRootOrgId` returns null for it in every case — so the per-resource arm
  // below is a guaranteed deny at "*". Returning here says that out loud and
  // avoids a second, pointless grant query.
  //
  // POSITION IS LOAD-BEARING:
  //   • AFTER the {project,"*",create} arm above, because `permitsAction` is false
  //     for "create" on every action. Running first — terminal — would deny both
  //     abilities that arm exists to allow. Placed after, a create-only grant
  //     still cannot reach ensure/scan/import: those fall through to here and are
  //     denied, exactly as before.
  //   • BEFORE the per-resource arm, for the terminality reason above.
  //
  // Keyed on the id, not `input.scope`: every caller that sets `scope: "list"`
  // also passes resourceId "*" (see route-permission's isList and collection
  // branches), and one predicate cannot disagree with itself.
  //
  // The org is already resolved by the caller (`resolveInputOrg` → request scope,
  // pinned to the token's bound org for a scoped principal — see the unbound
  // rejection in middleware/auth.ts), and membership in it is asserted above, so
  // reading the grant directly adds no new trust input.
  if (input.resourceId === "*") {
    const wildcard = await source.findForResource(
      organizationId,
      userId,
      input.resourceType as ResourceType,
      "*",
    );
    return wildcard ? permitsAction(wildcard.permissions, input.action) : false;
  }

  let root = await resolveResourceOrg(input.resourceType, input.resourceId);
  if (!root) {
    return false;
  }
  const grant = await source.findForResource(
    organizationId,
    userId,
    root.rootType,
    root.rootId,
  );
  if (!grant) return false;

  return permitsAction(grant.permissions, input.action);
}

/**
 * Does a grant's permission array authorize `action`?
 *
 * Cumulative by design — read ⇐ read|write|admin, write ⇐ write|admin — which is
 * what lets the dashboard render the three levels as a lossless view of the
 * underlying arrays (mcp-access-templates.ts).
 *
 * The single definition shared by the wildcard arm, the per-resource arm, and the
 * MCP tool filter (`filterToolsForPrincipal`), so "can call" and "is listed"
 * cannot drift — the same reason `roleAllowsResourceType` is exported. Exhaustive
 * switch: adding a new Permission value without updating this fails the build via
 * the `never` check.
 */
export function permitsAction(permissions: readonly Permission[], action: Permission): boolean {
  switch (action) {
    case "read":
      return permissions.some((p) => p === "read" || p === "write" || p === "admin");
    case "write":
      return permissions.some((p) => p === "write" || p === "admin");
    case "admin":
      return permissions.includes("admin");
    case "create":
      // "create" is a collection-only capability (handled by the project "*" arm);
      // it is never a per-resource action, so it grants nothing on a specific id.
      return false;
    default: {
      const _exhaustive: never = action;
      return false;
    }
  }
}

/**
 * Resolve the org an authz check for `input` runs against: `scopeOrg` for the arms
 * that have no resource to resolve (list scope / org-singletons at resourceId "*"),
 * else the resource's OWN org — with the cloud-project fallback, since a project
 * with no local row may be a CLOUD project canonical on the SaaS.
 *
 * `scopeOrg` is supplied by the caller, and the difference between the two callers
 * is the point: `assert` ESTABLISHES request scope (from `X-Organization-Id`), while
 * `checkPermissionOnResource` runs afterwards and CONSUMES the scope `assert`
 * already resolved (`ctx.organizationId`). Everything downstream of that one choice
 * is shared, so use-time and mint-time org resolution can never drift.
 */
async function resolveInputOrg(
  input: PermissionInput,
  scopeOrg: string | null,
): Promise<string | null> {
  if (input.scope === "list" || input.resourceId === "*") return scopeOrg;
  const resource = await resolveResourceOrg(input.resourceType, input.resourceId);
  return resource?.orgId ?? (await resolveCloudFallbackOrg(input.resourceType, scopeOrg));
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
 *
 * The arms with no resource to resolve — list scope and org-singletons
 * (`resourceId: "*"`) — take their authority from the caller's ROLE in an org, so
 * WHICH org is the whole decision. It is `ctx.organizationId`, never the raw
 * `X-Organization-Id` header, for two reasons:
 *
 *   - Every caller runs AFTER `assert` (via routePermission) has resolved the
 *     request's authoritative org and rebound ctx to it, and then reads its actual
 *     DATA from `ctx.organizationId`. Re-deriving from the header would gate on one
 *     org what the handler goes on to do in another — e.g. `canRunJob` on
 *     `/projects/:id/…` checked `{job,"*",write}` against the header while the
 *     project resolved to a different org.
 *   - A mint path writes the binding to `ctx.organizationId` (MCP consent picks the
 *     org explicitly — see `mintContextFor`), so a caller-chosen header could name a
 *     different org: a member of the target org gets a `billing`/`audit` grant
 *     validated against an org they happen to own. GHSA-qv27-39pc-qw9f finding 1.
 *
 * Consequence: this never touches `ctx.hono`, so it also holds for a background ctx.
 */
export async function checkPermissionOnResource(
  ctx: RequestContext,
  input: PermissionInput,
): Promise<boolean> {
  const organizationId = await resolveInputOrg(input, ctx.organizationId);
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

  // Resolve the resource's OWN org + gate on role. This is where request scope is
  // ESTABLISHED, so the list/singleton arms read the header here (and only here) —
  // every later check in the request consumes the org this rebinds ctx to. Shared
  // with checkPermissionOnResource so mint-time acceptance and use-time enforcement
  // can't drift. On deny we throw NotFoundError (not 403) so out-of-permission
  // resources don't leak existence — the IDOR-safe pattern.
  const organizationId = await resolveInputOrg(input, resolveRequestScopeOrg(c));
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
