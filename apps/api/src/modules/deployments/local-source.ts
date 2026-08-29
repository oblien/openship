import { stat, readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { isIgnoredRepoPath, type RepoTreeEntry } from "../../lib/project-root-detector";
import type { ProjectReader } from "./project-reader";
import { resolveFromReader, type ProjectInfo, type ResolveOptions } from "./prepare.service";

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

  const absolutePathFor = (path: string) => path ? join(dirPath, path) : dirPath;

  return {
    listDirectory: async (path: string) => {
      try {
        const entries = await readdir(absolutePathFor(path), { withFileTypes: true });
        return entries.map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? "dir" : "file",
        }));
      } catch {
        return [];
      }
    },
    readText: async (path: string) => {
      try {
        return await readFile(absolutePathFor(path), "utf-8");
      } catch {
        return undefined;
      }
    },
    readJson: async (path: string) => {
      try {
        return JSON.parse(await readFile(absolutePathFor(path), "utf-8"));
      } catch {
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

export async function resolveFromLocal(
  dirPath: string,
  opts: ResolveOptions = {},
): Promise<ProjectInfo> {
  const st = await stat(dirPath);
  if (!st.isDirectory()) {
    throw new Error("Path is not a directory");
  }

  const reader = createLocalReader(dirPath);
  const rootPackageJson = await reader.readJson("package.json");
  const name = (rootPackageJson?.name as string) ?? basename(dirPath);

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
