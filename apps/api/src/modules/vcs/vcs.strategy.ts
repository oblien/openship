import type { RequestContext } from "../../lib/request-context";
import type { BuildGitCredential } from "../github/clone-auth";
import type {
  MappedRepository,
  RepositoryDetail,
  GitHubBranch as VcsBranch,
  GitHubFileContent as VcsFileContent,
  GitHubPushPayload as VcsPushPayload,
  GitHubTreeResponse as VcsTreeResponse,
  GitHubWebhook as VcsWebhook,
} from "../github/github.types";

export interface VcsCheckRun {
  id: number;
  status: string;
  conclusion: string | null;
  htmlUrl?: string;
}

import type { WebhookStrategy } from "./vcs.types";

/**
 * Strategy interface for interacting with different Version Control Systems.
 */
export interface VcsProviderStrategy {
  /**
   * Fetch detailed information about a single repository.
   */
  getRepository(ctx: RequestContext, owner: string, repo: string, opts?: { withBranches?: boolean }): Promise<RepositoryDetail>;

  /**
   * List repositories accessible by the current context (user/org).
   * @param owner - Optional. If provided, list repos for this owner/org only.
   */
  listRepositories(ctx: RequestContext, owner?: string): Promise<MappedRepository[]>;

  /**
   * Get all branches for a repository.
   */
  getBranches(ctx: RequestContext, owner: string, repo: string): Promise<VcsBranch[]>;

  /**
   * Retrieve the contents of a specific file.
   */
  listFiles(ctx: RequestContext, owner: string, repo: string, opts?: { branch?: string; path?: string }): Promise<any>;

  getFileContent(
    ctx: RequestContext,
    owner: string,
    repo: string,
    path: string,
    opts?: { branch?: string; json?: boolean },
  ): Promise<VcsFileContent>;

  /**
   * Get a directory tree.
   */
  getTree(ctx: RequestContext, owner: string, repo: string, sha: string): Promise<VcsTreeResponse>;

  getCloneCredentials(opts: any): Promise<BuildGitCredential>;

  /**
   * Mint a short-lived clone token for a specific repository.
   */
  getCloneToken(
    ctx: RequestContext,
    owner: string,
    repo: string,
  ): Promise<{ token: string; cloneUrl: string; command: string }>;

  /**
   * Parse a raw webhook payload into a standardized push payload format.
   * Returns null if the payload is not a push event or is unsupported.
   */
  verifyWebhookSignature(
    payload: string | Buffer,
    headers: Record<string, string>,
  ): Promise<{ valid: boolean; error?: string }>;

  parseWebhookPayload(payload: unknown, eventType: string): VcsPushPayload | null;

  /**
   * Get the latest commit for a given branch.
   */
  getLatestCommit(
    ctx: RequestContext,
    owner: string,
    repo: string,
    branch: string,
  ): Promise<{ sha: string; message: string } | null>;

  /**
   * Get recent commits for a given branch.
   */
  getRecentCommits(
    ctx: RequestContext,
    owner: string,
    repo: string,
    branch: string,
    perPage?: number,
  ): Promise<any[]>;

  /**
   * Compare two commits to find files changed.
   */
  compareCommits(
    ctx: RequestContext,
    owner: string,
    repo: string,
    base: string,
    head: string,
  ): Promise<{ files: string[] } | null>;

  /**
   * Parse a repository URL into owner and repo.
   */
  parseRepoUrl(repoUrl?: string): { owner: string; repo: string } | null;

  /**
   * Create a check run (e.g. for deployments).
   */
  createCheckRun(
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
  ): Promise<VcsCheckRun | null>;

  /**
   * Update an existing check run.
   */
  updateCheckRun(
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
  ): Promise<void>;

  /**
   * Register a webhook on the repository.
   */
  registerWebhook(
    ctx: RequestContext,
    owner: string,
    repo: string,
    webhookUrl?: string,
    opts?: { projectId?: string },
  ): Promise<VcsWebhook | null>;

  /**
   * List webhooks on the repository.
   */
  listWebhooks(ctx: RequestContext, owner: string, repo: string): Promise<VcsWebhook[]>;

  /**
   * Update an existing webhook.
   */
  updateWebhook(
    ctx: RequestContext,
    owner: string,
    repo: string,
    hookId: number,
    patch: { url?: string; secret?: string; active?: boolean },
  ): Promise<VcsWebhook>;

  /**
   * Delete a webhook.
   */
  deleteWebhook(ctx: RequestContext, owner: string, repo: string, hookId: number): Promise<void>;

  /**
   * Get the global/default webhook strategy for this provider.
   */
  getWebhookStrategy(): WebhookStrategy;

  /**
   * Resolve the effective webhook strategy for a specific project.
   *
   * Only `webhookDomain` is read: delivery is a property of where the provider
   * can reach us, not of which repo is linked. Widening this to require the
   * project row forced `as any` at every call site that holds only the git slice.
   */
  resolveWebhookStrategy(project?: { webhookDomain?: string | null }): Promise<WebhookStrategy>;

  /**
   * Get available strategies for a specific project.
   */
  getAvailableStrategies(
    ctx: RequestContext,
    project?: { webhookDomain?: string | null },
  ): Promise<{ current: WebhookStrategy; available: WebhookStrategy[] }>;
}
