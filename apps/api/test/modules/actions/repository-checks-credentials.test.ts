import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionContext } from "@repo/platform";
import type { GitHubConnectionStatus } from "@repo/platform/engine/modules/github/sources/types";

const h = vi.hoisted(() => ({
  env: { CLOUD_MODE: false, GITHUB_AUTH_MODE: "auto" },
  settings: vi.fn(),
  localToken: vi.fn(),
  mint: vi.fn(),
  oauth: vi.fn(),
  permitted: vi.fn(),
  instanceIdentity: vi.fn(),
  apiBase: vi.fn(),
  status: vi.fn(),
  wire: vi.fn<typeof fetch>(),
}));
vi.mock("@repo/db", () => ({
  repos: { settings: { findByUser: h.settings } },
  db: {},
  schema: {},
  eq: vi.fn(),
  and: vi.fn(),
}));
vi.mock("better-auth/api", () => ({ APIError: class extends Error {} }));
vi.mock("@repo/platform/engine/config/env", () => ({ env: h.env }));
vi.mock("@repo/platform/engine/lib/auth", () => ({ auth: {} }));
vi.mock("@repo/platform/engine/lib/cloud/scope", () => ({ assertCloudTenantScope: vi.fn() }));
vi.mock("@repo/platform/engine/lib/org-actor", () => ({ resolveOrgOwner: vi.fn() }));
vi.mock("@repo/platform/engine/lib/encryption", () => ({ decrypt: (value: string) => value }));
vi.mock("@repo/platform/engine/lib/cache-store/index", () => ({ cacheStore: vi.fn() }));
vi.mock("@repo/platform/engine/modules/github/github-instance-access", () => ({
  mayUseInstanceGitIdentity: h.instanceIdentity,
}));
vi.mock("@repo/platform/engine/modules/github/github-source.service", () => ({
  resolveGitHubApiBaseUrl: h.apiBase,
}));
vi.mock("@repo/platform/engine/modules/github/github-access", () => ({
  canUseGitHubRepo: h.permitted,
  filterAllowedAccounts: async (_ctx: unknown, accounts: unknown[]) => accounts,
}));
vi.mock("@repo/platform/engine/modules/actions/access", () => ({
  authorizeActionRepository: vi.fn(),
}));
vi.mock("@repo/platform/engine/modules/github/sources/index", () => ({
  createGitHubSource: async () => ({ getConnectionStatus: h.status }),
}));

// Exercise the real action setup, githubFetch, tokenFor and HTTP response parsing
// together. Only credential storage/minting, grants and the provider are fixtures.
import { actionRepositoryChecks } from "@repo/platform/engine/modules/actions/repository-checks";
import * as githubAuth from "@repo/platform/engine/modules/github/github.auth";
import * as localAuth from "@repo/platform/engine/modules/github/github.local-auth";

const ctx = { userId: "operator", organizationId: "workspace" } as ExecutionContext;
const input = { owner: "acme", repo: "app", controller: "github" as const };
const connection: GitHubConnectionStatus = {
  state: {
    primary: "gh-cli",
    sources: {
      ghCli: { available: true, login: "octocat", method: "host-cli" },
      openshipApp: { connected: false },
    },
  },
  accounts: [],
};

