import { describe, it, expect, beforeEach } from "vitest";
import { GitLabStrategy } from "./gitlab.strategy";
import type { RequestContext } from "../../../lib/request-context";

describe("GitLabStrategy", () => {
  let strategy: GitLabStrategy;
  const mockCtx = {} as RequestContext;

  beforeEach(() => {
    strategy = new GitLabStrategy();
  });

  it("should throw not implemented for getRepository", async () => {
    await expect(strategy.getRepository(mockCtx, "owner", "repo")).rejects.toThrow(
      "GitLab integration not yet implemented.",
    );
  });

  it("should throw not implemented for listRepositories", async () => {
    await expect(strategy.listRepositories(mockCtx)).rejects.toThrow(
      "GitLab integration not yet implemented.",
    );
  });

  it("should throw not implemented for getBranches", async () => {
    await expect(strategy.getBranches(mockCtx, "owner", "repo")).rejects.toThrow(
      "GitLab integration not yet implemented.",
    );
  });

  it("should throw not implemented for getFileContent", async () => {
    await expect(strategy.getFileContent(mockCtx, "owner", "repo", "path")).rejects.toThrow(
      "GitLab integration not yet implemented.",
    );
  });

  it("should throw not implemented for getTree", async () => {
    await expect(strategy.getTree(mockCtx, "owner", "repo", "sha")).rejects.toThrow(
      "GitLab integration not yet implemented.",
    );
  });

  it("should throw not implemented for getCloneCredentials", async () => {
    await expect(strategy.getCloneCredentials({} as any)).rejects.toThrow(
      "GitLab integration not yet implemented.",
    );
  });

  it("should return null for parseWebhookPayload", () => {
    expect(strategy.parseWebhookPayload({}, "push")).toBeNull();
  });

  it("should throw on verifyWebhookSignature", async () => {
    await expect(strategy.verifyWebhookSignature("payload", {})).rejects.toThrow("Not implemented");
  });
});
