import { VcsProviderStrategy } from "../vcs.strategy";
import type { WebhookStrategy, VcsPushPayload } from "../vcs.types";
import type { RequestContext } from "../../../lib/request-context";

export class SelfHostedStrategy implements VcsProviderStrategy {
  async verifyWebhookSignature(payload: string | Buffer, headers: Record<string, string>) {
    return { valid: true };
  }
  async getRecentCommits(ctx: any, owner: string, repo: string, branch: string, limit?: number) {
    return [];
  }

  async getRepository(ctx: RequestContext, owner: string, repo: string): Promise<any> {
    throw new Error("Self-hosted Git integration not yet implemented.");
  }

  async listRepositories(ctx: RequestContext, owner?: string): Promise<any[]> {
    throw new Error("Self-hosted Git integration not yet implemented.");
  }

  async getBranches(ctx: RequestContext, owner: string, repo: string): Promise<any[]> {
    throw new Error("Self-hosted Git integration not yet implemented.");
  }

  async getFileContent(
    ctx: RequestContext,
    owner: string,
    repo: string,
    path: string,
    ref?: string,
  ): Promise<any> {
    throw new Error("Self-hosted Git integration not yet implemented.");
  }

  async getTree(ctx: RequestContext, owner: string, repo: string, sha: string): Promise<any> {
    throw new Error("Self-hosted Git integration not yet implemented.");
  }

  async getCloneCredentials(opts: any): Promise<any> {
    throw new Error("Self-hosted Git integration not yet implemented.");
  }

  async getCloneToken(ctx: RequestContext, owner: string, repo: string): Promise<any> {
    throw new Error("Self-hosted Git integration not yet implemented.");
  }

  parseWebhookPayload(payload: unknown, eventType: string): VcsPushPayload | null {
    return null;
  }

  async getLatestCommit(
    ctx: RequestContext,
    owner: string,
    repo: string,
    branch: string,
  ): Promise<{ sha: string; message: string } | null> {
    throw new Error("Method not implemented.");
  }

  async compareCommits(
    ctx: RequestContext,
    owner: string,
    repo: string,
    base: string,
    head: string,
  ): Promise<{ files: string[] } | null> {
    return { files: [] };
  }

  parseRepoUrl(repoUrl?: string): { owner: string; repo: string } | null {
    throw new Error("Method not implemented.");
  }

  async createCheckRun(ctx: RequestContext, owner: string, repo: string, opts: any): Promise<any> {
    throw new Error("Method not implemented.");
  }

  async updateCheckRun(
    ctx: RequestContext,
    owner: string,
    repo: string,
    checkRunId: number,
    opts: any,
  ): Promise<void> {
    throw new Error("Method not implemented.");
  }

  async registerWebhook(
    ctx: RequestContext,
    owner: string,
    repo: string,
    webhookUrl?: string,
    opts?: { projectId?: string },
  ): Promise<any> {
    throw new Error("Method not implemented.");
  }

  async listWebhooks(ctx: RequestContext, owner: string, repo: string): Promise<any[]> {
    throw new Error("Method not implemented.");
  }

  async updateWebhook(
    ctx: RequestContext,
    owner: string,
    repo: string,
    hookId: number,
    patch: any,
  ): Promise<any> {
    throw new Error("Method not implemented.");
  }

  async deleteWebhook(
    ctx: RequestContext,
    owner: string,
    repo: string,
    hookId: number,
  ): Promise<void> {
    throw new Error("Self-hosted strategy not implemented");
  }

  getWebhookStrategy(): WebhookStrategy {
    throw new Error("Self-hosted strategy not implemented");
  }

  async resolveWebhookStrategy(project: {
    gitOwner?: string | null;
    gitRepo?: string | null;
    id: string;
  }): Promise<WebhookStrategy> {
    throw new Error("Self-hosted strategy not implemented");
  }

  async getAvailableStrategies(
    ctx: RequestContext,
    project: { gitOwner?: string | null; gitRepo?: string | null; id: string },
  ): Promise<{ current: WebhookStrategy; available: WebhookStrategy[] }> {
    throw new Error("Self-hosted strategy not implemented");
  }
}
