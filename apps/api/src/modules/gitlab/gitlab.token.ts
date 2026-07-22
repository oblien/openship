/**
 * @module gitlab.token
 *
 * Token dispatcher for GitLab. No CLI / App installation chain —
 * project PAT → user GitLab PAT → OAuth.
 */

import { repos } from "@repo/db";
import { AppError } from "@repo/core";
import { decrypt } from "../../lib/encryption";
import {
  getUserGitlabToken,
  readUserGitlabPat,
} from "./gitlab.auth";
import type { RequestContext } from "../../lib/request-context";

export type GitLabPurpose = "local" | "remote";

export type GitLabTokenSource = "project" | "user-pat" | "user-oauth";

export interface GitLabTokenResult {
  token: string;
  source: GitLabTokenSource;
}

export interface GitLabTokenContext {
  projectId?: string;
  /** Numeric GitLab project id (stored as installationId). */
  projectGitlabId?: number;
  owner?: string;
  repo?: string;
}

async function readProjectToken(projectId: string): Promise<string | null> {
  const project = await repos.project.findById(projectId);
  if (!project?.cloneTokenEncrypted) return null;
  try {
    return decrypt(project.cloneTokenEncrypted);
  } catch {
    return null;
  }
}

export async function tokenFor(
  ctx: RequestContext,
  _purpose: GitLabPurpose,
  tokenCtx: GitLabTokenContext = {},
): Promise<GitLabTokenResult | null> {
  if (tokenCtx.projectId) {
    const t = await readProjectToken(tokenCtx.projectId);
    if (t) return { token: t, source: "project" };
  }

  const userPat = await readUserGitlabPat(ctx.userId);
  if (userPat) return { token: userPat, source: "user-pat" };

  const oauth = await getUserGitlabToken(ctx.userId);
  if (oauth) return { token: oauth, source: "user-oauth" };

  return null;
}

export async function requireTokenFor(
  ctx: RequestContext,
  purpose: GitLabPurpose,
  tokenCtx: GitLabTokenContext = {},
): Promise<GitLabTokenResult> {
  const result = await tokenFor(ctx, purpose, tokenCtx);
  if (result) return result;
  throw new AppError(
    "No GitLab token available. Connect GitLab in Settings (OAuth or personal access token), or set a per-project clone token.",
    403,
    "NO_GITLAB_TOKEN",
  );
}

export async function canResolveTokenFor(
  ctx: RequestContext,
  purpose: GitLabPurpose,
  tokenCtx: GitLabTokenContext = {},
): Promise<GitLabTokenSource | null> {
  const r = await tokenFor(ctx, purpose, tokenCtx);
  return r?.source ?? null;
}
