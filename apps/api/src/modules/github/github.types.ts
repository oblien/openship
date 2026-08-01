/**
 * GitHub types - shared interfaces for the entire GitHub module.
 */

// ─── GitHub API response shapes ──────────────────────────────────────────────

export interface GitHubUser {
  login: string;
  id: number;
  avatar_url: string;
  html_url: string;
  type: "User" | "Organization";
  name?: string;
  email?: string;
}

export interface GitHubRepository {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string; id: number; avatar_url: string };
  private: boolean;
  visibility: string;
  html_url: string;
  clone_url: string;
  ssh_url: string;
  default_branch: string;
  description: string | null;
  language: string | null;
  size: number;
  forks: number;
  watchers: number;
  stargazers_count: number;
  license: unknown;
  created_at: string;
  updated_at: string;
  pushed_at: string;
}

export interface GitHubBranch {
  name: string;
  commit: { sha: string; url: string };
  protected: boolean;
}

export interface GitHubInstallation {
  id: number;
  account: {
    login: string;
    id: number;
    avatar_url: string;
    type: "User" | "Organization";
  };
  app_id: number;
  target_type: string;
  permissions: Record<string, string>;
  events: string[];
}

export interface GitHubWebhook {
  id: number;
  active: boolean;
  events: string[];
  config: { url: string; content_type: string };
}

export interface GitHubFileContent {
  name: string;
  path: string;
  sha: string;
  size: number;
  type: "file" | "dir";
  content?: string; // base64-encoded
  encoding?: string;
  download_url: string | null;
}

export interface GitHubTreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
  url: string;
}

export interface GitHubTreeResponse {
  sha: string;
  truncated: boolean;
  tree: GitHubTreeEntry[];
}

export interface GitHubCheckRun {
  id: number;
  status: string;
  conclusion: string | null;
}

// ─── Push webhook payload ────────────────────────────────────────────────────

export interface GitHubPushCommit {
  id: string;
  message: string;
  timestamp: string;
  url: string;
  author: { name: string; email: string; username?: string };
  committer: { name: string; email: string; username?: string };
  added: string[];
  removed: string[];
  modified: string[];
}

export interface GitHubPushPayload {
  ref: string;
  deleted?: boolean;
  forced?: boolean;
  /** Commit SHA the ref pointed at before the push. */
  before?: string;
  /** Commit SHA the ref points at after the push. */
  after?: string;
  /**
   * GitHub clamps this list to 20 commits per push event. When a single
   * push contained more than 20 commits the caller must use
   * `repos.compareCommits(before, after)` to enumerate every change.
   */
  commits?: GitHubPushCommit[];
  head_commit: GitHubPushCommit | null;
  repository: {
    name: string;
    full_name: string;
    default_branch?: string;
    owner: { login: string; id: number };
  };
  sender: { id: number; login: string };
  hook_id?: number;
  /**
   * Present ONLY on GitHub App deliveries — absent on legacy per-repo webhook
   * deliveries. Identifies the App installation that delivered this push (i.e.
   * the org that installed the App on the repo). Used to bind the auto-deploy
   * fan-out to the owning tenant so a repo-string collision across tenants
   * can't cross-trigger (webhook-push.ts triggerBranchDeployments).
   */
  installation?: { id: number };
}

// ─── Check run webhook payload ───────────────────────────────────────────────

export interface GitHubCheckRunPayload {
  action: "created" | "completed" | "rerequested" | "requested_action";
  check_run: {
    id: number;
    name: string;
    head_sha: string;
    status: string;
    conclusion: string | null;
    html_url?: string;
  };
  repository: {
    name: string;
    full_name: string;
    default_branch?: string;
    owner: { login: string; id: number };
  };
  sender: { id: number; login: string };
}

// ─── Installation webhook payload ────────────────────────────────────────────

export interface GitHubInstallationPayload {
  action: "created" | "deleted" | "suspend" | "unsuspend";
  installation: GitHubInstallation;
  sender: { id: number; login: string };
}

// ─── Mapped types for API responses ──────────────────────────────────────────

export interface MappedRepository {
  full_name: string;
  name: string;
  owner: string;
  description: string | null;
  html_url: string;
  private: boolean;
  visibility: string;
  default_branch: string;
  language: string | null;
  size: number;
  forks: number;
  watchers: number;
  stars: number;
  license: unknown;
  created_at: string;
  updated_at: string;
  pushed_at: string;
  /**
   * Where openship learned about this repo:
   *   - "app"  → covered by a GitHub App installation. Deployable anywhere
   *              (local + remote) via short-lived install tokens.
   *   - "cli"  → seen by the local `gh` CLI but NOT covered by an App
   *              installation. Deployable for LOCAL builds only; remote
   *              builds will be refused by clone-auth.
   *   - "both" → visible to both. Same capabilities as "app".
   *
   * Used by the dashboard repo picker to render a "Local builds only"
   * chip + install-App-on-this-owner prompt where appropriate.
   * Undefined in SaaS mode (App is the only source).
   */
  source?: "app" | "cli" | "both";
}

