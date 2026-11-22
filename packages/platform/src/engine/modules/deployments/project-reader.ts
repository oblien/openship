import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { gitRepository } from "../git/provider";
import type { GitReadOptions, GitRepository } from "../git/types";
import type { ExecutionContext as RequestContext } from "@repo/platform";
import type { RepoFile } from "../../lib/stack-detector";
import type { RepoTreeEntry } from "../../lib/project-root-detector";

// Provider-backed reader behind the ProjectReader interface. Its local-filesystem
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
  opts: GitReadOptions = {},
): ProjectReader {
  return createGitReader(gitRepository(ctx, { provider: "github", namespace: owner, name: repo }, opts), branch);
}

export function createGitReader(repository: GitRepository, branch: string): ProjectReader {
  let treePromise: Promise<RepoTreeEntry[]> | null = null;

  const readText = async (path: string) => {
    try {
      const file = await repository.file(path, branch);
      return file?.content;
    } catch (diagnosticFailure) {
      observeCaughtError(diagnosticFailure, "platform/engine/modules/deployments/project-reader");
      return undefined;
    }
  };

  return {
    listDirectory: async (path: string) => {
      try {
        return await repository.files(path, branch);
      } catch (diagnosticFailure) {
        observeCaughtError(diagnosticFailure, "platform/engine/modules/deployments/project-reader");
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
        treePromise = repository.tree(branch);
      }
      return treePromise;
    },
  };
}
