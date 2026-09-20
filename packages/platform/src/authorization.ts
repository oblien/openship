import { randomUUID } from "node:crypto";
import {
  AppError,
  NotFoundError,
  UnauthorizedError,
  ORG_SINGLETON_RESOURCE_TYPES,
  type Permission,
  type ResourceType,
} from "@repo/core";
import {
  freezeContext,
  type ContextRole,
  type ExecutionContext,
  type VerifiedIdentity,
} from "./context";

export const ORG_SINGLETON_RESOURCES: ReadonlySet<string> = new Set(ORG_SINGLETON_RESOURCE_TYPES);
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
  /** list permits an access-filtered collection; all requires a wildcard grant. */
  scope?: "list" | "all";
  /** Only the dedicated project-create operation may enable create-only grants. */
  projectCreate?: boolean;
}

export interface PermissionGrantSource {
  findForResource(
    orgId: string,
    userId: string,
    type: ResourceType,
    id: string,
  ): Promise<{ permissions: readonly Permission[] } | null>;
}

export interface PermissionMembership {
  id: string;
  role?: string | null;
}
type Lookup<T> = Promise<T | null | undefined>;
type Owned = { organizationId: string | null };
type ProjectChild = { projectId: string | null };
type BackupChild = { destinationId: string | null };

/** Narrow repository ports: no database import, global bootstrap, or application dependency. */
export interface PermissionRepositories {
  member: { find(orgId: string, userId: string): Lookup<PermissionMembership> };
  resourceGrant: PermissionGrantSource;
  project: {
    findById(id: string): Lookup<Owned>;
    findEnvVarById(id: string): Lookup<ProjectChild>;
  };
  server: { get(id: string): Lookup<Owned> };
  backupDestination: { findById(id: string): Lookup<Owned> };
  deployment: {
    findById(id: string): Lookup<ProjectChild>;
    findBuildSession(id: string): Lookup<{ deploymentId: string | null }>;
  };
  domain: { findById(id: string): Lookup<ProjectChild> };
  service: { findById(id: string): Lookup<ProjectChild> };
  backupPolicy: { findById(id: string): Lookup<BackupChild> };
  backupRun: { findById(id: string): Lookup<BackupChild> };
  backupRestore: { findById(id: string): Lookup<BackupChild> };
}

export interface AuthorizationDependencies {
  repos: PermissionRepositories;
  grantSourceFor(ctx: ExecutionContext): PermissionGrantSource;
  /** A self-hosted gateway can authorize an upstream project before forwarding. */
  cloud?: { isCanonical(): boolean; isLinked(organizationId: string): Promise<boolean> };
  now?: () => number;
}

export interface PermissionOptions {
  roleOverride?: ContextRole;
  grants?: PermissionGrantSource;
}

interface ResolvedResource {
  orgId: string;
  rootType: ResourceType;
  rootId: string;
}

export const PROJECT_ROOTED: ReadonlySet<CheckedResourceType> = new Set([
  "project",
  "deployment",
  "domain",
  "service",
  "env_var",
  "build_session",
]);

/** Shared with capability discovery; restricted roles use grants instead. */
export function roleAllowsResourceType(
  role: "owner" | "admin" | "member",
  type: CheckedResourceType,
): boolean {
  if (role === "owner") return true;
  if (role === "admin") return type !== "billing";
  return type !== "billing" && type !== "audit";
}

export function permitsAction(permissions: readonly Permission[], action: Permission): boolean {
  switch (action) {
    case "read":
      return permissions.some((p) => p === "read" || p === "write" || p === "admin");
    case "write":
      return permissions.some((p) => p === "write" || p === "admin");
    case "admin":
      return permissions.includes("admin");
    case "create":
      return false; // Collection-only, handled by projectCreate below.
    default: {
      const _exhaustive: never = action;
      return false;
    }
  }
}

function membershipRole(member: PermissionMembership): ContextRole | null {
  const role = member.role ?? "member";
  return role === "owner" || role === "admin" || role === "member" || role === "restricted"
    ? role
    : null;
}

