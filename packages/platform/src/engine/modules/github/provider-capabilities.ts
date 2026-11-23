/** GitHub-specific policies exposed to shared workflows by the Git adapter. */
import { AppError } from "@repo/core";
import type { ExecutionContext } from "../../../context";
import type { GitPullRequests, GitProviderErrors } from "../git/capabilities";
import { githubFetch } from "./github.auth";
import { GitHubApiError, isTransientGitHubFailure } from "./github.error";
import { GitHubAppApiError } from "./github.app-client";
import {
  isRepositoryCredentialFailure,
  repositoryCredentialError,
} from "./repository-change-access";

export const githubErrors: GitProviderErrors = {
  status(error) {
    if (error instanceof AppError) return error.statusCode;
    if (error instanceof GitHubApiError) return error.status;
    // Compatibility with legacy GitHub transport errors until all callers use GitHubApiError.
    const message = error instanceof Error ? error.message : "";
    if (message.includes("No GitHub access token")) return 401;
    return /GitHub API error \((\d{3})\)/.exec(message)?.[1]
      ? Number(/GitHub API error \((\d{3})\)/.exec(message)![1])
      : undefined;
  },
  isMissingFile: (error) =>
    error instanceof GitHubApiError &&
    error.status === 404 &&
    !(error instanceof GitHubAppApiError),
  isTransient: (error) => error instanceof GitHubApiError && isTransientGitHubFailure(error),
  isCredentialFailure: isRepositoryCredentialFailure,
  credentialError: repositoryCredentialError,
};

export function githubPullRequests(
  ctx: ExecutionContext,
  owner: string,
  repo: string,
): GitPullRequests {
  const root = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const request = <T>(
    url: string,
    method: "GET" | "POST" | "PATCH" = "GET",
    params?: Record<string, unknown>,
  ) => githubFetch<T>({ ctx, owner, repo, url, method, params, authorizeAs: "read" });
  return {
    list: ({ base, page }) =>
      request(`${root}/pulls`, "GET", {
        state: "open",
        base,
        per_page: 100,
        ...(page === undefined ? {} : { page }),
      }),
    get: (number) => request(`${root}/pulls/${number}`),
    async comments(number, page) {
      const rows = await request<Array<{ id: number; body: string }>>(
        `${root}/issues/${number}/comments?per_page=100&page=${page}`,
      );
      return rows.map((row) => ({ id: String(row.id), body: row.body }));
    },
    async comment(number, body, id) {
      if (id) {
        await request(`${root}/issues/comments/${encodeURIComponent(id)}`, "PATCH", { body });
        return id;
      }
      return String(
        (await request<{ id: number }>(`${root}/issues/${number}/comments`, "POST", { body })).id,
      );
    },
  };
}
