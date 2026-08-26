import { VcsProviderStrategy } from "../vcs.strategy";
import type { RequestContext } from "../../../lib/request-context";

export class SelfHostedStrategy implements VcsProviderStrategy {
  getRepository(...args: any[]): any {
    throw new Error("getRepository is not yet implemented for selfhosted");
  }

  listRepositories(...args: any[]): any {
    throw new Error("listRepositories is not yet implemented for selfhosted");
  }

  getBranches(...args: any[]): any {
    throw new Error("getBranches is not yet implemented for selfhosted");
  }

  listFiles(...args: any[]): any {
    throw new Error("listFiles is not yet implemented for selfhosted");
  }

  getFileContent(...args: any[]): any {
    throw new Error("getFileContent is not yet implemented for selfhosted");
  }

  getTree(...args: any[]): any {
    throw new Error("getTree is not yet implemented for selfhosted");
  }

  getCloneCredentials(...args: any[]): any {
    throw new Error("getCloneCredentials is not yet implemented for selfhosted");
  }

  getCloneToken(...args: any[]): any {
    throw new Error("getCloneToken is not yet implemented for selfhosted");
  }

  verifyWebhookSignature(...args: any[]): any {
    throw new Error("verifyWebhookSignature is not yet implemented for selfhosted");
  }

  parseWebhookPayload(...args: any[]): any {
    throw new Error("parseWebhookPayload is not yet implemented for selfhosted");
  }

  getLatestCommit(...args: any[]): any {
    throw new Error("getLatestCommit is not yet implemented for selfhosted");
  }

  getRecentCommits(...args: any[]): any {
    throw new Error("getRecentCommits is not yet implemented for selfhosted");
  }

  compareCommits(...args: any[]): any {
    throw new Error("compareCommits is not yet implemented for selfhosted");
  }

  parseRepoUrl(...args: any[]): any {
    throw new Error("parseRepoUrl is not yet implemented for selfhosted");
  }

  createCheckRun(...args: any[]): any {
    throw new Error("createCheckRun is not yet implemented for selfhosted");
  }

  updateCheckRun(...args: any[]): any {
    throw new Error("updateCheckRun is not yet implemented for selfhosted");
  }

  registerWebhook(...args: any[]): any {
    throw new Error("registerWebhook is not yet implemented for selfhosted");
  }

  listWebhooks(...args: any[]): any {
    throw new Error("listWebhooks is not yet implemented for selfhosted");
  }

  updateWebhook(...args: any[]): any {
    throw new Error("updateWebhook is not yet implemented for selfhosted");
  }

  deleteWebhook(...args: any[]): any {
    throw new Error("deleteWebhook is not yet implemented for selfhosted");
  }

  getWebhookStrategy(...args: any[]): any {
    throw new Error("getWebhookStrategy is not yet implemented for selfhosted");
  }

  resolveWebhookStrategy(...args: any[]): any {
    throw new Error("resolveWebhookStrategy is not yet implemented for selfhosted");
  }

  getAvailableStrategies(...args: any[]): any {
    throw new Error("getAvailableStrategies is not yet implemented for selfhosted");
  }

}
