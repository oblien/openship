/**
 * GitHubSource — the adapter interface for GitHub source selection.
 *
 * ONE interface, three concrete shapes, ONE resolver (see ./index.ts):
 *   - GitHubAppSource   (./app-source.ts)   — pure GitHub App, ZERO gh-CLI.
 *                        Token/data via an injected AppBackend:
 *                        LocalAppBackend (SaaS, local key-mint) or
 *                        CloudAppBackend (local mode, SaaS-proxied — "token
 *                        from cloud").
 *   - GhCliSource       (./gh-cli-source.ts)— pure local gh-CLI, ZERO App/cloud.
 *   - LocalGitHubSource (./local-source.ts) — the MERGE, local only: composes
 *                        an optional gh sub-source + an optional App sub-source
 *                        + a user-token fallback. Listing is gh-first; the
 *                        clone token is App/cloud-first.
 *
 * The SaaS uses GitHubAppSource directly (no gh, no merge); the gh-CLI module
 * is never imported in CLOUD_MODE.
 *
 * The adapter binds RequestContext at construction (like the runtime adapters
 * bind their client) — capability methods don't re-take ctx. This is the
 * single place source selection lives, replacing the scattered
 * resolveGitHubAuthMode → getUserStatus → resolveListingSource → tokenFor.
 */

import type {
  GitHubConnectionState,
  GitHubInstallation,
  MappedAccount,
  MappedRepository,
} from "@repo/contracts";
import type {
  GitHubPurpose,
  GitHubTokenSource,
  TokenContext,
  TokenResult,
} from "@repo/platform/engine/modules/github/github.token";

/** The connection mode this source was selected for. */
export type GitHubMode = "app" | "cloud-app" | "cli" | "oauth" | "token";

/** Result of getUserStatus — connected profile or the disconnected sentinel. */
export type GitHubUserStatus =
  | { connected: false; tokenSource: null }
  | {
      connected: true;
      tokenSource: string;
      oauthConnected?: boolean;
      login: string;
      id: number;
      avatar_url: string;
    };

/** What getUserHome / the /github/home endpoint returns. */
export interface GitHubHome {
  state: GitHubConnectionState;
  accounts: MappedAccount[];
  repos: MappedRepository[];
  errors?: Record<string, string>;
}

/** What getConnectionStatus / the /github/status endpoint returns. */
export interface GitHubConnectionStatus {
  state: GitHubConnectionState;
  accounts: MappedAccount[];
}

/** Resolved install URL + cloud-reachability for the connect affordance. */
export interface GitHubInstallUrl {
  url: string;
  state: string;
  cloudUnreachable?: boolean;
}

/**
 * The source adapter. Implementations: GitHubAppSource, GhCliSource,
 * LocalGitHubSource. Constructed by createGitHubSource(ctx) in ./index.ts.
 */
export interface GitHubSource {
  readonly mode: GitHubMode;

  // ── Listing (gh-first where a gh sub-source is present) ──
  /** Repos for an owner (or the user's own when omitted). null = no usable
   *  source (caller maps to 400); [] = source exists, owner has none. */
  listReposForOwner(owner?: string): Promise<MappedRepository[] | null>;
  /** The dashboard library view: connection state + accounts + repos. */
  getHome(): Promise<GitHubHome>;

  // ── Connection status (Settings card) ──
  getConnectionState(): Promise<GitHubConnectionState>;
  /** state + the App's installation accounts (probes cloud for the App side). */
  getConnectionStatus(): Promise<GitHubConnectionStatus>;
  getUserStatus(): Promise<GitHubUserStatus>;

  // ── GitHub App surface ──
  getUserInstallations(status?: GitHubUserStatus): Promise<GitHubInstallation[]>;
  getInstallationId(owner: string): Promise<number | null>;
  getInstallationToken(owner: string, installationId?: number): Promise<string | null>;
  resolveInstallUrl(): Promise<GitHubInstallUrl>;

  // ── Token dispatch (clone / generic API) ──
  // Per-capability order lives in the implementation: listing is gh-first,
  // clone ("remote") refuses gh and is App/cloud-first.
  tokenFor(purpose: GitHubPurpose, tokenCtx?: TokenContext): Promise<TokenResult | null>;
  canResolveTokenFor(
    purpose: GitHubPurpose,
    tokenCtx?: TokenContext,
  ): Promise<GitHubTokenSource | null>;
}
