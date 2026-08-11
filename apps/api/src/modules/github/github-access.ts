/**
 * @module github-access
 *
 * THE single authorization gate for "may this caller act on this GitHub
 * repo/installation?". Default-DENY by design: GitHub access belongs to
 * the org OWNER (who connected Openship Cloud and owns the App identity);
 * everyone else — admins included — gets nothing until the owner grants
 * it. Grants come in three widths, checked specific → broad:
 *
 *   • github_repository  resourceId "owner/repo"   — one repo
 *   • github_installation resourceId "owner"       — every repo under one
 *                                                     GitHub org / account
 *                                                     (keyed by login, not
 *                                                     numeric id — stable to
 *                                                     match against repo.owner)
 *   • github              resourceId "*"            — all GitHub
 *
 * 0-bypass contract: this resolver is called inside `tokenFor()` (the one
 * funnel every token mint / clone / API call passes through) and at the
 * deploy-action + list-filter layers. There is no second door — if this
 * says no, no token is minted and the operation cannot proceed.
 *
 * Atomicity note: this is the AUTHORIZATION layer ("who may"). EXISTENCE
 * ("does the repo/installation still exist") is enforced separately by the
 * token layer (a removed installation can't mint a token) and by list
 * filtering against the live SaaS installation set. So a stale grant can
 * never widen access to a repo the org no longer has installed.
 */

import { repos } from "@repo/db";
import type { ResourceGrant } from "@repo/db";
import {
  AppError,
  NO_SOURCE_ACCESS,
  WHOLE_REPO,
  entryVisible,
  grantsWholeRepo,
  matchesAny,
  type ResolvedSourceAccess,
} from "@repo/core";
import type { RequestContext } from "../../lib/request-context";
import { grantSourceFor, isScoped } from "../../lib/grant-source";

/** What the caller wants to do, mapped onto grant permissions. */
export type GitHubAccessOp = "list" | "read" | "write";

/**
 * Roles that get GitHub access with NO grant. Product rule: ONLY the org
 * owner (the GitHub-account / cloud-connection owner). Admins and members
 * are default-deny until granted. To let admins inherit full GitHub
 * access, add "admin" here — it's the single knob.
 */
const GITHUB_AUTO_ACCESS_ROLES = new Set<string>(["owner"]);

const GH_ALL = "github";
const GH_INSTALLATION = "github_installation";
const GH_REPOSITORY = "github_repository";

function permits(perms: string[], op: GitHubAccessOp): boolean {
  switch (op) {
    case "list":
    case "read":
      return perms.some((p) => p === "read" || p === "write" || p === "admin");
    case "write":
      return perms.some((p) => p === "write" || p === "admin");
  }
}

export interface GitHubAccessTarget {
  /** Repo owner / GitHub org login. */
  owner: string;
  /** Repo name. Omit for owner-level checks (e.g. "can list under owner"). */
  repo?: string | null;
  /** Installation id backing this owner, when known. */
  installationId?: string | number | null;
}

/**
 * Authorize a GitHub action for the request's caller.
 *
 *   - No org context (system / background jobs) → allow. There's no
 *     membership to scope against, and the token layer still enforces
 *     installation existence, so this can't reach a repo the org lacks.
 *   - Owner role → allow.
 *   - Everyone else → allow ONLY if a matching grant exists at the repo,
 *     installation, or all-GitHub level with sufficient permission.
 *
 * When `target.repo` is omitted (owner-level list/token gating), a member
 * who holds ANY repo grant under that owner passes — the actual repo set
 * is narrowed downstream by list filtering / the project binding, so a
 * repo-only member can still see and build their granted repo.
 *
 * Fails CLOSED on any lookup error.
 */
