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

import { ghFetch } from "../github.http";
import {
  getInstallationId,
  getInstallationToken,
  getUserInstallations,
  getUserStatus,
  resolveInstallUrl,
} from "../github.auth";
import { tokenFor, canResolveTokenFor } from "../github.token";
import type {
  GitHubPurpose,
  GitHubTokenSource,
  TokenContext,
  TokenResult,
} from "../github.token";
import { mapAccounts, mapRepositories } from "./mappers";
import type { RequestContext } from "../../../lib/request-context";
import type {
  GitHubConnectionState,
  GitHubInstallation,
  GitHubRepository,
  MappedAccount,
  MappedRepository,
} from "../github.types";
import type {
  GitHubConnectionStatus,
  GitHubHome,
  GitHubInstallUrl,
  GitHubMode,
  GitHubSource,
  GitHubUserStatus,
} from "./types";

export class GitHubAppSource implements GitHubSource {
  constructor(
    private readonly ctx: RequestContext,
    /** "app" on the SaaS, "cloud-app" in local+cloud mode. */
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
    return (this._userStatus ??= getUserStatus(this.ctx.userId));
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

  /** Install-scoped repo listing (the App's `/installation/repositories`). */
  private async listInstallationRepos(
    owner: string,
    installationId?: number,
  ): Promise<MappedRepository[]> {
    const token = await getInstallationToken(this.ctx, owner, installationId).catch(
      () => null,
    );
    if (!token) return [];
    const perPage = 100;
    const repositories: GitHubRepository[] = [];
    for (let page = 1; page <= 100; page++) {
      const data = await ghFetch<{ total_count?: number; repositories?: GitHubRepository[] }>(
        token,
        {
          url: "https://api.github.com/installation/repositories",
          params: { per_page: perPage, page },
        },
      );
      const batch = data.repositories ?? [];
      repositories.push(...batch);
      const total = data.total_count ?? repositories.length;
      if (batch.length < perPage || repositories.length >= total) {
        break;
      }
    }
    return mapRepositories(repositories).map((r) => ({
      ...r,
      source: "app" as const,
    }));
  }

  // ── Connection status ──────────────────────────────────────────────────
  async getConnectionState(): Promise<GitHubConnectionState> {
    const status = await this.userStatus();
    const connected = status.connected && status.tokenSource !== "cli";
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
        openshipApp: connected && status.connected
          ? {
              connected: true,
              login: status.login,
              avatarUrl: status.avatar_url,
              hasInstallations,
            }
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
          (status.connected &&
            installs.find((i) => i.account.login === status.login)) ||
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
