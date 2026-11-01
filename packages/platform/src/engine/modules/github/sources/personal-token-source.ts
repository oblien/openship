/**
 * Adds the current user's saved token to the existing App/local source.
 * Credential selection stays in tokenFor; App installation ownership and
 * OAuth completion stay with the underlying source. No host identity is used.
 */
import { observedAllSettled } from "@repo/core/diagnostics";
import type {
  GitHubConnectionState,
  GitHubRepository,
  GitHubUser,
  MappedAccount,
  MappedRepository,
} from "@repo/contracts";
import type { ExecutionContext } from "@repo/platform";
import { ghFetch } from "../github.http";
import { listUserRepositories } from "../github.service";
import { resolveGitHubApiBaseUrl } from "../github-source.service";
import type { GitHubPurpose, TokenContext } from "../github.token";
import { mapRepositories, mergeRepositorySources } from "./mappers";
import type { GitHubConnectionStatus, GitHubHome, GitHubSource } from "./types";

const emptyState = (): GitHubConnectionState => ({
  sources: { openshipApp: { connected: false }, ghCli: { available: false } },
  primary: null,
});

export class PersonalTokenGitHubSource implements GitHubSource {
  readonly mode;
  private profilePromise?: Promise<GitHubUser>;
  private reposPromise?: Promise<GitHubRepository[]>;
  private readonly owners = new Map<string, Promise<boolean>>();

  constructor(
    private readonly ctx: ExecutionContext,
    private readonly base: GitHubSource,
    /** Resolved once by tokenFor(ctx, "local", { only: ["user-pat"] }). */
    private readonly token: string,
  ) {
    this.mode = base.mode;
  }

  private profile(): Promise<GitHubUser> {
    return (this.profilePromise ??= ghFetch<GitHubUser>(this.token, {
      url: "https://api.github.com/user",
    }));
  }

  private githubComOwner(owner: string): Promise<boolean> {
    const key = owner.toLowerCase();
    let allowed = this.owners.get(key);
    if (!allowed) {
      // A same-named Enterprise owner is a different namespace. Its repository
      // reads/clones use the configured App; never mix github.com results in.
      allowed = resolveGitHubApiBaseUrl(this.ctx.organizationId, owner).then(
        (base) => !base || base.replace(/\/+$/, "") === "https://api.github.com",
      );
      this.owners.set(key, allowed);
    }
    return allowed;
  }

  private repositories(): Promise<GitHubRepository[]> {
    return (this.reposPromise ??= (async () => {
      const repos = await listUserRepositories(this.ctx, this.token);
      const owners = [...new Set(repos.map((r) => r.owner.login.toLowerCase()))];
      const allowed = new Set(
        (
          await Promise.all(
            owners.map(async (owner) => ((await this.githubComOwner(owner)) ? owner : null)),
          )
        ).filter((owner) => owner !== null),
      );
      return repos.filter((r) => allowed.has(r.owner.login.toLowerCase()));
    })());
  }

  private state(
    base: GitHubConnectionState,
    profile: PromiseSettledResult<GitHubUser>,
  ): GitHubConnectionState {
    const personalToken: NonNullable<GitHubConnectionState["sources"]["personalToken"]> =
      profile.status === "fulfilled"
        ? { connected: true, login: profile.value.login, avatarUrl: profile.value.avatar_url }
        : {
            connected: false,
            problem: profile.reason?.credentialRejected === true ? "rejected" : "unreachable",
          };
    return {
      sources: { ...base.sources, personalToken },
      // Local browsing keeps its host identity priority. An enabled user token
      // is the default on Cloud, just as it is in the canonical clone chain.
      primary:
        personalToken.connected && base.primary !== "gh-cli" ? "personal-token" : base.primary,
    };
  }

  private accounts(
    base: MappedAccount[],
    users: Array<Pick<GitHubUser, "login" | "id" | "avatar_url"> & { type?: string }>,
  ): MappedAccount[] {
    const accounts = new Map(base.map((a) => [a.login.toLowerCase(), a]));
    for (const user of users) {
      if (!accounts.has(user.login.toLowerCase())) {
        accounts.set(user.login.toLowerCase(), {
          login: user.login,
          id: user.id,
          avatar_url: user.avatar_url,
          type: user.type ?? "User",
          source: "token",
        });
      }
    }
    return [...accounts.values()];
  }

