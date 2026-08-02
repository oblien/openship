import * as githubService from "../github/github.service";
import * as gitlabService from "../gitlab/gitlab.service";
import type { RequestContext } from "../../lib/request-context";
import type { RepoFile } from "../../lib/stack-detector";
import type { RepoTreeEntry } from "../../lib/project-root-detector";

// GitHub / GitLab readers behind the ProjectReader interface. Local-filesystem
// counterpart lives in local-source.ts (self-hosted only) so node:fs never
// enters the cloud module graph.
export interface ProjectReader {
  listDirectory: (path: string) => Promise<RepoFile[]>;
  readText: (path: string) => Promise<string | undefined>;
  readJson: (path: string) => Promise<Record<string, unknown> | undefined>;
  listTree: () => Promise<RepoTreeEntry[]>;
}

export function createGitHubReader(
  ctx: RequestContext,
  owner: string,
  repo: string,
  branch: string,
): ProjectReader {
  let treePromise: Promise<RepoTreeEntry[]> | null = null;

  const readText = async (path: string) => {
    try {
      const file = await githubService.getFileContent(ctx, owner, repo, path, { branch });
      return file?.content;
    } catch {
      return undefined;
    }
  };

  return {
    listDirectory: async (path: string) => {
      try {
        const contents = await githubService.listFiles(ctx, owner, repo, {
          branch,
          ...(path ? { path } : {}),
        });

        return Array.isArray(contents)
          ? contents.map((file) => ({
              name: file.name,
              type: file.type === "dir" ? "dir" : "file",
            }))
          : [];
      } catch {
        return [];
      }
    },
    readText,
    readJson: async (path: string) => {
      const content = await readText(path);
      if (!content) return undefined;
      try {
        return JSON.parse(content);
      } catch {
        return undefined;
      }
    },
    listTree: async () => {
      if (!treePromise) {
        treePromise = githubService.listRepositoryTree(ctx, owner, repo, { branch });
      }
      return treePromise;
    },
  };
}

export function createGitLabReader(
  ctx: RequestContext,
  projectId: number,
  branch: string,
): ProjectReader {
  let treePromise: Promise<RepoTreeEntry[]> | null = null;

  const readText = async (path: string) =>
    gitlabService.getFileRaw(ctx, projectId, path, branch);

  return {
    listDirectory: async (path: string) => {
      try {
        const entries = await gitlabService.listTree(ctx, projectId, {
          ref: branch,
          path: path || undefined,
        });
        return entries.map((e) => ({
          name: e.name,
          type: e.type === "tree" ? ("dir" as const) : ("file" as const),
        }));
      } catch {
        return [];
      }
    },
    readText,
    readJson: async (path: string) => {
      const content = await readText(path);
      if (!content) return undefined;
      try {
        return JSON.parse(content);
      } catch {
        return undefined;
      }
    },
    listTree: async () => {
      if (!treePromise) {
        treePromise = gitlabService
          .listTree(ctx, projectId, { ref: branch, recursive: true })
          .then((entries) =>
            entries.map((e) => ({
              path: e.path,
              type: e.type === "tree" ? ("tree" as const) : ("blob" as const),
            })),
          );
      }
      return treePromise;
    },
  };
}
