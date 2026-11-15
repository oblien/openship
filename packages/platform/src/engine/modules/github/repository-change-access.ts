import { AppError } from "@repo/core";
import type { RepositoryChangeAccess } from "@repo/contracts";
import type { ExecutionContext } from "../../../context";
import { assertGitHubRepoAccess, checkSourceTier } from "./github-access";
import { githubFetch } from "./github.auth";
import { GitHubApiError, isTransientGitHubFailure } from "./github.error";

export const REPOSITORY_PR_PERMISSIONS = { contents: "write", pull_requests: "write" } as const;

/** Shared by the editor's preflight and the publisher's per-request authorization. */
export async function assertRepositoryChangeAccess(
  ctx: ExecutionContext,
  owner: string,
  repo: string,
  paths: string[],
) {
  if (ctx.credential?.readOnly)
    throw new AppError(
      "Repository writes were not approved.",
      403,
      "REPOSITORY_CHANGE_ACCESS_REQUIRED",
    );
  await assertGitHubRepoAccess(ctx, { owner, repo }, "write");
  for (const path of paths)
    if (
      !(await checkSourceTier(ctx, { owner, repo }, "write", path)).ok ||
      !(await checkSourceTier(ctx, { owner, repo }, "content", path)).ok
    )
      throw new AppError(
        "Ask your workspace owner for write access to this source file.",
        403,
        "REPOSITORY_CHANGE_ACCESS_REQUIRED",
      );
}

export function isRepositoryCredentialFailure(error: unknown): boolean {
  if (isTransientGitHubFailure(error)) return false;
  return error instanceof GitHubApiError
    ? error.credentialRejected ||
        error.status === 404 ||
        (error.name === "GitHubAppApiError" && error.status === 422)
    : error instanceof AppError && error.code === "GITHUB_TOKEN_REQUIRED";
}

export function repositoryCredentialError(): AppError {
  return new AppError(
    "Update your GitHub connection for this repository with Contents and Pull requests set to Read and write, then check access again. An organization owner may need to approve the updated App permissions.",
    403,
    "REPOSITORY_GITHUB_ACCESS_REQUIRED",
  );
}

/** Read-only preflight, using the same write credential as publication. No test branches/PRs.
 * App scopes are verified at mint. User tokens have no universal permission introspection;
 * repo/read checks find known blockers, and actual writes remain authoritative. */
export async function getRepositoryChangeAccess(
  ctx: ExecutionContext,
  owner: string,
  repo: string,
  paths: string[],
): Promise<RepositoryChangeAccess> {
  try {
    await assertRepositoryChangeAccess(ctx, owner, repo, paths);
  } catch (error) {
    if (error instanceof AppError && error.statusCode === 403) return "workspace_access_required";
    throw error;
  }
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  try {
    const repository = await githubFetch<{
      archived?: boolean;
      disabled?: boolean;
      permissions?: { push?: boolean };
    }>({
      ctx,
      owner,
      repo,
      url,
      authorizeAs: "write",
      installationPermissions: REPOSITORY_PR_PERMISSIONS,
    });
    if (repository.archived || repository.disabled) return "repository_read_only";
    if (repository.permissions?.push === false) return "github_access_required";
    await githubFetch({
      ctx,
      owner,
      repo,
      url: `${url}/pulls`,
      params: { per_page: 1 },
      authorizeAs: "write",
      installationPermissions: REPOSITORY_PR_PERMISSIONS,
    });
    return "available";
  } catch (error) {
    if (isRepositoryCredentialFailure(error)) return "github_access_required";
    throw error;
  }
}
