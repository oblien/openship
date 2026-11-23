import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { constants } from "node:fs";
import { open, realpath, readdir, stat } from "node:fs/promises";
import { basename, resolve, join } from "node:path";
import { assertSourcePathContained } from "../../../source-files";
import { isIgnoredRepoPath, type RepoTreeEntry } from "../../lib/project-root-detector";
import type { ProjectReader } from "./project-reader";
import {
  resolveFromReader,
  resolveSourceEnvFromReader,
  type ProjectInfo,
  type ProjectSourceEnv,
  type ResolveOptions,
} from "./prepare.service";

// Local-filesystem project resolution. Loaded ONLY via dynamic import from the
// non-cloud branch of resolveProjectInfo, so node:fs never enters the cloud
// module graph (same isolation as the self-hosted-only gh token path).

async function listLocalTree(dirPath: string): Promise<RepoTreeEntry[]> {
  const tree: RepoTreeEntry[] = [];

  const visit = async (absolutePath: string, relativePath = "") => {
    const entries = await readdir(absolutePath, { withFileTypes: true });

    for (const entry of entries) {
      const nextRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      if (entry.isDirectory() && isIgnoredRepoPath(nextRelativePath)) {
        continue;
      }

      tree.push({ path: nextRelativePath, type: entry.isDirectory() ? "dir" : "file" });
      if (entry.isDirectory()) {
        await visit(join(absolutePath, entry.name), nextRelativePath);
      }
    }
  };

  await visit(dirPath);
  return tree;
}

function createLocalReader(dirPath: string): ProjectReader {
  let treePromise: Promise<RepoTreeEntry[]> | null = null;

  const resolvePath = async (path: string) => {
    const candidate = resolve(dirPath, path);
    assertSourcePathContained(dirPath, candidate);
    const canonical = await realpath(candidate);
    assertSourcePathContained(dirPath, canonical);
    return canonical;
  };

  const readText = async (path: string): Promise<string | undefined> => {
    try {
      const file = await open(await resolvePath(path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        if (!(await file.stat()).isFile()) return undefined;
        return await file.readFile("utf-8");
      } finally {
        await file.close();
      }
    } catch (diagnosticFailure) {
      observeCaughtError(diagnosticFailure, "platform/engine/modules/deployments/local-source");
      return undefined;
    }
  };

  return {
    listDirectory: async (path: string) => {
      try {
        const entries = await readdir(await resolvePath(path), { withFileTypes: true });
        return entries.map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? "dir" : "file",
        }));
      } catch (diagnosticFailure) {
        observeCaughtError(diagnosticFailure, "platform/engine/modules/deployments/local-source");
        return [];
      }
    },
    readText,
    readJson: async (path: string) => {
      const content = await readText(path);
      if (!content) return undefined;
      try {
        return JSON.parse(content);
      } catch (diagnosticFailure) {
        observeCaughtError(diagnosticFailure, "platform/engine/modules/deployments/local-source");
        return undefined;
      }
    },
    listTree: async () => {
      if (!treePromise) {
        treePromise = listLocalTree(dirPath);
      }
      return treePromise;
    },
  };
}

/** Read only openship.json + the selected root's .env, without detecting or
 * parsing a Compose topology. */
export async function resolveSourceEnvFromLocal(
  dirPath: string,
  rootDirectory = "",
): Promise<ProjectSourceEnv> {
  const canonical = await realpath(dirPath);
  const st = await stat(canonical);
  if (!st.isDirectory()) throw new Error("Path is not a directory");
  return resolveSourceEnvFromReader(createLocalReader(canonical), rootDirectory);
}

export async function resolveFromLocal(
  dirPath: string,
  opts: ResolveOptions = {},
  fallbackName = basename(dirPath),
): Promise<ProjectInfo> {
  const canonical = await realpath(dirPath);
  const st = await stat(canonical);
  if (!st.isDirectory()) {
    throw new Error("Path is not a directory");
  }

  const reader = createLocalReader(canonical);
  const rootPackageJson = await reader.readJson("package.json");
  const name = (rootPackageJson?.name as string) || fallbackName;

  return resolveFromReader(
    reader,
    {
      name,
      full_name: dirPath,
      owner: "local",
      private: true,
      default_branch: "main",
    },
    "main",
    opts,
  );
}
