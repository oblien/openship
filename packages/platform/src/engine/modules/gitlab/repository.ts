import { AppError, GITLAB_PROVIDER, gitRepositoryLink, normalizeRepoPath } from "@repo/core";
import type { ExecutionContext } from "../../../context";
import { createGitAccess, filterTreeEntries } from "../git/access";
import type { GitRepository, GitRepositoryRef } from "../git/types";
import {
  allPages,
  gitlabRequest,
  isGitLabStatus,
  projectConnection,
  projectPath,
  segment,
} from "./client";
import { projectHooks } from "./webhooks";

export const gitlabAccess = createGitAccess(GITLAB_PROVIDER.grantTypes);

interface TreeEntry {
  id: string;
  name: string;
  path: string;
  type: "blob" | "tree" | "commit";
}
interface Commit {
  id: string;
  message: string;
  author_name: string;
  committed_date: string;
  web_url: string;
}
interface Branch {
  name: string;
  protected: boolean;
  commit: Commit;
}

export function gitlabRepository(ctx: ExecutionContext, ref: GitRepositoryRef): GitRepository {
  const path = projectPath(ref);
  const base = "projects/" + segment(path);
  const target = { owner: ref.namespace, repo: ref.name };
  const web = gitRepositoryLink(ref.provider, ref.namespace, ref.name)!;
  async function assertAccess(operation: "list" | "read" | "write" = "read") {
    if (!ctx.organizationId || !(await gitlabAccess.canUse(ctx, target, operation)))
      throw new AppError(
        "You do not have access to this GitLab project.",
        403,
        "GIT_ACCESS_DENIED",
      );
  }
  let connection: ReturnType<typeof projectConnection> | undefined;
  async function connect() {
    await assertAccess();
    return (connection ??= projectConnection(ctx.organizationId, ref));
  }
  async function request<T>(suffix: string, params?: Record<string, string>, signal?: AbortSignal) {
    return gitlabRequest<T>(base + suffix, (await connect()).token, params, { signal });
  }
  async function entries(path: string, branch?: string, recursive = false, signal?: AbortSignal) {
    return (
      await allPages((page) =>
        request<TreeEntry[]>(
          "/repository/tree",
          {
            path,
            ...(branch ? { ref: branch } : {}),
            recursive: String(recursive),
            page,
            per_page: "100",
          },
          signal,
        ),
      )
    ).map((row) => ({
      name: row.name,
      path: row.path,
      sha: row.id,
      size: 0,
      download_url: null,
      type: row.type === "tree" ? ("dir" as const) : ("file" as const),
    }));
  }
  async function authorized(raw: string, tier: "content" | "content-tree") {
    const path = normalizeRepoPath(raw);
    if (path === null) throw new AppError("Invalid repository path", 400);
    const { ok, readPaths } = await gitlabAccess.checkSource(ctx, target, tier, path);
    if (!ok) throw new AppError("File not found", 404);
    return { path, readPaths };
  }
  async function file(path: string, branch?: string, signal?: AbortSignal) {
    const row = await request<{ blob_id: string; size: number; content: string }>(
      "/repository/files/" + segment(path),
      { ref: branch ?? "HEAD" },
      signal,
    );
    return {
      sha: row.blob_id,
      size: row.size,
      content: Buffer.from(row.content, "base64").toString("utf8"),
    };
  }
  async function branches(page = 1) {
    const rows = await request<Branch[]>("/repository/branches", {
      page: String(page),
      per_page: "100",
    });
    return {
      branches: rows.map((row) => ({
        name: row.name,
        protected: row.protected,
        sha: row.commit.id,
      })),
      page,
      perPage: 100,
      hasMore: rows.length === 100,
    };
  }
  const getCommit = (revision: string) =>
    request<Commit>("/repository/commits/" + segment(revision));
  async function commit(revision: string) {
    try {
      const row = await getCommit(revision);
      return { sha: row.id, message: row.message };
    } catch (error) {
      if (isGitLabStatus(error, 404)) return null;
      throw error;
    }
  }
  return {
    ref,
    assertAccess,
    file,
    branches,
    commit,
    latestCommit: commit,
    async info(options) {
      const { project } = await connect();
      const page = options?.withBranches ? await branches() : undefined;
      return {
        id: project.id,
        name: project.path,
        full_name: project.path_with_namespace,
        private: project.visibility !== "public",
        owner: project.namespace.full_path,
        default_branch: project.default_branch ?? "",
        clone_url: web + ".git",
        html_url: web,
        ssh_url: "git@gitlab.com:" + path + ".git",
        ...(page
          ? {
              branches: page.branches.map(({ name }) => ({ name })),
              branches_has_more: page.hasMore,
            }
          : {}),
      };
    },
    async branch(name) {
      try {
        const row = await request<Branch>("/repository/branches/" + segment(name));
        return { name: row.name, protected: row.protected, sha: row.commit.id };
      } catch (error) {
        if (isGitLabStatus(error, 404)) return null;
        throw error;
      }
    },
    async head(name) {
      return (await request<Branch>("/repository/branches/" + segment(name))).commit.id;
    },
    async revision(ref) {
      return (await getCommit(ref)).id;
    },
    async commits(branch, limit = 20) {
      return (
        await request<Commit[]>("/repository/commits", {
          ref_name: branch,
          per_page: String(Math.min(100, Math.max(1, limit))),
        })
      ).map((row) => ({
        sha: row.id,
        message: row.message,
        author: row.author_name,
        authorAvatar: "",
        date: row.committed_date,
        url: row.web_url,
      }));
    },
    async compare(base, head) {
      try {
        const data = await request<{
          compare_timeout?: boolean;
          diffs: Array<{
            old_path: string;
            new_path: string;
            collapsed?: boolean;
            too_large?: boolean;
          }>;
        }>("/repository/compare", { from: base, to: head, straight: "true" });
        return {
          files: [...new Set(data.diffs.flatMap((row) => [row.old_path, row.new_path]))],
          truncated:
            !!data.compare_timeout ||
            data.diffs.length >= 1000 ||
            data.diffs.some((d) => d.collapsed || d.too_large),
        };
      } catch (error) {
        // GitLab can discard the previous revision after a force push. The
        // shared deployment pipeline falls back to a full rebuild in that case.
        if (isGitLabStatus(error, 404)) return null;
        throw error;
      }
    },
    files: (path, branch, signal) => entries(path, branch, false, signal),
    tree: (branch, options) => entries("", branch, true, options?.signal),
    async readFile(raw, branch) {
      return file((await authorized(raw, "content")).path, branch);
    },
    async browseFiles(raw = "", branch) {
      const { path, readPaths } = await authorized(raw, "content-tree");
      return filterTreeEntries(await entries(path, branch), readPaths, (e) => ({
        path: e.path,
        isDirectory: e.type === "dir",
      }));
    },
    async browseTree(branch) {
      const { readPaths } = await authorized("", "content-tree");
      return filterTreeEntries(await entries("", branch, true), readPaths, (e) => ({
        path: e.path,
        isDirectory: e.type === "dir",
      }));
    },
    async fileUrl(path, branch) {
      return web + "/-/blob/" + segment(branch) + "/" + path.split("/").map(segment).join("/");
    },
    webhooks: projectHooks(ctx.organizationId, ref, () => assertAccess("write")),
  };
}
