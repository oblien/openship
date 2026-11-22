import { beforeEach, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { ActionCollectionSchemas, GitCollectionSchemas } from "@repo/contracts";
import type { ExecutionContext } from "@repo/platform";
import type { GitProvider, GitRepository } from "@repo/platform/engine/modules/git/types";
import { gitDependencies } from "@repo/platform/engine/modules/git/git.operations";

const h = vi.hoisted(() => ({
  repository: vi.fn(),
  authorize: vi.fn(),
  info: vi.fn(),
  read: vi.fn(),
  branches: vi.fn(),
  list: vi.fn(),
}));
// Replace the registered adapter, not the operations under test. Its API and IDs
// deliberately have no GitHub-specific fields or authentication methods.
vi.mock("@repo/platform/engine/modules/git/providers/github", () => ({
  githubProvider: {
    id: "fixture",
    name: "Fixture Git",
    connections: {},
    listRepositories: h.list,
    repository: h.repository,
  } as unknown as GitProvider,
}));
const ctx = {
  userId: "user",
  organizationId: "org",
  tokenScope: { tokenId: "scoped" },
} as ExecutionContext;
const target = { provider: "fixture", owner: "group/team", repo: "app", serverId: "server" };

beforeEach(() => {
  vi.resetAllMocks();
  h.repository.mockImplementation(
    (_ctx, ref) =>
      ({
        ref,
        assertAccess: h.authorize,
        info: h.info,
        readFile: h.read,
        branches: h.branches,
      }) as unknown as GitRepository,
  );
  h.info.mockResolvedValue({ id: "repo:abc", default_branch: "trunk" });
  h.read.mockResolvedValue({ sha: "blob", size: 2, content: "ok" });
});

it("preserves provider, nested namespace, caller and server scope for repository operations", async () => {
  expect(await gitDependencies.getRepo(ctx, target)).toEqual({
    id: "repo:abc",
    default_branch: "trunk",
  });
  expect(h.repository).toHaveBeenCalledWith(
    ctx,
    { provider: "fixture", namespace: "group/team", name: "app" },
    target,
  );
  expect(h.authorize).toHaveBeenCalledWith("read");
  h.branches.mockResolvedValue({
    branches: [{ name: "feature/a", sha: "revision", protected: false }],
    page: 2,
    perPage: 100,
    hasMore: false,
  });
  expect(await gitDependencies.listBranches(ctx, { ...target, page: 2 })).toEqual({
    data: [{ name: "feature/a", sha: "revision", protected: false }],
    pagination: { page: 2, perPage: 100, hasMore: false },
  });
  expect(h.branches).toHaveBeenCalledWith(2);
});

it("does not fetch metadata after repository authorization fails", async () => {
  h.authorize.mockRejectedValue(new Error("Repository not granted"));
  await expect(gitDependencies.getRepo(ctx, target)).rejects.toThrow("not granted");
  expect(h.info).not.toHaveBeenCalled();
});

it("uses the adapter's path-authorized file reader and keeps its denial", async () => {
  expect(await gitDependencies.getFile(ctx, { ...target, file: "allowed/config.json" })).toEqual({
    sha: "blob",
    size: 2,
    content: "ok",
    download_url: null,
  });
  expect(h.read).toHaveBeenCalledWith("allowed/config.json", "trunk");
  h.read.mockRejectedValue(new Error("Path not granted"));
  await expect(
    gitDependencies.getFile(ctx, { ...target, file: "private/key", branch: "feature/a" }),
  ).rejects.toThrow("Path not granted");
});

it("refuses missing write capabilities and never tries another provider", async () => {
  await expect(
    gitDependencies.publishChange(ctx, {
      ...target,
      requestId: "test-request-123456",
      pullRequest: true,
      patch: {
        baseBranch: "trunk",
        baseSha: "a".repeat(40),
        title: "Update",
        description: "",
        files: [{ path: "file", content: "ok" }],
      },
    }),
  ).rejects.toMatchObject({ code: "GIT_CAPABILITY_UNAVAILABLE" });
  h.repository.mockClear();
  await expect(
    gitDependencies.getRepo(ctx, { ...target, provider: "github" }),
  ).rejects.toMatchObject({ code: "GIT_PROVIDER_UNSUPPORTED" });
  expect(h.repository).not.toHaveBeenCalled();
});

it("accepts the same full namespace in repository and Actions requests", () => {
  expect(Value.Check(GitCollectionSchemas.getRepo.input, target)).toBe(true);
  expect(
    Value.Check(ActionCollectionSchemas.discover.input, {
      gitProvider: target.provider,
      owner: target.owner,
      repo: target.repo,
      ref: "main",
    }),
  ).toBe(true);
});
