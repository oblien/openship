import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  appRepos: [] as any[],
  appHome: {} as any,
}));

vi.mock("@repo/platform/engine/modules/github/github.auth", () => ({
  getGitHubAuthMode: () => "app",
  resolveGitHubAuthMode: vi.fn(async () => "app"),
  getGitHubConnectionState: vi.fn(),
  getInstallationId: vi.fn(),
  getInstallationToken: vi.fn(),
  getUserInstallations: vi.fn(),
  getUserStatus: vi.fn(),
  resolveInstallUrl: vi.fn(),
}));
vi.mock("@repo/platform/engine/modules/github/github.service", () => ({ listUserOwnedRepos: vi.fn() }));
vi.mock("@repo/platform/engine/modules/github/github.token", () => ({ tokenFor: vi.fn(), canResolveTokenFor: vi.fn() }));
vi.mock("@repo/platform/engine/modules/github/github.local-auth", () => ({
  getLocalGhToken: vi.fn(),
  getLocalGhStatus: async () => ({ available: true, login: "operator", method: "token" }),
  listLocalGhRepos: async () => ["shared", "cli-only"].map((name) => ({
    full_name: `acme/${name}`, name, owner: { login: "acme" },
  })),
  listLocalGhOrgs: async () => [],
}));
vi.mock("@repo/platform/engine/modules/github/sources/app-source", () => ({
  GitHubAppSource: class {
    mode = "app";
    listReposForOwner() { return Promise.resolve(h.appRepos); }
    getHome() { return Promise.resolve(h.appHome); }
    getConnectionState() { return Promise.resolve(h.appHome.state); }
    getConnectionStatus() {
      return Promise.resolve({ state: h.appHome.state, accounts: h.appHome.accounts });
    }
  },
}));

import { LocalGitHubSource } from "@repo/platform/engine/modules/github/sources/local-source";
import { GhCliSource } from "@repo/platform/engine/modules/github/sources/gh-cli-source";

const repo = (name: string, source: "app" | "cli") => ({
  full_name: `acme/${name}`,
  name,
  owner: "acme",
  description: null,
  html_url: `https://github.com/acme/${name}`,
  private: true,
  visibility: "private",
  default_branch: "main",
  language: null,
  size: 1,
  forks: 0,
  watchers: 0,
  stars: 0,
  license: null,
  created_at: "",
  updated_at: "",
  pushed_at: "",
  source,
});

describe("LocalGitHubSource with an operator-owned App", () => {
  beforeEach(() => {
    h.appRepos = [repo("shared", "app"), repo("app-only", "app")];
    h.appHome = {
      state: {
        sources: { openshipApp: { connected: true }, ghCli: { available: false } },
        primary: "openship-app",
      },
      accounts: [{ login: "acme", id: 1, avatar_url: "", type: "Organization", source: "app" }],
      repos: h.appRepos,
    };
  });

  it.each(["owner", "home"])("deduplicates the %s browser and retains App and CLI coverage", async (view) => {
    const source = new LocalGitHubSource(
      { userId: "u", organizationId: "o" } as any,
      new GhCliSource("u"),
    );

    const repos = view === "owner"
      ? await source.listReposForOwner("acme")
      : (await source.getHome()).repos;

    expect(repos?.map((row) => [row.name, row.source]).sort()).toEqual([
      ["app-only", "app"],
      ["cli-only", "cli"],
      ["shared", "both"],
    ]);
  });
});
