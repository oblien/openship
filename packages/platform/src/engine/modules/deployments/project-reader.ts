import * as githubService from "../github/github.service";
import type { ExecutionContext as RequestContext } from "@repo/platform";
import type { RepoFile } from "../../lib/stack-detector";
import type { RepoTreeEntry } from "../../lib/project-root-detector";

// GitHub reader behind the ProjectReader interface. Its local-filesystem
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
