import { VcsProviderStrategy } from "./vcs.strategy";
import { GitHubStrategy } from "./providers/github.strategy";
import { GitLabStrategy } from "./providers/gitlab.strategy";
import { SelfHostedStrategy } from "./providers/self-hosted.strategy";
import { UnknownVcsProviderError } from "./vcs.types";

// We will register strategies here.
const strategies = new Map<string, VcsProviderStrategy>();

// Register default strategies
strategies.set("github", new GitHubStrategy());
strategies.set("gitlab", new GitLabStrategy());
strategies.set("self-hosted", new SelfHostedStrategy());

export class VcsStrategyFactory {
  /**
   * Register a new strategy for a given provider (e.g. "github", "gitlab").
   */
  static registerStrategy(provider: string, strategy: VcsProviderStrategy) {
    strategies.set(provider, strategy);
  }

  /**
   * Get the strategy instance for the specified provider.
   * Defaults to "github" if provider is empty, missing, or unregistered for now,
   * to ensure backward compatibility as per the plan.
   */
  static getStrategy(provider?: string | null): VcsProviderStrategy {
    const safeProvider = provider || "github";
    const strategy = strategies.get(safeProvider);

    if (!strategy) {
      throw new UnknownVcsProviderError(safeProvider);
    }

    return strategy;
  }
}
