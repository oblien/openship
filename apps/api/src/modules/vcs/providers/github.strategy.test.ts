import { describe, it, expect, vi, beforeEach } from "vitest";
import { GitHubStrategy } from "./github.strategy";
import * as githubService from "../../github/github.service";
import * as cloneAuth from "../../github/clone-auth";
import type { RequestContext } from "../../../lib/request-context";

vi.mock("../../github/github.service");
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
    vi.mocked(githubService.listBranches).mockResolvedValueOnce([{ name: "main" }] as any);
    const result = await strategy.getBranches(mockCtx, "owner", "repo");
    expect(githubService.listBranches).toHaveBeenCalledWith(mockCtx, "owner", "repo");
    expect(result).toEqual([{ name: "main" }]);
  });

  it("should transform getFileContent response correctly", async () => {
    vi.mocked(githubService.getFileContent).mockResolvedValueOnce({ content: "test" } as any);
    const result = await strategy.getFileContent(
      mockCtx,
      "owner",
      "repo",
      "path/to/file.txt",
      { branch: "main" },
    );
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

  it("should parse push webhook payload correctly", () => {
    const payload = { ref: "refs/heads/main" };
    expect(strategy.parseWebhookPayload(payload, "push")).toEqual(payload);
  });

  it("should return null for non-push webhooks", () => {
    const payload = { action: "opened" };
    expect(strategy.parseWebhookPayload(payload, "pull_request")).toBeNull();
  });

  it("should pass detailsUrl to createCheckRun", async () => {
    vi.mocked(githubService.createCheckRun).mockResolvedValueOnce({
      id: 123,
      htmlUrl: "url",
    } as any);
    await strategy.createCheckRun(mockCtx, "owner", "repo", {
      name: "test",
      headSha: "sha",
      status: "in_progress",
      detailsUrl: "https://example.com/details",
    });
    expect(githubService.createCheckRun).toHaveBeenCalledWith(
      mockCtx,
      "owner",
      "repo",
      expect.objectContaining({ detailsUrl: "https://example.com/details" }),
    );
  });

  it("should pass detailsUrl to updateCheckRun", async () => {
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