/** The existing API policy, with persistence and cloud linkage supplied by its owner. */
export function createAuthorization(deps: AuthorizationDependencies) {
  const { repos } = deps;
  const now = deps.now ?? Date.now;
  const canForward = () => !!deps.cloud && !deps.cloud.isCanonical();

  async function loadRootOrgId(type: ResourceType, id: string): Promise<string | null> {
    switch (type) {
      case "project":
        return (await repos.project.findById(id))?.organizationId ?? null;
      case "server":
      case "mail_server":
        return (await repos.server.get(id).catch(() => null))?.organizationId ?? null;
      case "backup_destination":
        return (await repos.backupDestination.findById(id))?.organizationId ?? null;
      case "billing":
      case "audit":
        return id === "*" ? null : id;
      default:
        return null;
    }
  }

  async function resolveResourceOrg(
    type: CheckedResourceType,
    id: string,
  ): Promise<ResolvedResource | null> {
    const direct = await loadRootOrgId(type as ResourceType, id);
    if (direct) return { orgId: direct, rootType: type as ResourceType, rootId: id };
    let rootType: ResourceType = "project";
    let rootId: string | null | undefined;
    switch (type) {
      case "deployment":
        rootId = (await repos.deployment.findById(id))?.projectId;
        break;
      case "domain":
        rootId = (await repos.domain.findById(id))?.projectId;
        break;
      case "service":
        rootId = (await repos.service.findById(id))?.projectId;
        break;
      case "env_var":
        rootId = (await repos.project.findEnvVarById(id).catch(() => null))?.projectId;
        break;
      case "backup_policy":
        rootType = "backup_destination";
        rootId = (await repos.backupPolicy.findById(id).catch(() => null))?.destinationId;
        break;
      case "backup_run":
        rootType = "backup_destination";
        rootId = (await repos.backupRun.findById(id).catch(() => null))?.destinationId;
        break;
      case "backup_restore":
        rootType = "backup_destination";
        rootId = (await repos.backupRestore.findById(id).catch(() => null))?.destinationId;
        break;
      case "build_session": {
        const session = await repos.deployment.findBuildSession(id).catch(() => null);
        rootId = session?.deploymentId
          ? (await repos.deployment.findById(session.deploymentId))?.projectId
          : null;
        break;
      }
      default:
        return null;
    }
    if (!rootId) return null;
    const orgId = await loadRootOrgId(rootType, rootId);
    return orgId ? { orgId, rootType, rootId } : null;
  }

  async function resolveInputOrg(
    input: PermissionInput,
    scopeOrg: string | null,
  ): Promise<string | null> {
    if (input.scope === "list" || input.resourceId === "*") return scopeOrg;
    const resource = await resolveResourceOrg(input.resourceType, input.resourceId);
    if (resource) return resource.orgId;
    if (!canForward() || !PROJECT_ROOTED.has(input.resourceType) || !scopeOrg) return null;
    return (await deps.cloud!.isLinked(scopeOrg).catch(() => false)) ? scopeOrg : null;
  }

  async function allowsMember(
    member: PermissionMembership,
    userId: string,
    organizationId: string,
    input: PermissionInput,
    opts?: PermissionOptions,
  ): Promise<boolean> {
    // Runtime callers cannot rely on the TypeScript union, including callers
    // whose role would otherwise bypass individual grant checks.
    if (!["read", "write", "admin", "create"].includes(input.action)) return false;
    const persistedRole = membershipRole(member);
    if (!persistedRole) return false;
    const role = opts?.roleOverride ?? persistedRole;
    if (role === "owner" || role === "admin" || role === "member")
      return roleAllowsResourceType(role, input.resourceType);
    if (role !== "restricted") return false;
    const source = opts?.grants ?? repos.resourceGrant;

    // A create-only wildcard permits creation and a filtered list, never an
    // ensure/scan/import operation that might modify somebody else's project.
    if (input.resourceType === "project" && input.resourceId === "*") {
      const wildcard = await source.findForResource(organizationId, userId, "project", "*");
      if (wildcard?.permissions.includes("create")) {
        if (input.action === "write" && input.projectCreate === true) return true;
        if (input.action === "read" && input.scope !== "all") return true;
      }
    }

    if (input.resourceId === "*") {
      const grant = await source.findForResource(
        organizationId,
        userId,
        input.resourceType as ResourceType,
        "*",
      );
      return grant ? permitsAction(grant.permissions, input.action) : false;
    }

    let root = await resolveResourceOrg(input.resourceType, input.resourceId);
    if (!root) {
      // Cloud sub-resources cannot be traced to a project locally. Only a
      // project itself can use its upstream id as the directly granted root.
      if (canForward() && input.resourceType === "project") {
        root = { orgId: organizationId, rootType: "project", rootId: input.resourceId };
      } else return false;
    }
    const grant = await source.findForResource(organizationId, userId, root.rootType, root.rootId);
    return grant ? permitsAction(grant.permissions, input.action) : false;
  }

  /** Internal compatibility helper. The caller must already have verified resource ownership. */
  async function checkPermission(
    userId: string,
    organizationId: string,
    input: PermissionInput,
    opts?: PermissionOptions,
  ): Promise<boolean> {
    const member = await repos.member.find(organizationId, userId);
    return member ? allowsMember(member, userId, organizationId, input, opts) : false;
  }

  function credentialExpired(ctx: Pick<ExecutionContext, "credential">): boolean {
    const expiresAt = ctx.credential?.expiresAt;
    return expiresAt != null && (!Number.isFinite(expiresAt) || expiresAt <= now());
  }

  function withinScope(ctx: ExecutionContext, org: string): boolean {
    if (ctx.scopeMode === "fixed" && ctx.organizationId !== org) return false;
    const bound = ctx.credential?.organizationId ?? (ctx.tokenScope ? ctx.organizationId : null);
    return !bound || bound === org;
  }

  async function decision(ctx: ExecutionContext, input: PermissionInput, scopeOrg: string | null) {
    if (credentialExpired(ctx) || (ctx.credential?.readOnly && input.action !== "read"))
      return null;
    const org = await resolveInputOrg(input, scopeOrg);
    if (!org || !withinScope(ctx, org)) return null;
    const member = await repos.member.find(org, ctx.userId);
    if (!member) return null;
    const opts = ctx.tokenScope
      ? { roleOverride: "restricted" as const, grants: deps.grantSourceFor(ctx) }
      : undefined;
    return (await allowsMember(member, ctx.userId, org, input, opts)) ? { org, member } : null;
  }

  /**
   * Consume the already resolved organization for collections/singletons; detail
   * checks resolve resource ownership again. This never reads HTTP headers and
   * is also the safe check for grant minting and background application work.
   */
  async function checkPermissionOnResource(
    ctx: ExecutionContext,
    input: PermissionInput,
  ): Promise<boolean> {
    return !!(await decision(ctx, input, ctx.organizationId));
  }

  /** Return a new authorized context. No request mutation, ambient tenant, or cached role. */
  async function authorize(
    ctx: ExecutionContext,
    input: PermissionInput,
    scopeOrg: string | null = ctx.organizationId,
  ): Promise<ExecutionContext> {
    if (credentialExpired(ctx)) throw new UnauthorizedError("Identity has expired");
    if (ctx.credential?.readOnly && input.action !== "read") {
      throw new AppError("This access token is read-only", 403, "TOKEN_READ_ONLY");
    }
    const resolved = await decision(ctx, input, scopeOrg);
    if (!resolved) throw new NotFoundError(input.resourceType, input.resourceId);
    const base = freezeContext(ctx);
    return freezeContext({
      ...base,
      organizationId: resolved.org,
      membershipId: resolved.member.id,
      role: ctx.tokenScope ? "restricted" : membershipRole(resolved.member)!,
    });
  }

  /** Resolve a verified host identity to a fixed tenant. No caller-provided role is accepted. */
  async function resolveScope(
    identity: VerifiedIdentity,
    organizationId: string,
  ): Promise<ExecutionContext> {
    if (!identity?.user?.id || !identity.sessionId || credentialExpired(identity))
      throw new UnauthorizedError("Invalid or expired identity");
    if (identity.tokenScope && !identity.tokenScope.tokenId)
      throw new UnauthorizedError("Invalid scoped credential");
    if (identity.tokenScope && !identity.credential?.organizationId) {
      throw new AppError(
        "Scoped credentials must be bound to an organization",
        403,
        "TOKEN_ORG_UNBOUND",
      );
    }
    if (
      identity.credential?.organizationId &&
      identity.credential.organizationId !== organizationId
    ) {
      throw new AppError(
        "This access token is scoped to a different organization",
        403,
        "TOKEN_ORG_SCOPE",
      );
    }
    const member = await repos.member.find(organizationId, identity.user.id);
    if (!member || !membershipRole(member)) throw new NotFoundError("organization", organizationId);
    return freezeContext({
      userId: identity.user.id,
      user: identity.user,
      organizationId,
      role: identity.tokenScope ? "restricted" : membershipRole(member)!,
      membershipId: member.id,
      sessionId: identity.sessionId,
      sessionKind: identity.sessionKind ?? "native",
      principalKind: identity.principalKind,
      tokenScope: identity.tokenScope,
      credential: identity.credential,
      scopeMode: "fixed",
      clientIp: null,
      userAgent: "openship-sdk/native",
      traceId: randomUUID(),
      source: "api",
    });
  }

  return Object.freeze({ checkPermission, checkPermissionOnResource, authorize, resolveScope });
}

export type Authorization = ReturnType<typeof createAuthorization>;