export async function canUseGitHubRepo(
  ctx: RequestContext,
  target: GitHubAccessTarget,
  op: GitHubAccessOp,
): Promise<boolean> {
  const organizationId = ctx.organizationId || undefined;
  if (!organizationId) return !isScoped(ctx);

  try {
    const member = await repos.member.find(organizationId, ctx.userId);
    if (!member) return false;
    // A scoped token never gets owner auto-access — it's limited to its grants.
    if (!isScoped(ctx) && GITHUB_AUTO_ACCESS_ROLES.has(member.role ?? "member")) return true;

    const grants = await grantSourceFor(ctx).listByMember(organizationId, ctx.userId);

    const ownerLc = target.owner.toLowerCase();
    const repoKey = target.repo ? `${ownerLc}/${target.repo.toLowerCase()}` : null;

    for (const g of grants) {
      if (!permits(g.permissions, op)) continue;

      // All-GitHub grant (resourceType "github", conventionally resourceId "*").
      if (g.resourceType === GH_ALL) return true;

      // Org/account-level grant — resourceId is the owner login, matched
      // against the target owner (covers every repo under that account).
      if (g.resourceType === GH_INSTALLATION && g.resourceId.toLowerCase() === ownerLc) {
        return true;
      }

      if (g.resourceType === GH_REPOSITORY) {
        const grantedRepo = g.resourceId.toLowerCase();
        // Exact repo match …
        if (repoKey && grantedRepo === repoKey) return true;
        // … or, for an owner-level check (no specific repo), any granted
        // repo under this owner lets them through (downstream filtering /
        // the project binding narrows to the actual repo).
        if (!repoKey && grantedRepo.startsWith(`${ownerLc}/`)) return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Hard-assert GitHub access for a deploy-style action and throw a clear
 * 403 when denied. Use at deploy / redeploy / rollback entry points so a
 * blocked member is stopped UP FRONT with an actionable message — instead
 * of falling through to their personal OAuth/PAT (which would bypass the
 * owner's control on a local build) or failing opaquely mid-build.
 *
 * No-op for non-GitHub projects (no owner/repo → nothing to gate).
 */
export async function assertGitHubRepoAccess(
  ctx: RequestContext,
  target: { owner?: string | null; repo?: string | null },
  op: GitHubAccessOp = "read",
): Promise<void> {
  if (!target.owner || !target.repo) return;
  const allowed = await canUseGitHubRepo(
    ctx,
    { owner: target.owner, repo: target.repo },
    op,
  );
  if (allowed) return;
  throw new AppError(
    `You don't have access to ${target.owner}/${target.repo}. Ask an organization owner to grant you access to this repository.`,
    403,
    "GITHUB_ACCESS_DENIED",
  );
}

/* ------------------------------------------------------------------ */
/*  Source access — may the caller read/write FILE CONTENT, and where?  */
/* ------------------------------------------------------------------ */

/**
 * Everything, for the principals that legitimately have it (the org owner on a
 * browser session, and system/background jobs with no membership to scope to).
 */
const FULL_SOURCE_ACCESS: ResolvedSourceAccess = {
  readPaths: [WHOLE_REPO],
  writePaths: [WHOLE_REPO],
};

/**
 * The single grant that governs this target, resolved MOST-SPECIFIC-WINS:
 * repo → installation → all-GitHub.
 *
 * Deliberately not a union of every matching grant. Unioning would let a broad
 * `github_installation` grant silently widen a deliberately narrow per-repo grant
 * — the owner picked "only src/** of charts" and would get the whole account's
 * scope instead. Whichever grant is most specific is the one the owner most
 * recently reasoned about, so it wins outright.
 *
 * This is a narrower rule than `canUseGitHubRepo`'s "any permitting grant passes",
 * and intentionally so: that function answers "may they touch this repo at all",
 * which is monotonic; this one answers "how far in", which is not.
 */
function governingGrant(
  grants: readonly ResourceGrant[],
  target: GitHubAccessTarget,
): ResourceGrant | null {
  const ownerLc = target.owner.toLowerCase();
  const repoKey = target.repo ? `${ownerLc}/${target.repo.toLowerCase()}` : null;

  let repoGrant: ResourceGrant | null = null;
  let installationGrant: ResourceGrant | null = null;
  let allGrant: ResourceGrant | null = null;

  for (const g of grants) {
    if (g.resourceType === GH_REPOSITORY) {
      if (repoKey && g.resourceId.toLowerCase() === repoKey) repoGrant ??= g;
    } else if (g.resourceType === GH_INSTALLATION) {
      if (g.resourceId.toLowerCase() === ownerLc) installationGrant ??= g;
    } else if (g.resourceType === GH_ALL) {
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
export async function resolveSourceAccess(
  ctx: RequestContext,
  target: GitHubAccessTarget,
): Promise<ResolvedSourceAccess> {
  const organizationId = ctx.organizationId || undefined;
  if (!organizationId) {
    // Same contract as canUseGitHubRepo: no org context means a system/background
    // job with no membership to scope against. A scoped token gets nothing.
    return isScoped(ctx) ? NO_SOURCE_ACCESS : FULL_SOURCE_ACCESS;
  }

  try {
    const member = await repos.member.find(organizationId, ctx.userId);
    if (!member) return NO_SOURCE_ACCESS;
    // A scoped token never inherits owner auto-access — it is limited to its grants.
    if (!isScoped(ctx) && GITHUB_AUTO_ACCESS_ROLES.has(member.role ?? "member")) {
      return FULL_SOURCE_ACCESS;
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
  } catch {
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
export async function canListRepoPath(
  ctx: RequestContext,
  target: GitHubAccessTarget,
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
export type SourceTier = "content" | "content-tree" | "content-whole" | "write";

/**
 * Evaluate a route's source tier for one repo + path.
 *
 * Returns `readPaths` alongside the verdict so a `content-tree` handler can filter
 * the entries it lists without resolving the grant a second time.
 */
export async function checkSourceTier(
  ctx: RequestContext,
  target: GitHubAccessTarget,
  tier: SourceTier,
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

/**
 * Filter a list of repos down to the ones the caller is allowed to
 * see/use. Owner → unchanged. Others → only granted repos (repo grant, a
 * covering org/account grant, or all-GitHub). Used by the repo-picker
 * list endpoints so members only ever see what the owner granted.
 *
 * Matching needs only the repo's owner + name: org/account grants are
 * keyed by owner login (matched against repo.owner), so no installation-id
 * mapping is required.
 */
export async function filterAllowedRepos<T>(
  ctx: RequestContext,
  list: T[],
  keyOf: (item: T) => { owner: string; repo: string },
): Promise<T[]> {
  const organizationId = ctx.organizationId || undefined;
  if (!organizationId) return isScoped(ctx) ? [] : list;

  try {
    const member = await repos.member.find(organizationId, ctx.userId);
    if (!member) return [];
    if (!isScoped(ctx) && GITHUB_AUTO_ACCESS_ROLES.has(member.role ?? "member")) return list;

    const grants = await grantSourceFor(ctx).listByMember(organizationId, ctx.userId);
    if (grants.length === 0) return [];

    // All-GitHub grant short-circuits to full visibility.
    if (grants.some((g) => g.resourceType === GH_ALL && permits(g.permissions, "list"))) {
      return list;
    }

    const grantedOwners = new Set(
      grants
        .filter((g) => g.resourceType === GH_INSTALLATION && permits(g.permissions, "list"))
        .map((g) => g.resourceId.toLowerCase()),
    );
    const grantedRepos = new Set(
      grants
        .filter((g) => g.resourceType === GH_REPOSITORY && permits(g.permissions, "list"))
        .map((g) => g.resourceId.toLowerCase()),
    );

    return list.filter((item) => {
      const k = keyOf(item);
      const ownerLc = k.owner.toLowerCase();
      if (grantedOwners.has(ownerLc)) return true;
      if (grantedRepos.has(`${ownerLc}/${k.repo.toLowerCase()}`)) return true;
      return false;
    });
  } catch {
    return [];
  }
}

/**
 * Filter a list of GitHub accounts/installations down to the ones a member
 * may see — an account is visible if they hold an org/account grant on it,
 * any repo grant UNDER it, or an all-GitHub grant. Owner → unchanged.
 * Keeps the picker's account switcher honest (no orgs the member can't
 * touch), while a repo-only member still sees the account holding that repo.
 */
export async function filterAllowedAccounts<T>(
  ctx: RequestContext,
  accounts: T[],
  loginOf: (item: T) => string,
): Promise<T[]> {
  const organizationId = ctx.organizationId || undefined;
  if (!organizationId) return isScoped(ctx) ? [] : accounts;

  try {
    const member = await repos.member.find(organizationId, ctx.userId);
    if (!member) return [];
    if (!isScoped(ctx) && GITHUB_AUTO_ACCESS_ROLES.has(member.role ?? "member")) return accounts;

    const grants = await grantSourceFor(ctx).listByMember(organizationId, ctx.userId);
    if (grants.length === 0) return [];
    if (grants.some((g) => g.resourceType === GH_ALL && permits(g.permissions, "list"))) {
      return accounts;
    }

    const grantedOwners = new Set(
      grants
        .filter((g) => g.resourceType === GH_INSTALLATION && permits(g.permissions, "list"))
        .map((g) => g.resourceId.toLowerCase()),
    );
    // Owners that appear as the prefix of any repo-level grant.
    const repoGrantOwners = new Set(
      grants
        .filter((g) => g.resourceType === GH_REPOSITORY && permits(g.permissions, "list"))
        .map((g) => g.resourceId.toLowerCase().split("/")[0]),
    );

    return accounts.filter((item) => {
      const loginLc = loginOf(item).toLowerCase();
      return grantedOwners.has(loginLc) || repoGrantOwners.has(loginLc);
    });
  } catch {
    return [];
  }
}
