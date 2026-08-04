import { VcsStrategyFactory } from "../vcs/vcs.factory";
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
  const vcs = VcsStrategyFactory.getStrategy("github");

  const readText = async (path: string) => {
    try {
      const file = await vcs.getFileContent(ctx, owner, repo, path, branch);
      return file?.content;
    } catch {
      return undefined;
    }
  };

  return {
    listDirectory: async (path: string) => {
      try {
        if (!treePromise) {
          treePromise = vcs
            .getTree(ctx, owner, repo, branch)
            .then((r) => r.tree as RepoTreeEntry[]);
        }
        const tree = await treePromise;
        const prefix = path ? (path.endsWith("/") ? path : path + "/") : "";
        const files = tree.filter((t) => {
          if (!prefix && !t.path.includes("/")) return true;
          if (prefix && t.path.startsWith(prefix)) {
            const rest = t.path.slice(prefix.length);
            return !rest.includes("/");
          }
          return false;
        });
        return files.map((f) => ({
          name: f.path.split("/").pop()!,
          type: f.type === "tree" || f.type === "dir" ? "dir" : "file",
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
        treePromise = vcs.getTree(ctx, owner, repo, branch).then((r) => r.tree as RepoTreeEntry[]);
      }
      return treePromise;
    },
  };
}
