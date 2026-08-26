import { describe, it, expect } from "vitest";
import { VcsStrategyFactory } from "./vcs.factory";
import { GitHubStrategy } from "./providers/github.strategy";
import { GitLabStrategy } from "./providers/gitlab.strategy";
import { SelfHostedStrategy } from "./providers/self-hosted.strategy";

describe("VcsStrategyFactory", () => {
  it("should return GitHubStrategy by default if no provider is specified", () => {
    const strategy = VcsStrategyFactory.getStrategy();
    expect(strategy).toBeInstanceOf(GitHubStrategy);
  });

  it("should return GitHubStrategy for github", () => {
    const strategy = VcsStrategyFactory.getStrategy("github");
    expect(strategy).toBeInstanceOf(GitHubStrategy);
  });

  it("should return GitLabStrategy for gitlab", () => {
    const strategy = VcsStrategyFactory.getStrategy("gitlab");
    expect(strategy).toBeInstanceOf(GitLabStrategy);
  });

  it("should return SelfHostedStrategy for self-hosted", () => {
    const strategy = VcsStrategyFactory.getStrategy("self-hosted");
    expect(strategy).toBeInstanceOf(SelfHostedStrategy);
  });

  it("should fallback to GitHubStrategy for unknown providers to maintain backwards compatibility", () => {
    const strategy = VcsStrategyFactory.getStrategy("unknown-provider");
    expect(strategy).toBeInstanceOf(GitHubStrategy);
  });

  it("should allow registering a new strategy", () => {
    class CustomStrategy extends GitHubStrategy {}
    VcsStrategyFactory.registerStrategy("custom", new CustomStrategy());

    const strategy = VcsStrategyFactory.getStrategy("custom");
    expect(strategy).toBeInstanceOf(CustomStrategy);
  });
});
