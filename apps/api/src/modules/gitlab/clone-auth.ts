/**
 * GitLab clone-auth — deploy-pipeline credential adapter (peer of github/clone-auth).
 */

import { type BuildStrategy } from "@repo/core";
import { tokenFor, requireTokenFor, type GitLabTokenContext } from "./gitlab.token";
import { isPublicGitlabProject } from "./gitlab.http";
import type { RequestContext } from "../../lib/request-context";

export interface BuildGitLabCredential {
  token?: string;
  /** HTTPS clone username — always oauth2 for GitLab. */
  tokenUsername?: string;
  apiHostFallback?: boolean;
}

export async function resolveBuildGitToken(opts: {
  ctx: RequestContext;
  projectId: string;
  owner?: string | null;
  repo?: string | null;
  /** Numeric GitLab project id (project.installationId). */
  gitlabProjectId?: number | null;
  buildStrategy: BuildStrategy;
  allowApiHostFallback?: boolean;
}): Promise<BuildGitLabCredential> {
  const tokenCtx: GitLabTokenContext = {
    projectId: opts.projectId,
    owner: opts.owner ?? undefined,
    repo: opts.repo ?? undefined,
    projectGitlabId: opts.gitlabProjectId ?? undefined,
  };

  const purpose = opts.buildStrategy === "local" ? "local" : "remote";
  const r = await tokenFor(opts.ctx, purpose, tokenCtx);
  if (r?.token) {
    return { token: r.token, tokenUsername: "oauth2" };
  }

  if (
    opts.gitlabProjectId &&
    (await isPublicGitlabProject(opts.gitlabProjectId))
  ) {
    return {};
  }

  if (opts.allowApiHostFallback && purpose === "remote") {
    const local = await tokenFor(opts.ctx, "local", tokenCtx);
    if (local?.token) {
      return {
        token: local.token,
        tokenUsername: "oauth2",
        apiHostFallback: true,
      };
    }
  }

  await requireTokenFor(opts.ctx, purpose, tokenCtx);
  return {};
}
