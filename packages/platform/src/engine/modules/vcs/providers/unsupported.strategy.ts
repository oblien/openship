import { AppError } from "@repo/core";
import type { VcsProviderStrategy } from "../vcs.strategy";

/**
 * Fail closed for providers whose product integration has not shipped yet.
 * Keeping the complete interface here lets placeholder providers stay small
 * while ensuring every accidental call returns an explicit 501 instead of a
 * provider-specific fake value or an unhelpful generic 500.
 */
export abstract class UnsupportedVcsStrategy implements VcsProviderStrategy {
  protected abstract readonly provider: string;

  private unavailable(operation: string): never {
    throw new AppError(
      `${operation} is not yet implemented for ${this.provider}`,
      501,
      "VCS_OPERATION_NOT_IMPLEMENTED",
    );
  }

  getRepository(..._args: any[]): never {
    return this.unavailable("getRepository");
  }
  listRepositories(..._args: any[]): never {
    return this.unavailable("listRepositories");
  }
  getBranches(..._args: any[]): never {
    return this.unavailable("getBranches");
  }
  getBranch(..._args: any[]): never {
    return this.unavailable("getBranch");
  }
  listFiles(..._args: any[]): never {
    return this.unavailable("listFiles");
  }
  getFileContent(..._args: any[]): never {
    return this.unavailable("getFileContent");
  }
  getTree(..._args: any[]): never {
    return this.unavailable("getTree");
  }
  getCloneCredentials(..._args: any[]): never {
    return this.unavailable("getCloneCredentials");
  }
  getCloneToken(..._args: any[]): never {
    return this.unavailable("getCloneToken");
  }
  verifyWebhookSignature(..._args: any[]): never {
    return this.unavailable("verifyWebhookSignature");
  }
  parseWebhookPayload(..._args: any[]): never {
    return this.unavailable("parseWebhookPayload");
  }
  getLatestCommit(..._args: any[]): never {
    return this.unavailable("getLatestCommit");
  }
  getRecentCommits(..._args: any[]): never {
    return this.unavailable("getRecentCommits");
  }
  compareCommits(..._args: any[]): never {
    return this.unavailable("compareCommits");
  }
  parseRepoUrl(..._args: any[]): never {
    return this.unavailable("parseRepoUrl");
  }
  createCheckRun(..._args: any[]): never {
    return this.unavailable("createCheckRun");
  }
  updateCheckRun(..._args: any[]): never {
    return this.unavailable("updateCheckRun");
  }
  registerWebhook(..._args: any[]): never {
    return this.unavailable("registerWebhook");
  }
  listWebhooks(..._args: any[]): never {
    return this.unavailable("listWebhooks");
  }
  updateWebhook(..._args: any[]): never {
    return this.unavailable("updateWebhook");
  }
  deleteWebhook(..._args: any[]): never {
    return this.unavailable("deleteWebhook");
  }
  getWebhookStrategy(..._args: any[]): never {
    return this.unavailable("getWebhookStrategy");
  }
  resolveWebhookStrategy(..._args: any[]): never {
    return this.unavailable("resolveWebhookStrategy");
  }
  getAvailableStrategies(..._args: any[]): never {
    return this.unavailable("getAvailableStrategies");
  }
}
