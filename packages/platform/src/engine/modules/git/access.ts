import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { repos } from "@repo/db";
import type { ResourceGrant } from "@repo/db";
import {
  type GitProviderDefinition,
  NO_SOURCE_ACCESS,
  WHOLE_REPO,
  entryVisible,
  grantsWholeRepo,
  matchesAny,
  type ResolvedSourceAccess,
} from "@repo/core";
import type { ExecutionContext as RequestContext } from "@repo/platform";
import { grantSourceFor, isScoped } from "../../lib/grant-source";

import type { GitAccessTarget, GitAccessOperation, GitSourceTier } from "./capabilities";
function permits(perms: string[], op: GitAccessOperation): boolean {
  switch (op) {
    case "list":
    case "read":
      return perms.some((p) => p === "read" || p === "write" || p === "admin");
    case "write":
      return perms.some((p) => p === "write" || p === "admin");
  }
}

const fullSourceAccess: ResolvedSourceAccess = {
  readPaths: [WHOLE_REPO],
  writePaths: [WHOLE_REPO],
};

export function filterTreeEntries<T>(
  entries: T[],
  readPaths: readonly string[],
  keyOf: (item: T) => { path: string; isDirectory: boolean },
): T[] {
  if (readPaths.length === 0) return [];
  return entries.filter((item) => {
    const k = keyOf(item);
    return entryVisible(k.path, k.isDirectory, readPaths);
  });
}

