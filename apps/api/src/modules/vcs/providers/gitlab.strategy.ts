import { VcsProviderStrategy } from "../vcs.strategy";
import type { RequestContext } from "../../../lib/request-context";

export class GitLabStrategy implements VcsProviderStrategy {
  getRepository(...args: any[]): any {
    throw new Error("getRepository is not yet implemented for gitlab");
  }

  listRepositories(...args: any[]): any {
    throw new Error("listRepositories is not yet implemented for gitlab");
  }

  getBranches(...args: any[]): any {
    throw new Error("getBranches is not yet implemented for gitlab");
  }

  listFiles(...args: any[]): any {
    throw new Error("listFiles is not yet implemented for gitlab");
  }

  getFileContent(...args: any[]): any {
    throw new Error("getFileContent is not yet implemented for gitlab");
  }

  getTree(...args: any[]): any {
    throw new Error("getTree is not yet implemented for gitlab");
  }

  getCloneCredentials(...args: any[]): any {
    throw new Error("getCloneCredentials is not yet implemented for gitlab");
  }

  getCloneToken(...args: any[]): any {
    throw new Error("getCloneToken is not yet implemented for gitlab");
  }

  verifyWebhookSignature(...args: any[]): any {
    throw new Error("verifyWebhookSignature is not yet implemented for gitlab");
  }

  parseWebhookPayload(...args: any[]): any {
    throw new Error("parseWebhookPayload is not yet implemented for gitlab");
  }

  getLatestCommit(...args: any[]): any {
    throw new Error("getLatestCommit is not yet implemented for gitlab");
  }

  getRecentCommits(...args: any[]): any {
    throw new Error("getRecentCommits is not yet implemented for gitlab");
  }

  compareCommits(...args: any[]): any {
    throw new Error("compareCommits is not yet implemented for gitlab");
  }

  parseRepoUrl(...args: any[]): any {
    throw new Error("parseRepoUrl is not yet implemented for gitlab");
  }

  createCheckRun(...args: any[]): any {
    throw new Error("createCheckRun is not yet implemented for gitlab");
  }

  updateCheckRun(...args: any[]): any {
    throw new Error("updateCheckRun is not yet implemented for gitlab");
  }

  registerWebhook(...args: any[]): any {
    throw new Error("registerWebhook is not yet implemented for gitlab");
  }

  listWebhooks(...args: any[]): any {
    throw new Error("listWebhooks is not yet implemented for gitlab");
  }

  updateWebhook(...args: any[]): any {
    throw new Error("updateWebhook is not yet implemented for gitlab");
  }

  deleteWebhook(...args: any[]): any {
    throw new Error("deleteWebhook is not yet implemented for gitlab");
  }

  getWebhookStrategy(...args: any[]): any {
    throw new Error("getWebhookStrategy is not yet implemented for gitlab");
  }

  resolveWebhookStrategy(...args: any[]): any {
    throw new Error("resolveWebhookStrategy is not yet implemented for gitlab");
  }

  getAvailableStrategies(...args: any[]): any {
    throw new Error("getAvailableStrategies is not yet implemented for gitlab");
  }

}
