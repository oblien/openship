/**
 * GitHubAppSource — the GitHub App source. ZERO gh-CLI (no github.local-auth
 * import anywhere in this file).
 *
 * Backend selection is implicit: the github.auth App functions it delegates to
 * already branch on the resolved mode — `app` → local key-mint (SaaS), and
 * `cloud-app` → SaaS-proxied mint ("in local keep getting the token from
 * cloud"). So one class covers both; the token-minting / cache code stays in
 * github.auth verbatim (multi-tenant org-scoped keys unchanged).
 *
 * Used two ways:
 *   - SaaS (CLOUD_MODE): the resolver returns this directly as THE GitHubSource
 *     (no gh, no merge).
 *   - local + Openship Cloud connected: LocalGitHubSource (the merge) composes
 *     one of these as its App sub-source for installations + cloud-minted clone
 *     tokens, while gh drives listing.
 */

import { ghFetch } from "@repo/platform/engine/modules/github/github.http";
import {
  getInstallationId,
  getInstallationToken,
  getUserInstallations,
  getUserStatus,
  resolveInstallUrl,
} from "@repo/platform/engine/modules/github/github.auth";
import { tokenFor, canResolveTokenFor } from "@repo/platform/engine/modules/github/github.token";
import type { GitHubPurpose, GitHubTokenSource, TokenContext, TokenResult } from "@repo/platform/engine/modules/github/github.token";
import { mapAccounts, mapRepositories } from "@repo/platform/engine/modules/github/sources/mappers";
import type { ExecutionContext as RequestContext } from "@repo/platform";
import type {
  GitHubConnectionState,
  GitHubInstallation,
  GitHubRepository,
  MappedAccount,
  MappedRepository,
} from "@repo/contracts";
import type {
  GitHubConnectionStatus,
  GitHubHome,
  GitHubInstallUrl,
  GitHubMode,
  GitHubSource,
  GitHubUserStatus,
} from "@repo/platform/engine/modules/github/sources/types";
import { hasActiveGitHubSource, resolveGitHubApiBaseUrl } from "@repo/platform/engine/modules/github/github-source.service";

export class GitHubAppSource implements GitHubSource {
  constructor(
    private readonly ctx: RequestContext,
    /** "app" when this process owns the App (SaaS or self-hosted),
     *  "cloud-app" when a self-host proxies through Openship Cloud. */
    readonly mode: GitHubMode = "app",
  ) {}

  // The App's user-status + installations drive connection state, accounts AND
  // home. The source is created once per request, so memoizing them on the
  // instance means each is fetched ONCE — without this, getConnectionStatus
  // alone re-derived state and re-listed installations (a single /github/status
  // fanned into ~3× installations + 2× user-status SaaS round-trips). Every
  // caller below goes through these accessors; never the raw imports.
  private _userStatus?: Promise<GitHubUserStatus>;
  private _installs?: Promise<GitHubInstallation[]>;

  private userStatus(): Promise<GitHubUserStatus> {
    return (this._userStatus ??= getUserStatus(this.ctx.userId, this.ctx));
  }

  private installs(): Promise<GitHubInstallation[]> {
    return (this._installs ??= getUserInstallations(this.ctx));
  }

  // ── Listing ────────────────────────────────────────────────────────────
  /** Repos visible through the App installation for `owner`. */
  async listReposForOwner(owner?: string): Promise<MappedRepository[] | null> {
    if (!owner) {
      const installs = await this.installs();
      if (installs.length === 0) return null;
      return this.listInstallationRepos(installs[0].account.login, installs[0].id);
    }
    return this.listInstallationRepos(owner);
  }