export function createGitAccess(grantTypes: GitProviderDefinition["grantTypes"]) {
  async function canUse(
    ctx: RequestContext,
    target: GitAccessTarget,
    op: GitAccessOperation,
    opts?: { ownerLevel?: "reach" | "authority" },
  ): Promise<boolean> {
    const organizationId = ctx.organizationId || undefined;
    if (!organizationId) return !isScoped(ctx);

    try {
      const member = await repos.member.find(organizationId, ctx.userId);
      if (!member) return false;
      // A scoped token never gets owner auto-access — it's limited to its grants.
      if (!isScoped(ctx) && member.role === "owner") return true;

      const grants = await grantSourceFor(ctx).listByMember(organizationId, ctx.userId);

      const ownerLevel = opts?.ownerLevel ?? "reach";
      const ownerLc = target.owner.toLowerCase();
      const repoKey = target.repo ? `${ownerLc}/${target.repo.toLowerCase()}` : null;

      for (const g of grants) {
        if (!permits(g.permissions, op)) continue;

        // Provider-wide grant, conventionally resourceId "*".
        if (g.resourceType === grantTypes.root) return true;

        // Org/account-level grant — resourceId is the owner login, matched
        // against the target owner (covers every repo under that account).
        if (g.resourceType === grantTypes.namespace && g.resourceId.toLowerCase() === ownerLc) {
          return true;
        }

        if (g.resourceType === grantTypes.repository) {
          const grantedRepo = g.resourceId.toLowerCase();
          // Exact repo match …
          if (repoKey && grantedRepo === repoKey) return true;
          // … or, for an owner-level check (no specific repo) in "reach" mode, any
          // granted repo under this owner lets them through (downstream filtering /
          // the project binding narrows to the actual repo). In "authority" mode it
          // does NOT: one repo is not authority over the account.
          if (
            !repoKey &&
            ownerLevel === "reach" &&
            grantedRepo.slice(0, grantedRepo.lastIndexOf("/")) === ownerLc
          ) {
            return true;
          }
        }
      }

      return false;
    } catch (diagnosticFailure) {
      observeCaughtError(diagnosticFailure, "platform/engine/modules/git/access");
      return false;
    }
  }

  function governingGrant(
    grants: readonly ResourceGrant[],
    target: GitAccessTarget,
  ): ResourceGrant | null {
    const ownerLc = target.owner.toLowerCase();
    const repoKey = target.repo ? `${ownerLc}/${target.repo.toLowerCase()}` : null;

    let repoGrant: ResourceGrant | null = null;
    let installationGrant: ResourceGrant | null = null;
    let allGrant: ResourceGrant | null = null;

    for (const g of grants) {
      if (g.resourceType === grantTypes.repository) {
        if (repoKey && g.resourceId.toLowerCase() === repoKey) repoGrant ??= g;
      } else if (g.resourceType === grantTypes.namespace) {
        if (g.resourceId.toLowerCase() === ownerLc) installationGrant ??= g;
      } else if (g.resourceType === grantTypes.root) {
        allGrant ??= g;
      }
    }
    return repoGrant ?? installationGrant ?? allGrant ?? null;
  }

  /**
   * Resolve the caller's effective source access for one repo.
   *
   * Returns the path allow-lists, never a boolean: the caller decides whether the
   * specific path it wants is inside them. Empty lists mean metadata-only, which is
   * the DEFAULT for a repo grant — holding `read` on a repo authorises using it
   * (deploy, branches, detect) but NOT crawling it.
   *
   * Fails CLOSED on any lookup error, like the rest of this module.
   */
  async function resolveSourceAccess(
    ctx: RequestContext,
    target: GitAccessTarget,
  ): Promise<ResolvedSourceAccess> {
    const organizationId = ctx.organizationId || undefined;
    if (!organizationId) {
      // Same contract as canUse: no org context means a system/background
      // job with no membership to scope against. A scoped token gets nothing.
      return isScoped(ctx) ? NO_SOURCE_ACCESS : fullSourceAccess;
    }

    try {
      const member = await repos.member.find(organizationId, ctx.userId);
      if (!member) return NO_SOURCE_ACCESS;
      // A scoped token never inherits owner auto-access — it is limited to its grants.
      if (!isScoped(ctx) && member.role === "owner") {
        return fullSourceAccess;
      }

      const grants = await grantSourceFor(ctx).listByMember(organizationId, ctx.userId);
      const grant = governingGrant(grants, target);
      if (!grant) return NO_SOURCE_ACCESS;

      // The scope is the SURFACE; the permission array is still the VERB. A scope
      // naming write paths on a read-only grant grants no writes.
      return {
        readPaths: permits(grant.permissions, "read") ? (grant.scope?.read?.paths ?? []) : [],
        writePaths: permits(grant.permissions, "write") ? (grant.scope?.write?.paths ?? []) : [],
      };
    } catch (diagnosticFailure) {
      observeCaughtError(diagnosticFailure, "platform/engine/modules/git/access");
      return NO_SOURCE_ACCESS;
    }
  }

  /*
   * There were per-path `canReadRepoPath` / `canWriteRepoPath` helpers here. They had
   * no production callers — every real check goes through `checkSourceTier` below,
   * which the route middleware calls — so they were a second implementation of the
   * same rule that only tests exercised, free to drift from the enforced one while
   * looking authoritative. `checkSourceTier` is the single authority; a per-path
   * check is `checkSourceTier(ctx, target, "content" | "write", path)`.
   */

  /**
   * May the caller LIST this directory, and which of its entries may they see?
   *
   * Listing is allowed whenever the directory could contain something granted, so a
   * path-restricted grant stays discoverable — with `read.paths = ["src/**"]`,
   * listing the root succeeds and returns `src/` alone. Blocking the root outright
   * would make the grant unusable; returning it unfiltered would leak every
   * top-level name.
   */
  async function canListRepoPath(
    ctx: RequestContext,
    target: GitAccessTarget,
    dir: string,
  ): Promise<{ allowed: boolean; readPaths: string[] }> {
    const { readPaths } = await resolveSourceAccess(ctx, target);
    if (readPaths.length === 0) return { allowed: false, readPaths };
    // `entryVisible` treats the dir itself as a directory: granted, or an ancestor
    // of something granted.
    return { allowed: entryVisible(dir, true, readPaths), readPaths };
  }

  /**
   * The source tier a route requires. Declared per route (see PermissionSpec.source)
   * so one declaration drives both enforcement and MCP advertisement.
   *
   *   content        read this exact path                — GET .../file
   *   content-tree   list this directory                 — GET .../files
   *   content-whole  needs UNRESTRICTED content          — GET .../clone-token
   *   write          write this exact path               — no endpoints yet
   *
   * `content-tree` is separate from `content` because the rules genuinely differ: a
   * caller scoped to `src/**` may LIST the root (to find `src/`) but may not READ a
   * file at the root. Collapsing them would either break discovery or leak names.
   */

  /**
   * Evaluate a route's source tier for one repo + path.
   *
   * Returns `readPaths` alongside the verdict so a `content-tree` handler can filter
   * the entries it lists without resolving the grant a second time.
   */
  async function checkSourceTier(
    ctx: RequestContext,
    target: GitAccessTarget,
    tier: GitSourceTier,
    path: string,
  ): Promise<{ ok: boolean; readPaths: string[] }> {
    const access = await resolveSourceAccess(ctx, target);
    switch (tier) {
      case "content":
        return { ok: matchesAny(path, access.readPaths), readPaths: access.readPaths };
      case "content-tree":
        return {
          ok: access.readPaths.length > 0 && entryVisible(path, true, access.readPaths),
          readPaths: access.readPaths,
        };
      case "content-whole":
        // A clone hands over every byte and cannot be filtered, so partial content
        // access must NOT satisfy this.
        return { ok: grantsWholeRepo(access.readPaths), readPaths: access.readPaths };
      case "write":
        return { ok: matchesAny(path, access.writePaths), readPaths: access.readPaths };
      default: {
        const _exhaustive: never = tier;
        return { ok: false, readPaths: [] };
      }
    }
  }

  /**
   * Drop directory entries the caller may not see. Same `keyOf` shape as
   * `filterAllowedRepos` below.
   */
  /**
   * Filter a list of repos down to the ones the caller is allowed to
   * see/use. Owner → unchanged. Others → only granted repos (repo grant, a
   * covering namespace grant, or provider-wide access). Used by the repo-picker
   * list endpoints so members only ever see what the owner granted.
   *
   * Matching needs only the repo's owner + name: namespace grants are
   * keyed by owner login (matched against repo.owner), so no installation-id
   * mapping is required.
   */
  async function filterAllowedRepos<T>(
    ctx: RequestContext,
    list: T[],
    keyOf: (item: T) => { owner: string; repo: string },
  ): Promise<T[]> {
    const organizationId = ctx.organizationId || undefined;
    if (!organizationId) return isScoped(ctx) ? [] : list;

    try {
      const member = await repos.member.find(organizationId, ctx.userId);
      if (!member) return [];
      if (!isScoped(ctx) && member.role === "owner") return list;

      const grants = await grantSourceFor(ctx).listByMember(organizationId, ctx.userId);
      if (grants.length === 0) return [];

      // A provider-wide grant short-circuits to full visibility.
      if (
        grants.some((g) => g.resourceType === grantTypes.root && permits(g.permissions, "list"))
      ) {
        return list;
      }

      const grantedOwners = new Set(
        grants
          .filter((g) => g.resourceType === grantTypes.namespace && permits(g.permissions, "list"))
          .map((g) => g.resourceId.toLowerCase()),
      );
      const grantedRepos = new Set(
        grants
          .filter((g) => g.resourceType === grantTypes.repository && permits(g.permissions, "list"))
          .map((g) => g.resourceId.toLowerCase()),
      );

      return list.filter((item) => {
        const k = keyOf(item);
        const ownerLc = k.owner.toLowerCase();
        if (grantedOwners.has(ownerLc)) return true;
        if (grantedRepos.has(`${ownerLc}/${k.repo.toLowerCase()}`)) return true;
        return false;
      });
    } catch (diagnosticFailure) {
      observeCaughtError(diagnosticFailure, "platform/engine/modules/git/access");
      return [];
    }
  }

  async function filterAllowedAccounts<T>(
    ctx: RequestContext,
    accounts: T[],
    loginOf: (item: T) => string,
  ): Promise<T[]> {
    const organizationId = ctx.organizationId || undefined;
    if (!organizationId) return isScoped(ctx) ? [] : accounts;

    try {
      const member = await repos.member.find(organizationId, ctx.userId);
      if (!member) return [];
      if (!isScoped(ctx) && member.role === "owner") return accounts;

      const grants = await grantSourceFor(ctx).listByMember(organizationId, ctx.userId);
      if (grants.length === 0) return [];
      if (
        grants.some((g) => g.resourceType === grantTypes.root && permits(g.permissions, "list"))
      ) {
        return accounts;
      }

      const grantedOwners = new Set(
        grants
          .filter((g) => g.resourceType === grantTypes.namespace && permits(g.permissions, "list"))
          .map((g) => g.resourceId.toLowerCase()),
      );
      // Owners that appear as the prefix of any repo-level grant.
      const repoGrantOwners = new Set(
        grants
          .filter((g) => g.resourceType === grantTypes.repository && permits(g.permissions, "list"))
          .map((g) => g.resourceId.toLowerCase().slice(0, g.resourceId.lastIndexOf("/"))),
      );

      return accounts.filter((item) => {
        const loginLc = loginOf(item).toLowerCase();
        return grantedOwners.has(loginLc) || repoGrantOwners.has(loginLc);
      });
    } catch (diagnosticFailure) {
      observeCaughtError(diagnosticFailure, "platform/engine/modules/git/access");
      return [];
    }
  }

  return {
    canUse,
    source: resolveSourceAccess,
    checkSource: checkSourceTier,
    canListRepoPath,
    filterAllowedRepos,
    filterAllowedAccounts,
  };
}
