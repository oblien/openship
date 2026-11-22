import { AppError, GITHUB_PROVIDER } from "@repo/core";
import type { ExecutionContext as RequestContext } from "@repo/platform";
import { createGitAccess } from "../git/access";
import type { GitAccessTarget, GitAccessOperation, GitSourceTier } from "../git/capabilities";
export { filterTreeEntries } from "../git/access";

export type GitHubAccessOp = GitAccessOperation;
export type GitHubAccessTarget = GitAccessTarget;
export type SourceTier = GitSourceTier;
export type OwnerLevelMode = "reach" | "authority";

export const {
  canUse: canUseGitHubRepo,
  source: resolveSourceAccess,
  checkSource: checkSourceTier,
  canListRepoPath,
  filterAllowedRepos,
  filterAllowedAccounts,
} = createGitAccess(GITHUB_PROVIDER.grantTypes);

export async function canMintInstallationToken(
  ctx: RequestContext,
  owner: string,
  repos?: string[],
  access: GitHubAccessOp = "read",
): Promise<boolean> {
  const named = (repos ?? []).map((r) => r.trim()).filter(Boolean);
  if (!named.length) {
    return canUseGitHubRepo(ctx, { owner }, access, { ownerLevel: "authority" });
  }
  const results = await Promise.all(
    named.map((repo) => canUseGitHubRepo(ctx, { owner, repo }, access)),
  );
  return results.every(Boolean);
}

/**
 * Hard-assert GitHub access for a deploy-style action and throw a clear
 * 403 when denied. Use at deploy / redeploy / rollback entry points so a
 * blocked member is stopped UP FRONT with an actionable message — instead
 * of falling through to their personal OAuth/PAT (which would bypass the
 * owner's control on a local build) or failing opaquely mid-build.
 *
 * No-op for non-GitHub projects (no owner/repo → nothing to gate).
 */
export async function assertGitHubRepoAccess(
  ctx: RequestContext,
  target: { owner?: string | null; repo?: string | null },
  op: GitHubAccessOp = "read",
): Promise<void> {
  if (!target.owner || !target.repo) return;
  const allowed = await canUseGitHubRepo(ctx, { owner: target.owner, repo: target.repo }, op);
  if (allowed) return;
  throw new AppError(
    `You don't have access to ${target.owner}/${target.repo}. Ask an organization owner to grant you access to this repository.`,
    403,
    "GITHUB_ACCESS_DENIED",
  );
}
