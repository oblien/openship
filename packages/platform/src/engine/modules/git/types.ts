import type { GitRepositorySummary, GitRepositoryInfo, GitOperations } from "@repo/contracts";
import type { GitPreflight } from "./preflight-types";
import type { BuildGitCredential, GitCloneOptions } from "./clone-types";
import type { ExecutionContext } from "../../../context";
import type {
  GitProviderAccess,
  GitProviderErrors,
  GitSourceChanges,
  GitPullRequests,
  GitProviderConnections,
  GitWorkflowSource,
} from "./capabilities";

import type { GitRepositoryRef } from "@repo/core";
export type { GitRepositoryRef } from "@repo/core";

export interface GitReadOptions {
  /** Only use credentials belonging to this organization-scoped server. */
  serverId?: string;
}

export interface GitBranch {
  name: string;
  sha: string;
  protected: boolean;
}

export type { GitRepositoryInfo } from "@repo/contracts";

export interface GitComparison {
  files: string[];
  /** Absence from an incomplete comparison is never proof of no change. */
  truncated: boolean;
}

export interface GitCommit {
  sha: string;
  message: string;
}

export interface GitCommitDetail extends GitCommit {
  author: string;
  authorAvatar: string;
  date: string;
  url: string;
}

export interface GitFile {
  sha: string;
  size: number;
  content: string;
}

export interface GitCheckUpdate {
  name: string;
  externalId: string;
  headSha: string;
  status: "queued" | "in_progress" | "completed";
  conclusion?:
    "success" | "failure" | "cancelled" | "neutral" | "skipped" | "timed_out" | "action_required";
  detailsUrl?: string;
  startedAt?: string;
  completedAt?: string;
  output: { title: string; summary: string };
}

export interface GitCheckOptions {
  canSend?: () => Promise<boolean>;
  createIfMissing?: boolean;
  verifyIdentity?: boolean;
  beforeCreate?: () => Promise<void>;
}

export interface GitRepositoryWebhooks {
  register(options: {
    url?: string;
    projectId?: string;
  }): Promise<{ id: string | null; events: string[] }>;
  setActive(id: string, active: boolean): Promise<void>;
  delete(id: string): Promise<void>;
}

/** Bound to a request, a repository and a read-credential scope. Never cached globally. */
export interface GitRepository {
  readonly ref: GitRepositoryRef;
  info(options?: { withBranches?: boolean }): Promise<GitRepositoryInfo>;
  branch(name: string): Promise<GitBranch | null>;
  branches(
    page?: number,
  ): Promise<{ branches: GitBranch[]; page: number; perPage: number; hasMore: boolean }>;
  commit(ref: string): Promise<GitCommit | null>;
  latestCommit(branch: string): Promise<GitCommit | null>;
  head(branch: string): Promise<string>;
  /** Strict immutable resolution: credentials, network and missing refs remain errors. */
  revision(ref: string): Promise<string>;
  commits(branch: string, limit?: number): Promise<GitCommitDetail[]>;
  compare(base: string, head: string): Promise<GitComparison | null>;
  files(
    path: string,
    ref: string,
    signal?: AbortSignal,
  ): Promise<Array<{ name: string; type: "file" | "dir" }>>;
  tree(
    ref: string,
    options?: { requireComplete?: boolean; signal?: AbortSignal },
  ): Promise<Array<{ path: string; type: "file" | "dir" }>>;
  file(path: string, ref?: string, signal?: AbortSignal): Promise<GitFile>;
  assertAccess(operation?: "list" | "read" | "write"): Promise<void>;
  /** User-visible file reads enforce path-level source grants, unlike build reads. */
  readFile(path: string, ref: string): Promise<GitFile>;
  browseFiles(
    path?: string,
    ref?: string,
  ): Promise<Awaited<ReturnType<GitOperations["listFiles"]>>>;
  browseTree(ref?: string): Promise<Array<{ path: string; type: "file" | "dir" }>>;
  fileUrl(path: string, ref: string): Promise<string>;
  workflows?: GitWorkflowSource;
  changes?: GitSourceChanges;
  pullRequests?: GitPullRequests;
  webhooks?: GitRepositoryWebhooks;
  /** Optional provider capability. The durable delivery loop remains shared. */
  checks?: {
    sync(
      id: string | null,
      update: GitCheckUpdate,
      options?: GitCheckOptions,
    ): Promise<{
      id: string | null;
      error: string | null;
      unavailable?: boolean;
      skipped?: boolean;
    }>;
  };
}

export interface GitProvider {
  readonly id: string;
  readonly name: string;
  currentUser?(ctx: ExecutionContext): Promise<import("@repo/core").ActionActorIdentity | null>;
  readonly access: GitProviderAccess;
  readonly errors: GitProviderErrors;
  readonly connections: GitProviderConnections;
  /** A supported optimization, not an inference from the presence of a repo owner. */
  readonly preferTargetClone: boolean;
  openCloneRelay?(options: {
    serverId: string;
    executor: import("@repo/adapters").CommandExecutor;
    sessionId: string;
    expectedOwner?: string;
    expectedRepo?: string;
  }): Promise<{ scriptPath: string; close(): Promise<void> } | null>;
  readonly grantTypes: { root: string; namespace: string; repository: string };
  grantResources(
    ctx: ExecutionContext,
    kind: "namespace" | "repository",
    namespace?: string,
  ): Promise<Array<{ id: string; label: string; meta: Record<string, string> }>>;
  cloneUrl(
    organizationId: string,
    ref: GitRepositoryRef,
    installationId?: number | null,
  ): Promise<string | null>;
  readonly preflight: GitPreflight;
  /** null means no usable connection. Results have already passed provider authorization. */
  listRepositories(
    ctx: ExecutionContext,
    namespace?: string,
  ): Promise<GitRepositorySummary[] | null>;
  resolveCloneCredentials(options: GitCloneOptions): Promise<BuildGitCredential>;
  repository(ctx: ExecutionContext, ref: GitRepositoryRef, options?: GitReadOptions): GitRepository;
}
