import { beforeEach, describe, expect, it, vi } from "vitest";

// Pin-down tests for the listing-source dispatch, now resolved by
// createGitHubSource(ctx) → LocalGitHubSource (gh-FIRST → App → user-token).
// They lock the per-source behavior (gh-cli / App installations / user-token)
// so a future change to the dispatch can't silently regress one source.

const {
  resolveGitHubAuthMode,
  getUserStatus,
  getUserInstallations,
  getInstallationToken,
  githubFetch,
} = vi.hoisted(() => ({
  resolveGitHubAuthMode: vi.fn(),
  getUserStatus: vi.fn(),
  getUserInstallations: vi.fn(),
  getInstallationToken: vi.fn(),
  githubFetch: vi.fn(),
}));

const { ghFetch } = vi.hoisted(() => ({ ghFetch: vi.fn() }));

const { getLocalGhToken, listLocalGhRepos } = vi.hoisted(() => ({
  getLocalGhToken: vi.fn(),
  listLocalGhRepos: vi.fn(),
}));

const { isGithubCliDisabled } = vi.hoisted(() => ({
  isGithubCliDisabled: vi.fn(),
}));

vi.mock("../../../src/modules/github/github.auth", () => ({
  githubFetch,
  resolveGitHubAuthMode,
  getUserStatus,
  getUserInstallations,
  getInstallationToken,
  getGitHubConnectionState: vi.fn(),
  mapAccounts: vi.fn(),
  getGitHubAuthMode: vi.fn(),
}));

vi.mock("../../../src/modules/github/github.http", () => ({
  ghFetch,
  ghFetchSoft: vi.fn(),
}));

vi.mock("../../../src/modules/github/github.local-auth", () => ({
  getLocalGhToken,
  listLocalGhRepos,
  listLocalGhOrgs: vi.fn(),
  getLocalGhStatus: vi.fn(),
}));

vi.mock("../../../src/modules/settings/settings.service", () => ({
  isGithubCliDisabled,
}));

// env: {} → CLOUD_MODE is falsy, so createGitHubSource takes the LOCAL branch
// (GhCliSource + LocalGitHubSource) — exactly the merge these tests exercise.
vi.mock("../../../src/config/env", () => ({
  env: {},
  runtimeTarget: { id: "local" },
}));

import { createGitHubSource } from "../../../src/modules/github/sources";
// Pre-warm the lazily `await import`-ed source modules (+ their heavy
// github.service dependency) at collection time, so createGitHubSource's
// internal dynamic imports hit a warm cache. Otherwise the first call's cold
// transform can exceed the per-test timeout under full-suite contention.
import "../../../src/modules/github/sources/gh-cli-source";
import "../../../src/modules/github/sources/local-source";
import "../../../src/modules/github/sources/app-source";

const ctx = { userId: "user-1", organizationId: "org-1" } as never;

// ctx is bound at construction now; owner is the only method arg.
const call = async (owner?: string) => (await createGitHubSource(ctx)).listReposForOwner(owner);

function raw(fullName: string) {
  return { full_name: fullName, name: fullName.split("/")[1], owner: { login: fullName.split("/")[0] } };
}

beforeEach(() => {
  resolveGitHubAuthMode.mockReset();
  getUserStatus.mockReset();
  getUserInstallations.mockReset();
  getInstallationToken.mockReset();
  ghFetch.mockReset();
  githubFetch.mockReset();
  getLocalGhToken.mockReset();
  listLocalGhRepos.mockReset();
  isGithubCliDisabled.mockReset().mockResolvedValue(false);
});