  async getConnectionState(): Promise<GitHubConnectionState> {
    const [base, profile] = await observedAllSettled([
      this.base.getConnectionState(),
      this.profile(),
    ], "platform/engine/modules/github/sources/personal-token-source");
    return this.state(base.status === "fulfilled" ? base.value : emptyState(), profile);
  }

  async getConnectionStatus(): Promise<GitHubConnectionStatus> {
    const [base, profile] = await observedAllSettled([
      this.base.getConnectionStatus(),
      this.profile(),
    ], "platform/engine/modules/github/sources/personal-token-source");
    return {
      state: this.state(base.status === "fulfilled" ? base.value.state : emptyState(), profile),
      accounts: this.accounts(
        base.status === "fulfilled" ? base.value.accounts : [],
        profile.status === "fulfilled" && (await this.githubComOwner(profile.value.login))
          ? [profile.value]
          : [],
      ),
    };
  }

  async getHome(): Promise<GitHubHome> {
    const [base, profile, repos] = await observedAllSettled([
      this.base.getHome(),
      this.profile(),
      this.repositories(),
    ], "platform/engine/modules/github/sources/personal-token-source");
    const home =
      base.status === "fulfilled" ? base.value : { state: emptyState(), accounts: [], repos: [] };
    const errors = { ...home.errors };
    if (base.status === "rejected")
      errors.source =
        "Could not load repositories from the other GitHub connection. Retry or check its connection in Settings → Git.";
    if (profile.status === "rejected" || repos.status === "rejected") {
      errors.token =
        "Could not load repositories with your personal token. Retry or check its access in Settings → Git.";
    }
    const tokenRepos = repos.status === "fulfilled" ? repos.value : [];
    return {
      state: this.state(home.state, profile),
      accounts: this.accounts(home.accounts, [
        ...(profile.status === "fulfilled" && (await this.githubComOwner(profile.value.login))
          ? [profile.value]
          : []),
        ...tokenRepos.map((r) => r.owner),
      ]),
      repos: mergeRepositorySources(
        home.repos,
        mapRepositories(tokenRepos).map((r) => ({ ...r, source: "token" })),
      ),
      ...(Object.keys(errors).length ? { errors } : {}),
    };
  }

  async listReposForOwner(owner?: string): Promise<MappedRepository[] | null> {
    if (owner && !(await this.githubComOwner(owner))) return this.base.listReposForOwner(owner);
    const [base, personal] = await observedAllSettled([
      this.base.listReposForOwner(owner),
      this.repositories(),
    ], "platform/engine/modules/github/sources/personal-token-source");
    const repos =
      personal.status === "fulfilled"
        ? mapRepositories(personal.value)
            .filter((r) => !owner || r.owner.toLowerCase() === owner.toLowerCase())
            .map((r): MappedRepository => ({ ...r, source: "token" }))
        : [];
    const merged = mergeRepositorySources(
      base.status === "fulfilled" ? (base.value ?? []) : [],
      repos,
    );
    if (!merged.length) {
      if (personal.status === "rejected") throw personal.reason;
      if (base.status === "rejected") throw base.reason;
    }
    return merged;
  }

  // These primitives must keep their App/OAuth meaning. A personal token does
  // not complete an installation callback or grant access to an App token.
  getUserStatus() {
    return this.base.getUserStatus();
  }
  getUserInstallations() {
    return this.base.getUserInstallations();
  }
  getInstallationId(owner: string) {
    return this.base.getInstallationId(owner);
  }
  getInstallationToken(owner: string, id?: number) {
    return this.base.getInstallationToken(owner, id);
  }
  resolveInstallUrl() {
    return this.base.resolveInstallUrl();
  }
  tokenFor(purpose: GitHubPurpose, context: TokenContext = {}) {
    return this.base.tokenFor(purpose, context);
  }
  canResolveTokenFor(purpose: GitHubPurpose, context: TokenContext = {}) {
    return this.base.canResolveTokenFor(purpose, context);
  }
}
