import { AppError, normalizeRepoPath } from "@repo/core";
import type { PublishRepositoryChangeInput } from "@repo/contracts";
import type { ExecutionContext } from "../../../context";
import { githubFetch } from "./github.auth";
import { assertGitHubRepoAccess, checkSourceTier } from "./github-access";
import { audit, operationAuditContext } from "../../lib/audit-emitter";
import {
  captureExecutionAuthority,
  resolveExecutionAuthority,
} from "../../lib/execution-authority";

const fail = (message: string, status = 409) => new AppError(message, status, "REPOSITORY_CHANGE");
const sha = (value: string) => {
  if (!/^[a-f0-9]{40}$/.test(value ?? "")) throw fail("GitHub returned an invalid Git object.");
  return value;
};

/** Ordinary GitHub operation, shared by HTTP, SDK and MCP; no agent-specific credentials. */
export async function publishChange(ctx: ExecutionContext, input: PublishRepositoryChangeInput) {
  const { owner, repo, patch } = input;
  const paths = patch.files.map((f) => f.path);
  if (
    !patch.title.trim() ||
    paths.some(
      (path) =>
        !path ||
        normalizeRepoPath(path) !== path ||
        path
          .split("/")
          .some((part) => part.toLowerCase() === ".git" || /[\x00-\x1f\x7f]/.test(part)),
    ) ||
    new Set(paths).size !== paths.length ||
    paths.some((path) => paths.some((other) => other !== path && path.startsWith(`${other}/`))) ||
    patch.files.reduce((n, f) => n + Buffer.byteLength(f.content), 0) > 256000
  )
    throw fail("Choose distinct repository files and a patch smaller than 256 KB.", 400);
  if (
    !patch.baseBranch.trim() ||
    /[\x00-\x20~^:?*\[\\]/.test(patch.baseBranch) ||
    patch.baseBranch.includes("..") ||
    patch.baseBranch.includes("@{") ||
    patch.baseBranch.startsWith("-") ||
    patch.baseBranch.endsWith(".lock")
  )
    throw fail("Choose a valid base branch.", 400);
  const authority = await captureExecutionAuthority(ctx);
  async function authorize() {
    const current = await resolveExecutionAuthority(authority, "repository-change");
    if (current.credential?.readOnly) throw fail("Repository writes were not approved.", 403);
    await assertGitHubRepoAccess(current, { owner, repo }, "write");
    for (const path of paths)
      if (
        !(await checkSourceTier(current, { owner, repo }, "write", path)).ok ||
        !(await checkSourceTier(current, { owner, repo }, "content", path)).ok
      )
        throw fail("This patch includes a file outside your approved source access.", 403);
    return current;
  }
  await authorize();
  const root = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  async function request<T>(
    path: string,
    method: "GET" | "POST" = "GET",
    params?: Record<string, unknown>,
  ) {
    return githubFetch<T>({
      ctx: await authorize(),
      owner,
      repo,
      url: `${root}${path}`,
      method,
      params,
      authorizeAs: "write",
    });
  }
  const head = async () => {
    const ref = await request<{ object: { sha: string } }>(
      `/git/ref/heads/${encodeURIComponent(patch.baseBranch)}`,
    );
    if (ref.object.sha !== patch.baseSha)
      throw fail("The base branch changed. Review a new patch against its current commit.");
  };
  await head();
  const commit = await request<{ tree: { sha: string } }>(`/git/commits/${sha(patch.baseSha)}`);
  const tree = await request<{
    truncated: boolean;
    tree: { path: string; mode: string; type: string }[];
  }>(`/git/trees/${sha(commit.tree.sha)}?recursive=1`);
  if (tree.truncated) throw fail("This repository is too large to verify this patch safely.");
  const entries = new Map(tree.tree.map((item) => [item.path, item]));
  const changes = patch.files.map((file) => {
    const previous = entries.get(file.path);
    const parents = file.path
      .split("/")
      .slice(0, -1)
      .map((_, i, parts) => parts.slice(0, i + 1).join("/"));
    if (
      (previous && !["100644", "100755"].includes(previous.mode)) ||
      parents.some((path) => entries.has(path) && entries.get(path)!.type !== "tree")
    )
      throw fail(
        "Patches can change regular files only; directories, symlinks and submodules are excluded.",
        400,
      );
    return {
      path: file.path,
      mode: previous?.mode ?? "100644",
      type: "blob",
      content: file.content,
    };
  });
  const next = await request<{ sha: string }>("/git/trees", "POST", {
    base_tree: commit.tree.sha,
    tree: changes,
  });
  if (next.sha === commit.tree.sha) throw fail("The patch does not change any files.", 400);
  const created = await request<{ sha: string; html_url: string }>("/git/commits", "POST", {
    message: patch.title,
    tree: sha(next.sha),
    parents: [patch.baseSha],
  });
  // Objects remain unreachable until this single create-ref. Never overwrite a branch,
  // including on duplicate requests or an uncertain previous response.
  await head();
  const branch = `openship/changes/${input.requestId}`;
  await request("/git/refs", "POST", { ref: `refs/heads/${branch}`, sha: sha(created.sha) });
  audit.recordAsync(operationAuditContext(ctx), {
    eventType: "github.change.published",
    resourceType: "github_repository",
    resourceId: `${owner}/${repo}`,
    after: { branch, commitSha: created.sha, fileCount: paths.length },
  });
  let pullRequestUrl: string | null = null;
  if (input.pullRequest) {
    try {
      const pr = await request<{ html_url: string }>("/pulls", "POST", {
        title: patch.title,
        body: patch.description,
        head: branch,
        base: patch.baseBranch,
        draft: true,
        maintainer_can_modify: false,
      });
      pullRequestUrl = pr.html_url;
    } catch {
      throw fail(
        `The commit was published to ${branch}, but the pull request was not confirmed. Review that branch in GitHub before trying again.`,
      );
    }
  }
  return { branch, commitSha: created.sha, url: created.html_url, pullRequestUrl };
}
