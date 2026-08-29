import { api } from "./client";
import { endpoints } from "./endpoints";

/** Query for the server-paginated repo list (all optional). */
export interface RepoListQuery {
  page?: number;
  perPage?: number;
  search?: string;
  visibility?: "all" | "public" | "private";
  sort?: "updated" | "name" | "stars";
}

/** Server response for a repo-list page. `count` is search/visibility-scoped
 *  (the footer); `total`/`publicCount`/`privateCount` are the owner-wide
 *  overview (the sidebar). Mirrors RepoListResult in the API's repo-list.ts. */
export interface RepoPageResponse<TRepo = unknown> {
  data: TRepo[];
  page: number;
  perPage: number;
  count: number;
  total: number;
  publicCount: number;
  privateCount: number;
  totalPages: number;
}

/* ------------------------------------------------------------------ */
/*  /github/status request dedup (in-flight only — NOT a cache)        */
/* ------------------------------------------------------------------ */
//
// App-connection status (GET /github/status) needs a cloud round-trip. The SaaS
// is the live source of truth, so we DON'T cache the result over time — every
// fresh read re-probes. We only coalesce CONCURRENT calls: the Settings card +
// library badge mounting together (or a dev double-render) share one in-flight
// request instead of firing two. The entry clears the moment it settles, so the
// next read is always live. `invalidateStatus()` drops a stale in-flight after a
// connect/disconnect so a request started pre-mutation isn't reused.
let statusInflight: Promise<unknown> | null = null;

function getStatusDeduped<T = unknown>(force = false): Promise<T> {
  if (!force && statusInflight) return statusInflight as Promise<T>;
  const work = api.get<T>(endpoints.github.status).finally(() => {
    if (statusInflight === work) statusInflight = null;
  });
  statusInflight = work;
  return work as Promise<T>;
}

function invalidateStatus(): void {
  statusInflight = null;
}

/* ------------------------------------------------------------------ */
/*  GitHub Integration API                                            */
/* ------------------------------------------------------------------ */

/** One entry in a repo's recursive path list. */
export interface RepoTreeEntry {
  path: string;
  type: "file" | "dir";
}

export const githubApi = {
  /** Dashboard home - user info, orgs, recent repos */
  getUserHome: () => api.get<any>(endpoints.github.userHome),

  /**
   * A repo's whole tree, flat and recursive — one call, so the path picker can
   * render a collapsible tree AND search it without a request per directory.
   * Server-side it's filtered to paths the caller may themselves read.
   */
  getRepoTree: (owner: string, repo: string, branch?: string) =>
    api.get<{ data: RepoTreeEntry[] }>(
      endpoints.github.repoTree(owner, repo) + (branch ? `?branch=${encodeURIComponent(branch)}` : ""),
    ),

  /** Repos for a specific GitHub org */
  getOrgRepos: (owner: string) =>
    api.get<any>(endpoints.github.orgRepos(owner)),

  /** Repos for a specific GitHub user. Server-paginated: pass page/perPage/
   *  search/visibility/sort and read the authoritative `count`/`total` back
   *  (omit the params to get the full set, as MCP + legacy callers do). */
  getUserRepos: (owner: string, params?: RepoListQuery) =>
    api.get<RepoPageResponse>(endpoints.github.userRepos, {
      params: { owner, ...params },
    }),

  /** List a repo's branches (used before a project exists — e.g. the migration
   *  wizard's link-repo step, which can't use projectsApi.getBranches). */
  listBranches: (owner: string, repo: string) =>
    api.get<{ data: Array<{ name: string }> }>(
      endpoints.github.repoBranches(owner, repo),
    ),

  /**
   * Mint a short-lived GitHub App installation token for cloning a repo and
   * return a ready-to-run `git clone` command. Cloud / GitHub-App mode only —
   * 409s in gh-CLI / PAT mode (no installation token). Token expires ~1h.
   */
  getCloneToken: (owner: string, repo: string) =>
    api.get<{ token: string; cloneUrl: string; command: string }>(
      endpoints.github.cloneToken(owner, repo),
    ),

  /** Check GitHub connection status (live, no dedup). */
  getStatus: () => api.get<any>(endpoints.github.status),

  /**
   * GitHub connection status, de-duplicated across CONCURRENT callers (Settings
   * card + library App badge) but always LIVE — no TTL cache. Pass `force` after
   * a mutation to bypass a pre-mutation in-flight request. `invalidateStatus`
   * drops any in-flight on connect/disconnect.
   */
  getStatusDeduped: <T = unknown>(force = false) => getStatusDeduped<T>(force),
  invalidateStatus,

  /**
   * Start a GitHub connection. Pass `source` from the dashboard's
   * dual-source settings panel:
   *   - "oauth" → force the Openship App install flow (even if gh CLI
   *     is already authenticated). Used by the "Connect Openship App"
   *     button so it never short-circuits on a pre-existing cli token.
   *   - "cli"   → only consider the gh CLI source.
   *   - omit    → server picks based on installation auth mode.
   */
  connect: (source?: "oauth" | "cli") =>
    api.post<any>(endpoints.github.connect, source ? { source } : undefined),

  /**
   * Connect this instance with a pasted GitHub token. Validated server-side
   * before it is stored, so a bad scope comes back as a 400 on the field rather
   * than a broken clone mid-deploy. Self-hosted only.
   */
  setInstanceToken: (token: string) =>
    api.post<{ connected: boolean; login?: string; warning?: string }>(
      endpoints.github.instanceToken,
      { token },
    ),

  /** Poll device flow status */
  pollConnect: () => api.get<any>(endpoints.github.connectPoll),

  /**
   * Disconnect a GitHub source.
   *   - "oauth" → remove the Openship App / OAuth account row
   *   - "cli"   → suppress the gh CLI fallback (host config untouched)
   *   - "all"   → both (default - preserves the old behavior)
   */
  disconnect: (source: "oauth" | "cli" | "all" = "all") =>
    api.post<{ success: boolean; source: string }>(endpoints.github.disconnect, { source }),
};
