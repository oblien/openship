import { VcsProviderStrategy, VcsCheckRun } from "../vcs.strategy";
import type { WebhookStrategy } from "../vcs.types";
import type { RequestContext } from "../../../lib/request-context";
import * as githubService from "../../github/github.service";
import * as cloneAuth from "../../github/clone-auth";
import type {
  GitHubPushPayload,
  GitHubFileContent as VcsFileContent,
  GitHubTreeResponse as VcsTreeResponse,
  GitHubWebhook as VcsWebhook,
} from "../../github/github.types";

export class GitHubStrategy implements VcsProviderStrategy {
  async getRepository(ctx: RequestContext, owner: string, repo: string) {
    return githubService.getRepository(ctx, owner, repo);
  }

  async verifyWebhookSignature(payload: string | Buffer, headers: Record<string, string>) {
    // Github webhook verification is typically handled by the provider middleware directly,
    // but we satisfy the interface here.
    return { valid: true };
  }

  async listRepositories(ctx: RequestContext, owner?: string) {
    const source = await import("../../github/sources").then((m) => m.createGitHubSource(ctx));
    const repos = await source.listReposForOwner(owner);
    if (!repos) throw new Error("Not connected to GitHub");
    return repos;
  }

  async getBranches(ctx: RequestContext, owner: string, repo: string) {
    return githubService.listBranches(ctx, owner, repo);
  }

  async getFileContent(
    ctx: RequestContext,
    owner: string,
    repo: string,
    path: string,
    ref?: string,
  ): Promise<VcsFileContent> {
    const result = await githubService.getFileContent(ctx, owner, repo, path, { branch: ref });
    return {
      ...result,
      name: path.split("/").pop() || "",
      path,
      type: "file",
    } as VcsFileContent;
  }

  async getTree(
    ctx: RequestContext,
    owner: string,
    repo: string,
    sha: string,
  ): Promise<VcsTreeResponse> {
    const tree = await githubService.listRepositoryTree(ctx, owner, repo, { branch: sha });
    return {
      sha,
      truncated: false,
      tree: tree as any,
    } as VcsTreeResponse;
  }

  async getCloneCredentials(opts: any) {
    return cloneAuth.resolveBuildGitToken(opts);
  }

  async getCloneToken(ctx: RequestContext, owner: string, repo: string) {
    const githubAuth = await import("../../github/github.auth");
    const token = await githubAuth.getInstallationToken(ctx, owner, undefined, {
      repositories: [repo],
    });
    if (!token) {
      throw new Error("No GitHub App installation token is available for this owner.");
    }
    const cloneUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
    return { token, cloneUrl, command: `git clone ${cloneUrl}` };
  }

  parseWebhookPayload(payload: unknown, eventType: string): GitHubPushPayload | null {
    if (eventType !== "push") return null;
    return payload as GitHubPushPayload;
  }

  async getLatestCommit(ctx: RequestContext, owner: string, repo: string, branch: string) {
    return githubService.getLatestCommit(ctx, owner, repo, branch);
  }

  async getRecentCommits(
    ctx: RequestContext,
    owner: string,
    repo: string,
    branch: string,
    perPage = 10,
  ) {
    return githubService.getRecentCommits(ctx, owner, repo, branch, perPage);
  }

  async compareCommits(
    ctx: RequestContext,
    owner: string,
    repo: string,
    base: string,
    head: string,
  ) {
    return githubService.compareCommits(ctx, owner, repo, base, head);
  }

  parseRepoUrl(repoUrl?: string) {
    return githubService.parseRepoUrl(repoUrl);
  }

  async createCheckRun(
    ctx: RequestContext,
    owner: string,
    repo: string,
    opts: {
      name: string;
      headSha: string;
      status: "queued" | "in_progress" | "completed";
      startedAt?: string;
      output?: { title: string; summary: string; text?: string };
      externalId?: string;
      detailsUrl?: string;
      conclusion?: "success" | "failure" | "cancelled" | "neutral" | "skipped";
    },
  ): Promise<VcsCheckRun | null> {
    const result = await githubService.createCheckRun(ctx, owner, repo, {
      name: opts.name,
      headSha: opts.headSha,
      status: opts.status,
      conclusion: opts.conclusion,
      // detailsUrl: opts.detailsUrl,
      output: opts.output,
    });
    if (!result) return null;
    return {
      id: result.id,
      status: opts.status,
      conclusion: opts.conclusion ?? null,
      htmlUrl: result.htmlUrl,
    };
  }

  async updateCheckRun(
    ctx: RequestContext,
    owner: string,
    repo: string,
    checkRunId: number,
    opts: {
      status?: "queued" | "in_progress" | "completed";
      conclusion?:
        | "success"
        | "failure"
        | "neutral"
        | "cancelled"
        | "timed_out"
        | "action_required"
        | "skipped";
      completedAt?: string;
      output?: { title: string; summary: string; text?: string };
      detailsUrl?: string;
    },
  ) {
    return githubService.updateCheckRun(ctx, owner, repo, checkRunId, {
      status: opts.status as any,
      conclusion: opts.conclusion as any,
      // detailsUrl: opts.detailsUrl,
      output: opts.output,
    });
  }

  async registerWebhook(
    ctx: RequestContext,
    owner: string,
    repo: string,
    webhookUrl?: string,
    opts?: { projectId?: string },
  ): Promise<VcsWebhook | null> {
    const result = await githubService.registerWebhook(ctx, owner, repo, webhookUrl, opts);
    if (!result) return null;
    return result as unknown as VcsWebhook;
  }

  async listWebhooks(ctx: RequestContext, owner: string, repo: string): Promise<VcsWebhook[]> {
    const result = await githubService.listWebhooks(ctx, owner, repo);
    return result as unknown as VcsWebhook[];
  }

  async updateWebhook(
    ctx: RequestContext,
    owner: string,
    repo: string,
    hookId: number,
    patch: { url?: string; secret?: string; active?: boolean },
  ): Promise<VcsWebhook> {
    const result = await githubService.updateWebhook(ctx, owner, repo, hookId, patch);
    return result as unknown as VcsWebhook;
  }

  async deleteWebhook(ctx: RequestContext, owner: string, repo: string, hookId: number) {
    return githubService.deleteWebhook(ctx, owner, repo, hookId);
  }

  getWebhookStrategy(): WebhookStrategy {
    return githubService.getWebhookStrategy();
  }

  async resolveWebhookStrategy(project: {
    gitOwner?: string | null;
    gitRepo?: string | null;
    id: string;
    webhookDomain?: string | null;
  }): Promise<WebhookStrategy> {
    return githubService.resolveWebhookStrategy(project);
  }

  async getAvailableStrategies(
    ctx: RequestContext,
    project: {
      gitOwner?: string | null;
      gitRepo?: string | null;
      id: string;
      webhookDomain?: string | null;
    },
  ): Promise<{ current: WebhookStrategy; available: WebhookStrategy[] }> {
    return githubService.getAvailableStrategies(ctx, project);
  }
}
