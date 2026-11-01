import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@repo/core";
import type { ExecutionContext } from "../../../context";
import type { GitHubConnectionStatus } from "../github/sources/types";

const h = vi.hoisted(() => ({
  status: vi.fn(),
  authorize: vi.fn(),
  filter: vi.fn(),
  mint: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("../github/sources/index", () => ({
  createGitHubSource: async () => ({ getConnectionStatus: h.status }),
}));
vi.mock("../github/github.auth", () => ({ getInstallationToken: h.mint, githubFetch: h.fetch }));
vi.mock("../github/github-access", () => ({ filterAllowedAccounts: h.filter }));
vi.mock("./access", () => ({ authorizeActionRepository: h.authorize }));
import { GitHubApiError } from "../github/github.error";
import { GitHubAppApiError } from "../github/github.app-client";
import { actionRepositoryChecks } from "./repository-checks";

const ctx = { userId: "operator", organizationId: "team" } as ExecutionContext;
const input = { owner: "acme", repo: "app", controller: "github" as const };
const connection: GitHubConnectionStatus = {
  state: {
    primary: "gh-cli",
    sources: {
      openshipApp: { connected: false },
      ghCli: {
        available: true,
        login: "octocat",
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
      },
    },
  },
  accounts: [],
};
beforeEach(() => {
  vi.resetAllMocks();
  h.status.mockResolvedValue(structuredClone(connection));
  h.filter.mockImplementation(async (_ctx, accounts) => accounts);
  h.authorize.mockResolvedValue(undefined);
  h.mint.mockResolvedValue(null);
  h.fetch.mockImplementation(async ({ url }) =>
    url.endsWith("/permissions") ? { enabled: true } : { total_count: 0, runners: [] },
  );
});

describe("repository Checks setup", () => {
  it("checks repository Actions and runner access without publishing Checks or allocating runners", async () => {
    const result = await actionRepositoryChecks(ctx, input);
    expect(result).toMatchObject({
      repository: "acme/app",
      status: "connected",
      account: { login: "octocat", kind: "account" },
    });
    expect(h.authorize).toHaveBeenCalledWith(ctx, "acme", "app");
    expect(h.fetch.mock.calls.map(([request]) => request.url)).toEqual([
      "https://api.github.com/repos/acme/app/actions/permissions",
      "https://api.github.com/repos/acme/app/actions/runners",
    ]);
    for (const [request] of h.fetch.mock.calls)
      expect(request).toMatchObject({ ctx, owner: "acme", repo: "app", authorizeAs: "write" });
    expect(h.mint).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("token");
  });
  it("does not infer access from a login or bypass a repository grant", async () => {
    h.authorize.mockRejectedValue(new AppError("Forbidden", 403));
    expect(await actionRepositoryChecks(ctx, input)).toMatchObject({ status: "access_required" });
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.mint).not.toHaveBeenCalled();
  });
  it("keeps disconnected accounts distinct from available public repositories", async () => {
    h.status.mockResolvedValue({
      state: {
        primary: null,
        sources: { openshipApp: { connected: false }, ghCli: { available: false } },
      },
      accounts: [],
    });
    expect(await actionRepositoryChecks(ctx, input)).toMatchObject({
      account: null,
      status: "not_connected",
    });
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it("reports disabled repository Actions", async () => {
    h.fetch
      .mockResolvedValueOnce({ enabled: false })
      .mockResolvedValueOnce({ total_count: 0, runners: [] });
    expect(await actionRepositoryChecks(ctx, input)).toMatchObject({ status: "actions_disabled" });
  });
  it("does not show successful connection for an incomplete runner response", async () => {
    h.fetch.mockResolvedValueOnce({ enabled: true }).mockResolvedValueOnce({});
    expect(await actionRepositoryChecks(ctx, input)).toMatchObject({ status: "unavailable" });
  });
  it.each([
    [new AppError("No authorized repository credential", 403, "GITHUB_TOKEN_REQUIRED"), "access_required"],
    [new GitHubApiError(403, "Permission denied", new Headers()), "access_required"],
    [
      new GitHubApiError(403, "Rate limited", new Headers({ "x-ratelimit-remaining": "0" })),
      "unavailable",
    ],
    [new Error("Connection timed out"), "unavailable"],
  ])("distinguishes permission errors from retryable provider failures", async (error, status) => {
    h.fetch.mockRejectedValue(error);
    expect(await actionRepositoryChecks(ctx, input)).toMatchObject({ status });
  });
  it("requires an App for independent reporting even when a personal account is connected", async () => {
    expect(await actionRepositoryChecks(ctx, { ...input, controller: "openship" })).toMatchObject({
      status: "app_required",
    });
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it("verifies exact repository Checks permission and never returns its token", async () => {
    h.mint.mockResolvedValue("installation-secret");
    const result = await actionRepositoryChecks(ctx, { ...input, controller: "openship" });
    expect(h.mint).toHaveBeenCalledWith(ctx, "acme", undefined, {
      repositories: ["app"],
      permissions: { checks: "write" },
    });
    expect(result).toMatchObject({
      status: "connected",
      account: { login: "acme", kind: "installation" },
    });
    expect(JSON.stringify(result)).not.toContain("installation-secret");
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it("shows a permission setup action when GitHub refuses the App's requested grant", async () => {
    h.mint.mockRejectedValue(
      new GitHubAppApiError(422, "Permissions requested are not granted", new Headers()),
    );
    expect(await actionRepositoryChecks(ctx, { ...input, controller: "openship" })).toMatchObject({
      status: "access_required",
    });
  });
  it("does not expose filtered installation identities", async () => {
    h.status.mockResolvedValue({
      state: {
        ...connection.state,
        primary: null,
        sources: { openshipApp: { connected: false }, ghCli: { available: false } },
      },
      accounts: [{ login: "acme", source: "app", avatar_url: "private-avatar" }],
    });
    h.filter.mockResolvedValue([]);
    expect(await actionRepositoryChecks(ctx, input)).toMatchObject({
      account: null,
      status: "not_connected",
    });
  });
});
