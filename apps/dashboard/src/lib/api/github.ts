import { api } from "./client";
import { endpoints } from "./endpoints";

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

export const githubApi = {
  /** Dashboard home - user info, orgs, recent repos */
  getUserHome: () => api.get<any>(endpoints.github.userHome),

  /** Repos for a specific GitHub org */
  getOrgRepos: (owner: string) =>
    api.get<any>(endpoints.github.orgRepos(owner)),

  /** Repos for a specific GitHub user */
  getUserRepos: (owner: string) =>
    api.get<any>(endpoints.github.userRepos, { params: { owner } }),

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
