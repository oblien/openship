/**
 * LocalGitHubSource — the MERGE. Self-hosted only.
 *
 * Composes an optional gh sub-source (GhCliSource, resolved from a LOCAL token
 * read at construction) + a LAZILY-resolved App sub-source (GitHubAppSource),
 * and OWNS the per-capability source order the wrappers used to scatter:
 *   - listing  → configured local App + gh merged; otherwise gh-FIRST
 *                (local, ZERO cloud), then cloud App, then user-token.
 *   - clone    → App/cloud-first, gh refused for remote (delegated to tokenFor,
 *                whose self-hosted chain already encodes this).
 *   - status   → both sides composed.
 *
 * CRITICAL: the cloud mode-probe (resolveGitHubAuthMode → isCloudConnectedForOrg
 * → /cloud/account) happens ONLY inside `app()`. A gh-first browse never calls
 * it; the sole eager App path is a locally configured App, which has no cloud
 * round-trip and is merged to label App-covered repos correctly.
 *
 * Constructed only in non-CLOUD_MODE (see ./index.ts). The SaaS uses
 * GitHubAppSource directly.
 */

import { listUserOwnedRepos } from "@repo/platform/engine/modules/github/github.service";
import {
  getGitHubConnectionState,
  getGitHubAuthMode,
  getInstallationId,
  getInstallationToken,
  getUserInstallations,
  getUserStatus,
  resolveGitHubAuthMode,
  resolveInstallUrl,
} from "@repo/platform/engine/modules/github/github.auth";
import { tokenFor, canResolveTokenFor } from "@repo/platform/engine/modules/github/github.token";
import type { GitHubPurpose, GitHubTokenSource, TokenContext, TokenResult } from "@repo/platform/engine/modules/github/github.token";
import type { ExecutionContext as RequestContext } from "@repo/platform";
import type { GitHubConnectionState, GitHubInstallation, MappedRepository } from "@repo/contracts";
import type { GhCliSource, GhCliStatus } from "@repo/platform/engine/modules/github/sources/gh-cli-source";
import type { GitHubAppSource } from "@repo/platform/engine/modules/github/sources/app-source";
import type {
  GitHubConnectionStatus,
  GitHubHome,
  GitHubInstallUrl,
  GitHubMode,
  GitHubSource,
  GitHubUserStatus,
} from "@repo/platform/engine/modules/github/sources/types";
import { hasActiveGitHubSource } from "@repo/platform/engine/modules/github/github-source.service";

/**
 * THE one place a gh probe result becomes wire state.
 *
 * `getHome` and `getConnectionState` each built this object inline, and both
 * omitted `method` — so a pasted PAT reached the dashboard as an anonymous
 * "gh CLI" connection (the label is the `?? "host-cli"` fallback) and the
 * library asked for consent to read the host's gh login that was never used.
 * `github.auth.ts:getGitHubConnectionState` set the field correctly and is not
 * on either of these paths, which is why the plumbing looked done.
 */
function ghCliState(status: GhCliStatus): GitHubConnectionState["sources"]["ghCli"] {
  if (status.available) {
    return {
      available: true,
      login: status.login,
      avatarUrl: status.avatar_url,
      method: status.method,
      checkedAt: status.checkedAt,
    };
  }
  // No credential at all → stay the empty shape. `method`/`problem` are present
  // only when something IS stored and failed, which is the case the UI warns on.
  return {
    available: false,
    ...(status.method ? { method: status.method } : {}),
    ...(status.problem ? { problem: status.problem } : {}),
    checkedAt: status.checkedAt,
  };
}

/** Merge one repo list without duplicating App/CLI-visible repositories. */
function mergeRepoSources(
  appRepos: MappedRepository[],
  cliRepos: MappedRepository[],
): MappedRepository[] {
  const merged = new Map<string, MappedRepository>();
  for (const repo of cliRepos) {
    merged.set(repo.full_name.toLowerCase(), { ...repo, source: "cli" });
  }
  for (const repo of appRepos) {
    const key = repo.full_name.toLowerCase();
    const prior = merged.get(key);
    merged.set(key, { ...repo, source: prior ? "both" : "app" });
  }
  return [...merged.values()];
}

export class LocalGitHubSource implements GitHubSource {
  // Listing-facing label; the App side (cloud-app/app) is resolved lazily and
  // is not reflected here. `mode` is informational — nothing dispatches on it.
  readonly mode: GitHubMode = "cli";

  private appResolved = false;
  private appValue: GitHubAppSource | null = null;

  constructor(
    private readonly ctx: RequestContext,
    private readonly gh: GhCliSource | null,
  ) {}

  /**
   * Resolve the App sub-source on demand. THE ONLY place the cloud mode is
   * probed (resolveGitHubAuthMode → isCloudConnectedForOrg → /cloud/account),
   * so gh-first listing never triggers a cloud round-trip. Memoized per source.
   */
  private async app(): Promise<GitHubAppSource | null> {
    if (this.appResolved) return this.appValue;
    const mode = await resolveGitHubAuthMode(this.ctx);
    if (mode === "cloud-app" || mode === "app") {
      const { GitHubAppSource } = await import("@repo/platform/engine/modules/github/sources/app-source");
      this.appValue = new GitHubAppSource(this.ctx, mode);
    }
    this.appResolved = true;
    return this.appValue;
  }