  /** Install-scoped repo listing (the App's `/installation/repositories`).
   *  Pages through the FULL set. GitHub caps `per_page` at 100 and reports the
   *  real `total_count`; a single unpaged request silently dropped repos 101+
   *  (so any "N repositories" count was an undercount of the true total). Loop
   *  until the batch is short or we've collected `total_count`, with a hard
   *  page cap so a misbehaving upstream can never spin forever. */
  private async listInstallationRepos(
    owner: string,
    installationId?: number,
  ): Promise<MappedRepository[]> {
    const token = await getInstallationToken(this.ctx, owner, installationId).catch(() => null);
    if (!token) return [];
    const perPage = 100;
    const MAX_PAGES = 50; // 5000 repos — a safety backstop, never a real limit
    const collected: GitHubRepository[] = [];
    const apiBaseUrl =
      (await resolveGitHubApiBaseUrl(this.ctx.organizationId, owner, installationId)) ??
      "https://api.github.com";
    let total = Infinity;
    for (let page = 1; collected.length < total && page <= MAX_PAGES; page++) {
      const data = await ghFetch<{ total_count?: number; repositories: GitHubRepository[] }>(
        token,
        {
          url: `${apiBaseUrl}/installation/repositories`,
          params: { per_page: perPage, page },
        },
      );
      const batch = data.repositories ?? [];
      collected.push(...batch);
      // Keep `total` at Infinity when total_count is absent — otherwise a full
      // first page would set total=100 and the loop guard (collected < total)
      // would exit before the short-batch break, silently dropping repos 101+.
      // With Infinity, termination falls to the short-batch break / MAX_PAGES.
      total = data.total_count ?? total;
      if (batch.length < perPage) break; // last page
    }
    return mapRepositories(collected).map((r) => ({
      ...r,
      source: "app" as const,
    }));
  }

  // ── Connection status ──────────────────────────────────────────────────
  async getConnectionState(): Promise<GitHubConnectionState> {
    const [status, customConfigured] = await Promise.all([
      this.userStatus(),
      hasActiveGitHubSource(this.ctx.organizationId).catch(() => false),
    ]);
    const connected = customConfigured || (status.connected && status.tokenSource !== "cli");
    let hasInstallations: boolean | undefined;
    if (connected) {
      try {
        hasInstallations = (await this.installs()).length > 0;
      } catch {
        hasInstallations = undefined;
      }
    }
    return {
      sources: {
        openshipApp:
          connected && status.connected && !customConfigured
            ? {
                connected: true,
                login: status.login,
                avatarUrl: status.avatar_url,
                hasInstallations,
              }
            : connected
              ? { connected: true, hasInstallations }
              : { connected: false },
        // No gh on the App source (the SaaS has no gh binary). The merge
        // overlays the real gh side when present.
        ghCli: { available: false },
      },
      primary: connected ? "openship-app" : null,
    };
  }

  async getConnectionStatus(): Promise<GitHubConnectionStatus> {
    const state = await this.getConnectionState();
    if (!state.sources.openshipApp.connected) return { state, accounts: [] };
    try {
      const installs = await this.installs();
      const accounts = mapAccounts(installs).map((a) => ({
        ...a,
        source: "app" as const,
      }));
      return { state, accounts };
    } catch {
      return { state, accounts: [] };
    }
  }

  async getHome(): Promise<GitHubHome> {
    const state = await this.getConnectionState();
    const errors: Record<string, string> = {};
    if (!state.sources.openshipApp.connected) {
      return { state, accounts: [], repos: [] };
    }
    let accounts: MappedAccount[] = [];
    let repos: MappedRepository[] = [];
    try {
      const installs = await this.installs();
      accounts = mapAccounts(installs).map((a) => ({ ...a, source: "app" as const }));
      if (installs.length > 0) {
        const status = await this.userStatus();
        const primary =
          (status.connected && installs.find((i) => i.account.login === status.login)) ||
          installs[0];
        repos = await this.listInstallationRepos(primary.account.login, primary.id);
      }
    } catch (err) {
      errors.app = (err as Error).message;
    }
    return {
      state,
      accounts,
      repos,
      errors: Object.keys(errors).length > 0 ? errors : undefined,
    };
  }

  getUserStatus(): Promise<GitHubUserStatus> {
    return this.userStatus();
  }

  // ── App surface ──────────────────────────────────────────────────────────
  getUserInstallations(): Promise<GitHubInstallation[]> {
    return this.installs();
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

  // ── Token dispatch ───────────────────────────────────────────────────────
  // App source carries no gh — tokenFor's CLOUD_MODE branch (project PAT →
  // user PAT → App installation → OAuth) is the relevant path here. We
  // delegate to the existing dispatcher to keep the per-purpose chain in one
  // audited place.
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
