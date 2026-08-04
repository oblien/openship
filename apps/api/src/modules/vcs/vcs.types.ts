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
import type { GitHubPushPayload } from "../github/github.types";
export type VcsPushPayload = GitHubPushPayload;
