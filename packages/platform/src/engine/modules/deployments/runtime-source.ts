import { isIgnoredRepoPath, type RepoTreeEntry } from "../../lib/project-root-detector";
import type { ProjectReader } from "./project-reader";
import {
  resolveFromReader,
  resolveSourceEnvFromReader,
  type ProjectInfo,
  type ProjectSourceEnv,
  type ResolveOptions,
} from "./prepare.service";

/**
 * Framework detection for a folder that was UPLOADED into an Oblien cloud
 * workspace (the SaaS folder-deploy flow). The counterpart of local-source.ts
 * (self-hosted, node:fs): here the source lives at `/app` inside a running
 * workspace, so the reader talks to the workspace runtime's file API instead
 * of the local disk. Loaded via dynamic import so the Oblien runtime types
 * never enter unrelated module graphs.
 */

/** The slice of the Oblien workspace Runtime we depend on — kept structural so
 *  this module doesn't hard-import the SDK types. */
export interface RuntimeFilesClient {
  files: {
    list(params: { dirPath: string }): Promise<{
      entries: Array<{ name: string; type: "file" | "directory" | "symlink" }>;
    }>;
    read(params: { filePath: string }): Promise<{ content: string }>;
  };
}

/** Root the uploaded source is extracted to (matches CloudRuntime's `/app`). */
const SOURCE_ROOT = "/app";

function joinPosix(base: string, rel: string): string {
  if (!rel) return base;
  return `${base.replace(/\/+$/, "")}/${rel.replace(/^\/+/, "")}`;
}

async function listRuntimeTree(rt: RuntimeFilesClient): Promise<RepoTreeEntry[]> {
  const tree: RepoTreeEntry[] = [];

  const visit = async (relativePath: string) => {
    const abs = joinPosix(SOURCE_ROOT, relativePath);
    let entries: Array<{ name: string; type: "file" | "directory" | "symlink" }>;
    try {
      entries = (await rt.files.list({ dirPath: abs })).entries;
    } catch {
      return;
    }

    for (const entry of entries) {
      const nextRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      const isDir = entry.type === "directory";
      if (isDir && isIgnoredRepoPath(nextRelativePath)) continue;

      tree.push({ path: nextRelativePath, type: isDir ? "dir" : "file" });
      if (isDir) await visit(nextRelativePath);
    }
  };

  await visit("");
  return tree;
}

export function createRuntimeReader(rt: RuntimeFilesClient): ProjectReader {
  let treePromise: Promise<RepoTreeEntry[]> | null = null;

  return {
    listDirectory: async (path: string) => {
      try {
        const { entries } = await rt.files.list({ dirPath: joinPosix(SOURCE_ROOT, path) });
        return entries.map((entry) => ({
          name: entry.name,
          type: entry.type === "directory" ? "dir" : "file",
        }));
      } catch {
        return [];
      }
    },
    readText: async (path: string) => {
      try {
        return (await rt.files.read({ filePath: joinPosix(SOURCE_ROOT, path) })).content;
      } catch {
        return undefined;
      }
    },
    readJson: async (path: string) => {
      try {
        const { content } = await rt.files.read({ filePath: joinPosix(SOURCE_ROOT, path) });
        return JSON.parse(content);
      } catch {
        return undefined;
      }
    },
    listTree: async () => {
      if (!treePromise) treePromise = listRuntimeTree(rt);
      return treePromise;
    },
  };
}

/** Lightweight counterpart to resolveFromRuntime for an explicit single-app
 * deploy: read environment defaults without interpreting a sibling Compose file. */
export function resolveSourceEnvFromRuntime(
  rt: RuntimeFilesClient,
  rootDirectory = "",
): Promise<ProjectSourceEnv> {
  return resolveSourceEnvFromReader(createRuntimeReader(rt), rootDirectory);
}

/** Detect stack/build config for source uploaded into a cloud workspace. */
export async function resolveFromRuntime(
  rt: RuntimeFilesClient,
  name: string,
  opts: ResolveOptions = {},
): Promise<ProjectInfo> {
  const reader = createRuntimeReader(rt);
  const rootPackageJson = await reader.readJson("package.json");
  const resolvedName = (rootPackageJson?.name as string) ?? name;

  return resolveFromReader(
    reader,
    {
      name: resolvedName,
      full_name: resolvedName,
      owner: "upload",
      private: true,
      default_branch: "main",
    },
    "main",
    opts,
  );
}
