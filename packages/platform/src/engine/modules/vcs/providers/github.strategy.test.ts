import { describe, it, expect, vi, beforeEach } from "vitest";
import { GitHubStrategy } from "./github.strategy";
import * as githubService from "../../github/github.service";
import * as githubApplicationService from "../../github/github-application.service";
import * as cloneAuth from "../../github/clone-auth";
import type { ExecutionContext as RequestContext } from "../../../../context";

vi.mock("../../github/github.service");
vi.mock("../../github/github-application.service");
vi.mock("../../github/clone-auth");

describe("GitHubStrategy", () => {
  let strategy: GitHubStrategy;
  const mockCtx = {} as RequestContext;

  beforeEach(() => {
    vi.clearAllMocks();
    strategy = new GitHubStrategy();
  });

  it("should delegate getRepository to githubService", async () => {
    vi.mocked(githubService.getRepository).mockResolvedValueOnce({ id: 1 } as any);
    const result = await strategy.getRepository(mockCtx, "owner", "repo");
    expect(githubService.getRepository).toHaveBeenCalledWith(mockCtx, "owner", "repo", undefined);
    expect(result).toEqual({ id: 1 });
  });

  it("should throw on verifyWebhookSignature", async () => {
    await expect(strategy.verifyWebhookSignature("payload", {})).rejects.toThrow("Not implemented");
  });

  it("should delegate getBranches to githubService", async () => {
    const page = { branches: [{ name: "main" }], page: 2, perPage: 100, hasMore: false };
    vi.mocked(githubService.listBranches).mockResolvedValueOnce(page as any);
    const result = await strategy.getBranches(mockCtx, "owner", "repo", { page: 2 });
    expect(githubService.listBranches).toHaveBeenCalledWith(mockCtx, "owner", "repo", {
      page: 2,
    });
    expect(result).toEqual(page);
  });

  it("should delegate getBranch to githubService", async () => {
    vi.mocked(githubService.getBranch).mockResolvedValueOnce({ name: "release" } as any);
    const result = await strategy.getBranch(mockCtx, "owner", "repo", "release");
    expect(githubService.getBranch).toHaveBeenCalledWith(mockCtx, "owner", "repo", "release");
    expect(result).toEqual({ name: "release" });
  });

  it("should transform getFileContent response correctly", async () => {
    vi.mocked(githubService.getFileContent).mockResolvedValueOnce({ content: "test" } as any);
    const result = await strategy.getFileContent(mockCtx, "owner", "repo", "path/to/file.txt", {
      branch: "main",
    });
    expect(githubService.getFileContent).toHaveBeenCalledWith(
      mockCtx,
      "owner",
      "repo",
      "path/to/file.txt",
      { branch: "main" },
    );
    expect(result).toEqual({ content: "test" });
  });

  it("should transform getTree response correctly", async () => {
    vi.mocked(githubService.listRepositoryTree).mockResolvedValueOnce([
      { path: "file.txt", type: "file" },
      { path: "dir", type: "dir" },
    ] as any);
    const result = await strategy.getTree(mockCtx, "owner", "repo", "sha-123");
    expect(githubService.listRepositoryTree).toHaveBeenCalledWith(mockCtx, "owner", "repo", {
      branch: "sha-123",
    });
    expect(result).toEqual({
      tree: [
        { path: "file.txt", type: "blob" },
        { path: "dir", type: "tree" },
      ],
    });
  });

  it("should delegate getCloneCredentials to cloneAuth", async () => {
    vi.mocked(cloneAuth.resolveBuildGitToken).mockResolvedValueOnce({ token: "secret" } as any);
    const result = await strategy.getCloneCredentials({ projectId: "1" } as any);
    expect(cloneAuth.resolveBuildGitToken).toHaveBeenCalledWith({ projectId: "1" });
    expect(result).toEqual({ token: "secret" });
  });

  it("returns the provider-resolved clone URL for enterprise GitHub", async () => {
    const response = {
      token: "secret",
      cloneUrl: "https://x-access-token:secret@github.enterprise.test/acme/app.git",
      command:
        "git clone https://x-access-token:secret@github.enterprise.test/acme/app.git",
    };
    vi.mocked(githubApplicationService.getCloneToken).mockResolvedValueOnce(response);

    await expect(strategy.getCloneToken(mockCtx, "acme", "app")).resolves.toEqual(response);
  });

  it("should parse push webhook payload correctly", () => {
    const payload = { ref: "refs/heads/main" };
    expect(strategy.parseWebhookPayload(payload, "push")).toEqual(payload);
  });

  it("should return null for non-push webhooks", () => {
    const payload = { action: "opened" };
    expect(strategy.parseWebhookPayload(payload, "pull_request")).toBeNull();
  });

  it("preserves deployment details links across the check-run adapter boundary", async () => {
    vi.mocked(githubService.createCheckRun).mockResolvedValueOnce({
      id: 123,
      htmlUrl: "url",
    } as any);
    const created = await strategy.createCheckRun(mockCtx, "owner", "repo", {
      name: "test",
      headSha: "sha",
      status: "in_progress",
      detailsUrl: "https://example.com/details",
    });
    expect(created).toEqual({
      id: 123,
      status: "in_progress",
      conclusion: null,
      htmlUrl: "url",
    });
    expect(githubService.createCheckRun).toHaveBeenCalledWith(
      mockCtx,
      "owner",
      "repo",
      expect.objectContaining({ detailsUrl: "https://example.com/details" }),
    );
    vi.mocked(githubService.updateCheckRun).mockResolvedValueOnce({} as any);
    await strategy.updateCheckRun(mockCtx, "owner", "repo", 123, {
      status: "completed",
      detailsUrl: "https://example.com/details",
    });
    expect(githubService.updateCheckRun).toHaveBeenCalledWith(
      mockCtx,
      "owner",
      "repo",
      123,
      expect.objectContaining({ detailsUrl: "https://example.com/details" }),
    );
  });
});