export interface MappedAccount {
  login: string;
  id: number;
  avatar_url: string;
  type: string;
  /**
   * Where this account came from. Critical for telling the dashboard which
   * accounts represent real GitHub App installations vs gh CLI org
   * memberships — they look identical otherwise, and the settings card
   * MUST NOT claim the App is connected to a CLI-only org. Without an
   * explicit source, callers must assume "cli" and gate any App claims
   * behind state.sources.openshipApp.connected.
   *
   *  - "app" → real GitHub App installation (deployable anywhere via
   *            short-lived install tokens)
   *  - "cli" → gh CLI org membership (local-only via clone-auth.ts; the
   *            App may not be installed on this owner at all)
   */
  source?: "app" | "cli";
}

export interface RepositoryDetail {
  id: number;
  name: string;
  full_name: string;
  owner: string;
  private: boolean;
  default_branch: string;
  clone_url: string;
  ssh_url: string;
  html_url: string;
  branches?: GitHubBranch[];
}

// ─── Canonical GitHub connection state ───────────────────────────────────────
//
// SINGLE SOURCE OF TRUTH. Everything that asks "is GitHub connected?" or
// "which source should we use?" reads this shape, computed once by
// getGitHubConnectionState(userId) in github.auth.ts.
//
// What's NOT here on purpose:
//   - `mode` / "saas-app" / "self-hosted" — that's `env.CLOUD_MODE` /
//     `platform()` on the backend and `selfHosted` from PlatformContext on
//     the frontend. The global platform mode owns that concept; this
//     interface doesn't duplicate it.
//   - `tokenSource` / "app"|"oauth"|"cli"|"token"|"cloud-app" — those
//     were internal token-strategy details that leaked to the wire.
//     The new wire shape only carries USER-VISIBLE concepts (which source
//     is connected, which one's primary).
//
// `primary` is the resolved priority pick that listings + cloning use.
// `null` means no source can hand out a token at all.

export interface GitHubConnectionState {
  sources: {
    /** Openship GitHub App. In SaaS mode this is the local installation;
     *  in self-hosted+cloud-connected this is the cloud-proxied install. */
    openshipApp: {
      connected: boolean;
      login?: string;
      avatarUrl?: string;
      /** Set when at least one App installation exists. Used to render
       *  the install-on-this-org affordance in the dashboard. */
      hasInstallations?: boolean;
    };
    /** gh CLI on the API host. Always { available: false } on the SaaS
     *  server (there's no `gh` there). On self-hosted it reflects the
     *  result of `gh auth token` + a /user verify, gated by the per-user
     *  cli_excluded_from_listing flag. */
    ghCli: {
      available: boolean;
      login?: string;
      avatarUrl?: string;
      /**
       * HOW this identity was established, so the UI can name it correctly:
       *   "host-cli" → probed off the host's own `gh` login
       *   "device"   → browser device sign-in, completed in Openship
       *   "token"    → operator pasted a PAT into Openship
       * Everything used to render as "gh CLI" regardless. Also decides whether
       * the library's first-run consent prompt applies — only "host-cli" is a
       * pre-existing credential the operator didn't hand over here.
       *
       * Set on the `available: false` branch too, when a credential exists but
       * failed its check (see `problem`).
       */
      method?: "host-cli" | "device" | "token";
      /**
       * Set ONLY when a credential is stored but unusable — the difference
       * between "nothing connected" and "what you connected stopped working".
       * Without it both states rendered as the connect chooser, so a revoked
       * token looked identical to a fresh install while clones kept failing.
       *
       *   "rejected"    → GitHub returned 401/403. Reconnect.
       *   "unreachable" → no answer from GitHub; the credential may be fine.
       */
      problem?: "rejected" | "unreachable";
      /** ISO timestamp of the last verify against GitHub. */
      checkedAt?: string;
    };
  };
  /**
   * Which source listings + cloning prefer. The priority is:
   *   1. openship-app (when connected) — safest, short-lived install tokens
   *   2. gh-cli (when available) — local builds only
   *   3. null — nothing connected
   *
   * `null` is the "show the connect prompt" signal.
   */
  primary: "openship-app" | "gh-cli" | null;
}
