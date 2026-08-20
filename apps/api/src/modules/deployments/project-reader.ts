import * as githubService from "../github/github.service";
import * as azureService from "../azure/azure.service";
import type { RequestContext } from "../../lib/request-context";
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

export function createAzureReader(
  ctx: RequestContext,
  org: string,
  project: string,
  repo: string,
  branch: string,
): ProjectReader {
  let treePromise: Promise<RepoTreeEntry[]> | null = null;

  const readText = async (path: string) => {
    try {
      return await azureService.getItemContent(ctx, org, project, repo, path, branch);
    } catch {
      return undefined;
    }
  };

  return {
    listDirectory: async (path: string) => {
      try {
        const items = await azureService.listItems(ctx, org, project, repo, {
          path: path || undefined,
          branch,
        });
        const prefix = path ? (path.startsWith("/") ? path : `/${path}`).replace(/\/+$/, "") : "";
        return items
          .filter((item) => {
            if (!item.path) return false;
            if (!prefix) {
              const trimmed = item.path.replace(/^\//, "");
              return trimmed !== "" && !trimmed.includes("/");
            }
            if (item.path === prefix) return false;
            const rest = item.path.slice(prefix.length).replace(/^\//, "");
            return rest.length > 0 && !rest.includes("/");
          })
          .map((item) => ({
            name: (item.path ?? "").split("/").filter(Boolean).pop() ?? "",
            type: item.isFolder ? "dir" : "file",
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
        treePromise = azureService.listItems(ctx, org, project, repo, { branch }).then((items) =>
          items
            .filter((item) => item.path && !item.isFolder)
            .map((item) => ({
              path: (item.path ?? "").replace(/^\//, ""),
              type: "blob" as const,
            })),
        );
      }
      return treePromise;
    },
  };
}