describe("listReposForOwner — source dispatch", () => {
  describe("user-token (oauth/cli/token mode)", () => {
    it("lists org repos via /orgs/{owner}/repos when owner is not the user", async () => {
      resolveGitHubAuthMode.mockResolvedValue("oauth");
      getUserStatus.mockResolvedValue({ connected: true, login: "me" });
      githubFetch.mockResolvedValue([raw("acme/site")]);

      const repos = await call("acme");

      expect(repos).toHaveLength(1);
      expect(repos?.[0].full_name).toBe("acme/site");
      expect(githubFetch).toHaveBeenCalledWith(
        expect.objectContaining({ url: expect.stringContaining("/orgs/acme/repos") }),
      );
    });

    it("lists the user's own repos via /user/repos when owner === login", async () => {
      resolveGitHubAuthMode.mockResolvedValue("oauth");
      getUserStatus.mockResolvedValue({ connected: true, login: "me" });
      githubFetch.mockResolvedValue([raw("me/dotfiles")]);

      await call("me");

      expect(githubFetch).toHaveBeenCalledWith(
        expect.objectContaining({ url: expect.stringContaining("/user/repos") }),
      );
    });
  });

  describe("installations (App connected)", () => {
    it("lists the primary installation's repos via the install token + install-scoped endpoint", async () => {
      resolveGitHubAuthMode.mockResolvedValue("cloud-app");
      getUserStatus.mockResolvedValue({ connected: true, login: "me" });
      getUserInstallations.mockResolvedValue([{ account: { login: "acme" }, id: 42 }]);
      // App-installation token (cloud-minted in cloud-app) used against the
      // install-scoped endpoint — NOT the user-OAuth endpoint, which has no
      // local token in cloud-app mode.
      getInstallationToken.mockResolvedValue("ghs_install_token");
      ghFetch.mockResolvedValue({ repositories: [raw("acme/site")] });

      const repos = await call();

      expect(repos).toHaveLength(1);
      expect(repos?.[0].full_name).toBe("acme/site");
      expect(getInstallationToken).toHaveBeenCalledWith(ctx, "acme", 42);
      expect(ghFetch).toHaveBeenCalledWith(
        "ghs_install_token",
        expect.objectContaining({ url: expect.stringContaining("/installation/repositories") }),
      );
    });

    it("returns null (→ caller 400) when the user has no installations", async () => {
      resolveGitHubAuthMode.mockResolvedValue("cloud-app");
      getUserStatus.mockResolvedValue({ connected: true, login: "me" });
      getUserInstallations.mockResolvedValue([]);

      // No-owner + no-installations is the one case that still yields null.
      expect(await call()).toBeNull();
    });
  });

  describe("gh-cli fallback (App mode, SaaS GitHub NOT connected)", () => {
    it("lists + filters gh CLI repos by owner when a gh token is present", async () => {
      resolveGitHubAuthMode.mockResolvedValue("cloud-app");
      getUserStatus.mockResolvedValue({ connected: false });
      getLocalGhToken.mockResolvedValue("gho_token");
      listLocalGhRepos.mockResolvedValue([raw("acme/site"), raw("other/lib")]);

      const repos = await call("acme");

      expect(repos).toHaveLength(1);
      expect(repos?.[0].full_name).toBe("acme/site");
      expect(githubFetch).not.toHaveBeenCalled();
    });

    it("does not reuse the instance credential after this user disconnects it", async () => {
      isGithubCliDisabled.mockResolvedValue(true);
      resolveGitHubAuthMode.mockResolvedValue("cloud-app");
      getUserStatus.mockResolvedValue({ connected: false });
      getLocalGhToken.mockResolvedValue("gho_token");
      getInstallationToken.mockResolvedValue(null);

      expect(await call("acme")).toEqual([]);
      expect(getLocalGhToken).not.toHaveBeenCalled();
      expect(listLocalGhRepos).not.toHaveBeenCalled();
    });

    it("returns [] when no gh token and the App install yields no token", async () => {
      // No gh token → the merge falls through to the App source. With an owner
      // given, it hits listInstallationRepos(owner) directly; no install token
      // → []. (Owner-scoped calls no longer return null — only the no-owner +
      // no-installations case does, above.)
      resolveGitHubAuthMode.mockResolvedValue("cloud-app");
      getUserStatus.mockResolvedValue({ connected: false });
      getLocalGhToken.mockResolvedValue(null);
      getInstallationToken.mockResolvedValue(null);

      expect(await call("acme")).toEqual([]);
    });
  });
});
