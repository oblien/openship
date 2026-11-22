import type { ExecutionContext } from "../../../context";
import type { DatabaseTransaction } from "@repo/db";
import type { ResolvedSourceAccess } from "@repo/core";
import type {
  PublishRepositoryChangeInput,
  PublishedRepositoryChange,
  RepositoryChangeAccess,
} from "@repo/contracts";

export interface GitAccessTarget {
  owner: string;
  repo?: string | null;
  installationId?: string | number | null;
}
export type GitAccessOperation = "list" | "read" | "write";
export type GitSourceTier = "content" | "content-tree" | "content-whole" | "write";
export interface GitProviderAccess {
  canUse(
    ctx: ExecutionContext,
    target: GitAccessTarget,
    operation: GitAccessOperation,
    options?: { ownerLevel?: "reach" | "authority" },
  ): Promise<boolean>;
  source(ctx: ExecutionContext, target: GitAccessTarget): Promise<ResolvedSourceAccess>;
  checkSource(
    ctx: ExecutionContext,
    target: GitAccessTarget,
    tier: GitSourceTier,
    path: string,
  ): Promise<{ ok: boolean; readPaths: string[] }>;
}

export interface GitProviderErrors {
  status(error: unknown): number | undefined | Promise<number | undefined>;
  isMissingFile(error: unknown): boolean | Promise<boolean>;
  isTransient(error: unknown): boolean | Promise<boolean>;
  isCredentialFailure(error: unknown): boolean | Promise<boolean>;
  credentialError(): Error | Promise<Error>;
}

export interface GitSourceChanges {
  access(paths: string[]): Promise<RepositoryChangeAccess>;
  publish(
    input: Omit<PublishRepositoryChangeInput, "owner" | "repo">,
  ): Promise<PublishedRepositoryChange>;
}

/** The existing preview projection, kept separate from a provider's webhook payload. */
export interface GitPullRequest {
  state: "open" | "closed";
  draft?: boolean;
  number: number;
  head: { sha: string; ref: string; repo: { full_name: string } | null };
  base: { ref: string; repo: { full_name: string } };
}
export interface GitPullRequests {
  list(options: { base?: string | null; page?: number }): Promise<GitPullRequest[]>;
  get(number: number): Promise<GitPullRequest>;
  comments(number: number, page: number): Promise<Array<{ id: string; body: string }>>;
  comment(number: number, body: string, id?: string): Promise<string>;
}

/** Workflow source support is explicit. A Git adapter need not implement a CI engine. */
export interface GitWorkflowSource {
  readonly controllers: readonly ("openship" | "github")[];
  readonly paths: readonly string[];
  /** Decode only a verified event from this provider; never infer identities across providers. */
  eventActor?(
    event: Record<string, unknown>,
  ): Promise<import("@repo/core").ActionActorIdentity | null>;
  assertExecution(): Promise<void>;
  assertRequiredChecks(): Promise<void>;
  inspectChecks(
    controller: "openship" | "github",
  ): Promise<import("@repo/contracts").ActionRepositoryChecks>;
  syncCheck(
    run: import("@repo/db").ActionRun,
    job: import("@repo/db").ActionJob,
  ): Promise<{ id: string | null; error: string | null; unavailable?: boolean; skipped?: boolean }>;
  resolveRef(ref: string, preference?: "branch" | "tag"): Promise<string>;
  updateFile(input: {
    path: string;
    branch: string;
    sha: string;
    content: string;
    message: string;
  }): Promise<{ sha: string; commit: string }>;
  token(permissions: Record<string, "read" | "write">): Promise<string | null>;
  actor(login: string): Promise<import("@repo/core").ActionActorIdentity | null>;
  canWrite(actor: import("@repo/core").ActionActorIdentity): Promise<boolean>;
}

export type GitWebhookStrategy = "app" | "domain" | "repo" | "none";
export interface GitWebhookProject {
  webhookDomain?: string | null;
  organizationId?: string | null;
}
export interface GitProviderConnections {
  /** Implemented by adapters that derive repository access from the OpenShip Cloud session. */
  cloudSession?: {
    invalidateCache(userId: string, organizationIds: readonly string[]): Promise<void>;
    /** Namespaces with independent access. Null means this configuration uses no Cloud repository access. */
    retainedNamespaces(tx: DatabaseTransaction, organizationId: string): Promise<string[] | null>;
  };
  domainWebhookUrl?(hostname: string, scheme?: "http" | "https"): string | Promise<string>;
  strategy(project?: GitWebhookProject, organizationId?: string): Promise<GitWebhookStrategy>;
  strategies(
    ctx: ExecutionContext,
    project?: GitWebhookProject,
  ): Promise<{ current: GitWebhookStrategy; available: GitWebhookStrategy[] }>;
  installation(organizationId: string, owner: string): Promise<number | null>;
  installUrl(ctx: ExecutionContext): Promise<{ url: string }>;
  managesInstallations(organizationId: string): Promise<boolean>;
}
