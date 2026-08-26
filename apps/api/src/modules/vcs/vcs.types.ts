import type { BuildStrategy } from "@repo/core";
import type { CommandExecutor } from "@repo/adapters";
import type { RequestContext } from "../../lib/request-context";

export interface GetCloneCredentialsOptions {
  ctx: RequestContext;
  projectId: string;
  owner?: string | null;
  repo?: string | null;
  buildStrategy: BuildStrategy;
  serverId?: string | null;
  allowRelayFallback?: boolean;
  allowApiHostFallback?: boolean;
  serverExecutor?: CommandExecutor;
}

export type WebhookStrategy = "app" | "domain" | "repo" | "none";

export interface VcsRepository {
  name: string;
  owner: string;
  default_branch: string;
  full_name?: string;
  private?: boolean;
  html_url?: string;
  description?: string | null;
  clone_url?: string;
}

export interface VcsBranch {
  name: string;
  commit?: { sha: string };
  protected?: boolean;
}

export interface VcsCommit {
  sha: string;
  message: string;
  author?: string;
  authorAvatar?: string;
  date?: string;
  url?: string;
}

export interface VcsFileContent {
  content: string;
}

export interface VcsTreeEntry {
  path: string;
  type: string;
}

export interface VcsTreeResponse {
  tree: VcsTreeEntry[];
}

export interface VcsWebhook {
  id: number;
  events?: string[];
}

export interface VcsPushCommit {
  id?: string;
  message?: string;
  added?: string[];
  modified?: string[];
  removed?: string[];
}

export interface VcsPushPayload {
  ref: string;
  deleted?: boolean;
  forced?: boolean;
  before?: string;
  after?: string;
  commits?: VcsPushCommit[];
  head_commit: VcsPushCommit | null;
  repository: {
    name: string;
    full_name: string;
    default_branch?: string;
    owner: { login: string; id: number };
  };
  sender?: { id: number; login: string };
  installation?: { id: number };
}

import { AppError } from "@repo/core";

export class UnknownVcsProviderError extends AppError {
  constructor(name: string) {
    super(`Unknown VCS provider: ${name}`, 400, "VCS_UNKNOWN_PROVIDER");
    this.name = "UnknownVcsProviderError";
  }
}