  // ── Listing: gh-FIRST → App → user-token ─────────────────────────────────
  async listReposForOwner(owner?: string): Promise<MappedRepository[] | null> {
    // A deliberately configured local App is authoritative for capability, but
    // the optional local identity may still reveal additional repos. Merge the
    // two so an App-covered repo is tagged `both` (remote-deployable) instead of
    // being mislabeled CLI-only. Cloud-App mode retains its cheap gh-first path
    // and does not add a SaaS round-trip to ordinary browsing.
    if (
      this.gh &&
      (getGitHubAuthMode() === "app" ||
        (await hasActiveGitHubSource(this.ctx.organizationId).catch(() => false)))
    ) {
      const app = await this.app();
      const [cliRepos, appRepos] = await Promise.all([
        this.gh.listReposForOwner(owner),
        app?.listReposForOwner(owner) ?? Promise.resolve(null),
      ]);
      return mergeRepoSources(appRepos ?? [], cliRepos);
    }
    if (this.gh) return this.gh.listReposForOwner(owner);
    const app = await this.app();
    if (app) return app.listReposForOwner(owner);
    // user-token (OAuth/PAT): the user's OWN account must go to /user/repos —
    // /orgs/{me}/repos 404s for a user account.
    const status = await getUserStatus(this.ctx.userId, this.ctx);
    const isOwn = !!owner && status.connected && owner === status.login;
    return listUserOwnedRepos(this.ctx, isOwn ? undefined : owner);
  }

  async getHome(): Promise<GitHubHome> {
    if (
      this.gh &&
      (getGitHubAuthMode() === "app" ||
        (await hasActiveGitHubSource(this.ctx.organizationId).catch(() => false)))
    ) {
      const app = await this.app();
      if (app) {
        const [appHome, ghStatus, cliRepos, cliAccounts] = await Promise.all([
          app.getHome(),
          this.gh.status(),
          this.gh.listAllRepos(),
          this.gh.listOwners(),
        ]);
        const appAccounts = new Set(appHome.accounts.map((a) => a.login.toLowerCase()));
        return {
          state: {
            sources: {
              openshipApp: appHome.state.sources.openshipApp,
              ghCli: ghCliState(ghStatus),
            },
            primary: appHome.state.sources.openshipApp.connected
              ? "openship-app"
              : ghStatus.available
                ? "gh-cli"
                : null,
          },
          accounts: [
            ...appHome.accounts,
            ...cliAccounts.filter((a) => !appAccounts.has(a.login.toLowerCase())),
          ],
          repos: mergeRepoSources(appHome.repos, cliRepos),
          errors: appHome.errors,
        };
      }
    }
    // gh-FIRST: a LOCAL read, ZERO cloud. We never call app() here — the App's
    // connection status is surfaced separately by the Settings card.
    if (this.gh) {
      const status = await this.gh.status();
      const [repos, accounts] = await Promise.all([this.gh.listAllRepos(), this.gh.listOwners()]);
      const state: GitHubConnectionState = {
        sources: {
          openshipApp: { connected: false },
          // `available` is pinned true on this path: the gh sub-source only
          // exists because a token was resolved at construction, and the library
          // is already committed to `primary: "gh-cli"` below. Left as-is (a
          // failed verify here yields an empty repo list rather than an error),
          // but the probe's method/problem now ride along either way.
          ghCli: { ...ghCliState(status), available: true },
        },
        primary: "gh-cli",
      };
      return { state, accounts, repos };
    }

    // No gh → App home (installations) when the App is present.
    const app = await this.app();
    if (app) return app.getHome();

    // Neither → user-token (OAuth/PAT) home, or the empty shell when nothing
    // is connected at all.
    const state = await getGitHubConnectionState(this.ctx);
    if (state.primary === null) return { state, accounts: [], repos: [] };
    const repos = await listUserOwnedRepos(this.ctx);
    return { state, accounts: [], repos };
  }

  // ── Connection status: compose both sides (Settings card; probes cloud) ──
  async getConnectionState(): Promise<GitHubConnectionState> {
    const app = await this.app();
    const [appState, ghStatus] = await Promise.all([
      app ? app.getConnectionState() : Promise.resolve(null),
      // No gh sub-source at all → no credential, so nothing was verified and
      // there is no `problem` to report (that word is reserved for a stored
      // credential that failed).
      this.gh ? this.gh.status() : Promise.resolve({ available: false, method: null } as const),
    ]);
    const openshipApp = appState?.sources.openshipApp ?? { connected: false };
    const ghCli = ghCliState(ghStatus);
    return {
      sources: { openshipApp, ghCli },
      primary: openshipApp.connected ? "openship-app" : ghCli.available ? "gh-cli" : null,
    };
  }

  async getConnectionStatus(): Promise<GitHubConnectionStatus> {
    const [state, app] = await Promise.all([this.getConnectionState(), this.app()]);
    const accounts = app ? (await app.getConnectionStatus()).accounts : [];
    return { state, accounts };
  }

  // ── Delegated primitives (gh-free real impls in github.auth/token) ───────
  getUserStatus(): Promise<GitHubUserStatus> {
    return getUserStatus(this.ctx.userId, this.ctx);
  }

  getUserInstallations(): Promise<GitHubInstallation[]> {
    return getUserInstallations(this.ctx);
  }

  getInstallationId(owner: string): Promise<number | null> {
    return getInstallationId(this.ctx, owner);
  }

  getInstallationToken(owner: string, installationId?: number): Promise<string | null> {
    return getInstallationToken(this.ctx, owner, installationId);
  }

  resolveInstallUrl(): Promise<GitHubInstallUrl> {
    return resolveInstallUrl(this.ctx);
  }

  tokenFor(purpose: GitHubPurpose, tokenCtx: TokenContext = {}): Promise<TokenResult | null> {
    return tokenFor(this.ctx, purpose, tokenCtx);
  }

  canResolveTokenFor(
    purpose: GitHubPurpose,
    tokenCtx: TokenContext = {},
  ): Promise<GitHubTokenSource | null> {
    return canResolveTokenFor(this.ctx, purpose, tokenCtx);
  }
}