beforeEach(() => {
  vi.resetAllMocks();
  h.env.CLOUD_MODE = false;
  h.env.GITHUB_AUTH_MODE = "auto";
  h.settings.mockResolvedValue(null);
  h.localToken.mockResolvedValue(null);
  vi.spyOn(localAuth, "getLocalGhToken").mockImplementation(h.localToken);
  h.mint.mockResolvedValue(null);
  h.oauth.mockResolvedValue(null);
  vi.spyOn(githubAuth, "getInstallationToken").mockImplementation(h.mint);
  vi.spyOn(githubAuth, "getUserToken").mockImplementation(h.oauth);
  h.permitted.mockResolvedValue(true);
  h.instanceIdentity.mockResolvedValue(true);
  h.apiBase.mockResolvedValue(null);
  h.status.mockResolvedValue(structuredClone(connection));
  h.wire.mockImplementation(
    async (url) =>
      new Response(
        JSON.stringify(
          String(url).endsWith("/permissions")
            ? { enabled: true }
            : { total_count: 0, runners: [] },
        ),
        { status: 200 },
      ),
  );
  vi.stubGlobal("fetch", h.wire);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("repository Checks uses the execution credential resolver", () => {
  it.each([
    ["self-hosted CLI", false, "cli"],
    ["self-hosted personal token", false, "pat"],
    ["Cloud personal token", true, "pat"],
    ["self-hosted custom App", false, "custom-app"],
    ["self-hosted Cloud-connected App", false, "app"],
    ["Cloud App", true, "app"],
    ["Cloud repository OAuth grant", true, "oauth"],
  ] as const)(
    "verifies %s without allocating a runner or publishing a Check",
    async (_name, cloud, source) => {
      h.env.CLOUD_MODE = cloud;
      const token = `fixture-${source}`;
      const status = structuredClone(connection);
      status.state.sources.ghCli.available = source === "cli";
      if (source === "cli") {
        h.localToken.mockResolvedValue(token);
        h.settings.mockResolvedValue({ ghCliOperatorOptedIn: true });
      } else if (source === "pat") {
        h.settings.mockResolvedValue({ cloneTokenEncrypted: token, cloneTokenAsDefault: true });
        status.state.primary = "personal-token";
        status.state.sources.personalToken = { connected: true, login: "octocat" };
      } else {
        status.state.primary = "openship-app";
        status.state.sources.openshipApp = { connected: true, login: "octocat" };
        if (source === "oauth") h.oauth.mockResolvedValue(token);
        else h.mint.mockResolvedValue(token);
        if (source === "custom-app") {
          // A configured source is authoritative even with an ambient CLI login.
          h.apiBase.mockResolvedValue("https://api.github.com");
          h.localToken.mockResolvedValue("unrelated-host-identity");
          h.settings.mockResolvedValue({ ghCliOperatorOptedIn: true });
        }
      }
      h.status.mockResolvedValue(status);
      const result = await actionRepositoryChecks(ctx, input);
      expect(result).toMatchObject({ status: "connected", repository: "acme/app" });
      expect(JSON.stringify(result)).not.toContain(token);
      expect(h.wire.mock.calls.map(([url]) => String(url))).toEqual([
        "https://api.github.com/repos/acme/app/actions/permissions",
        "https://api.github.com/repos/acme/app/actions/runners?per_page=1",
      ]);
      for (const [, request] of h.wire.mock.calls) {
        expect(request?.method).toBe("GET");
        expect(new Headers(request?.headers).get("authorization")).toBe(`Bearer ${token}`);
      }
      if (cloud || source === "custom-app") expect(h.localToken).not.toHaveBeenCalled();
      if (source.endsWith("app"))
        expect(h.mint).toHaveBeenCalledWith(ctx, "acme", undefined, { repositories: ["app"] });
    },
  );

  it("offers access setup for a detected but unapproved CLI login, then succeeds after explicit selection", async () => {
    h.localToken.mockResolvedValue("fixture-cli");
    expect(await actionRepositoryChecks(ctx, input)).toMatchObject({ status: "access_required" });
    expect(h.wire).not.toHaveBeenCalled();
    expect(h.localToken).not.toHaveBeenCalled();
    h.settings.mockResolvedValue({ ghCliOperatorOptedIn: true });
    expect(await actionRepositoryChecks(ctx, input)).toMatchObject({ status: "connected" });
    expect(h.wire).toHaveBeenCalledTimes(2);
  });

  it("does not borrow the operator's CLI or App for a member without management access", async () => {
    h.permitted.mockResolvedValue(false);
    h.settings.mockResolvedValue({ ghCliOperatorOptedIn: true });
    h.localToken.mockResolvedValue("fixture-cli");
    h.mint.mockResolvedValue("fixture-app");
    expect(await actionRepositoryChecks(ctx, input)).toMatchObject({ status: "access_required" });
    expect(h.wire).not.toHaveBeenCalled();
    expect(h.mint).not.toHaveBeenCalled();
    expect(h.localToken).not.toHaveBeenCalled();
  });

  it("keeps the Cloud host identity unavailable even if a CLI login exists", async () => {
    h.env.CLOUD_MODE = true;
    h.env.GITHUB_AUTH_MODE = "cli";
    h.localToken.mockResolvedValue("cloud-host-secret");
    h.settings.mockResolvedValue({ ghCliOperatorOptedIn: true });
    expect(await actionRepositoryChecks(ctx, input)).toMatchObject({ status: "access_required" });
    expect(h.localToken).not.toHaveBeenCalled();
    expect(h.wire).not.toHaveBeenCalled();
  });

  it("keeps rate limits retryable without switching credentials", async () => {
    h.settings.mockResolvedValue({ ghCliOperatorOptedIn: true });
    h.localToken.mockResolvedValue("fixture-cli");
    h.mint.mockResolvedValue("fixture-app");
    h.wire.mockImplementation(
      async () =>
        new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
          status: 403,
          headers: { "x-ratelimit-remaining": "0" },
        }),
    );
    expect(await actionRepositoryChecks(ctx, input)).toMatchObject({ status: "unavailable" });
    expect(h.mint).not.toHaveBeenCalled();
  });
});
