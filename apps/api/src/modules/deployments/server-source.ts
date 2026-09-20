import { basename } from "node:path";
import type { CommandExecutor } from "@repo/adapters";
import { isIgnoredRepoPath, type RepoTreeEntry } from "@repo/platform/engine/lib/project-root-detector";
import type { RepoFile } from "@repo/platform/engine/lib/stack-detector";
import { sshManager } from "@repo/platform/engine/lib/ssh-manager";
import type { ProjectReader } from "@repo/platform/engine/modules/deployments/project-reader";
import { resolveFromReader, type ProjectInfo } from "@repo/platform/engine/modules/deployments/prepare.service";

// Reads a project directory on a remote SERVER over the pooled SSH executor,
// behind the same ProjectReader interface as GitHub/local. Powers "migrate an
// existing Docker deployment": point Openship at a compose project's working
// dir on the server and reuse the full detectStack/compose pipeline unchanged.
//
// Self-hosted only — imported from the migration module, which is gated on
// !CLOUD_MODE, so this never enters the cloud module graph.

/** Single-quote escape for a shell argument. */
function sq(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function joinRemote(root: string, path: string): string {
  if (!path) return root;
  const base = root.endsWith("/") ? root.slice(0, -1) : root;
  const rel = path.startsWith("/") ? path.slice(1) : path;
  return `${base}/${rel}`;
}

export function createServerReader(executor: CommandExecutor, rootDir: string): ProjectReader {
  let treePromise: Promise<RepoTreeEntry[]> | null = null;

  const readText = async (path: string): Promise<string | undefined> => {
    try {
      return await executor.readFile(joinRemote(rootDir, path));
    } catch {
      return undefined;
    }
  };

  return {
    listDirectory: async (path: string): Promise<RepoFile[]> => {
      try {
        // -A: skip . and ..  -p: suffix dirs with "/"  -1: one entry per line.
        // Portable across GNU/BSD ls; the trailing slash is our type signal.
        const out = await executor.exec(`ls -Ap1 -- ${sq(joinRemote(rootDir, path))}`, {
          timeout: 10_000,
        });
        return out
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .map((name) =>
            name.endsWith("/")
              ? { name: name.slice(0, -1), type: "dir" as const }
              : { name, type: "file" as const },
          );
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
    listTree: async (): Promise<RepoTreeEntry[]> => {
      if (!treePromise) {
        treePromise = (async () => {
          try {
            // GNU find %P = path relative to the root. Linux servers only; on a
            // find without -printf the command fails and we degrade to [] (the
            // snapshot then leans on listDirectory).
            const out = await executor.exec(
              `find ${sq(rootDir)} -mindepth 1 \\( -type d -printf 'd %P\\n' -o -type f -printf 'f %P\\n' \\) 2>/dev/null || true`,
              { timeout: 20_000 },
            );
            const tree: RepoTreeEntry[] = [];
            for (const line of out.split(/\r?\n/)) {
              const kind = line[0];
              const rel = line.slice(2).trim();
              if ((kind !== "d" && kind !== "f") || !rel) continue;
              if (isIgnoredRepoPath(rel)) continue;
              tree.push({ path: rel, type: kind === "d" ? "dir" : "file" });
            }
            return tree;
          } catch {
            return [];
          }
        })();
      }
      return treePromise;
    },
  };
}

/**
 * Resolve ProjectInfo for a directory on a server, over the pooled SSH
 * connection (held for the whole snapshot→detect→compose pipeline).
 */
export async function resolveFromServer(
  serverId: string,
  rootDir: string,
  name?: string,
): Promise<ProjectInfo> {
  return sshManager.withExecutor(serverId, async (executor) => {
    const reader = createServerReader(executor, rootDir);
    const resolvedName = name ?? (basename(rootDir) || "server-app");
    return resolveFromReader(
      reader,
      {
        name: resolvedName,
        full_name: rootDir,
        owner: "server",
        private: true,
        default_branch: "main",
      },
      "main",
    );
  });
}
