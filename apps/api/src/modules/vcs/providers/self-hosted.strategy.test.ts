import { describe, it, expect, beforeEach } from "vitest";
import { SelfHostedStrategy } from "./self-hosted.strategy";
import type { RequestContext } from "../../../lib/request-context";

describe("SelfHostedStrategy", () => {
  let strategy: SelfHostedStrategy;
  const mockCtx = {} as RequestContext;

  beforeEach(() => {
    strategy = new SelfHostedStrategy();
  });

  it("should throw not implemented for getRepository", async () => {
    await expect(strategy.getRepository(mockCtx, "owner", "repo")).rejects.toThrow(
      "Self-hosted Git integration not yet implemented.",
    );
  });

  it("should throw not implemented for listRepositories", async () => {
    await expect(strategy.listRepositories(mockCtx)).rejects.toThrow(
      "Self-hosted Git integration not yet implemented.",
    );
  });

  it("should throw not implemented for getBranches", async () => {
    await expect(strategy.getBranches(mockCtx, "owner", "repo")).rejects.toThrow(
      "Self-hosted Git integration not yet implemented.",
    );
  });

  it("should throw not implemented for getFileContent", async () => {
    await expect(strategy.getFileContent(mockCtx, "owner", "repo", "path")).rejects.toThrow(
      "Self-hosted Git integration not yet implemented.",
    );
  });

  it("should throw not implemented for getTree", async () => {
    await expect(strategy.getTree(mockCtx, "owner", "repo", "sha")).rejects.toThrow(
      "Self-hosted Git integration not yet implemented.",
    );
  });

  it("should throw not implemented for getCloneCredentials", async () => {
    await expect(strategy.getCloneCredentials({} as any)).rejects.toThrow(
      "Self-hosted Git integration not yet implemented.",
    );
  });

  it("should return null for parseWebhookPayload", () => {
    expect(strategy.parseWebhookPayload({}, "push")).toBeNull();
  });
});
