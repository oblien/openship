/**
 * Filesystem controller — browse local directories.
 *
 * Self-hosted only. Provides directory listing with project detection
 * so the UI can let users pick a folder to deploy.
 *
 * Security: This module is only loaded via dynamic import in self-hosted
 * mode. The handler also checks CLOUD_MODE as defense-in-depth.
 */

import type { Context } from "hono";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { MANIFEST_FILES } from "../../lib/stack-detector";
import { env } from "../../config";

/** package.json + compose files aren't in MANIFEST_FILES (handled separately in stack detector) */
const PROJECT_MARKERS = new Set([
  "package.json",
  "docker-compose.yml",
  "docker-compose.yaml",
  ...MANIFEST_FILES,
]);

/** GET /system/browse?path=/some/dir — list child directories */
export async function browse(c: Context) {
  if (env.CLOUD_MODE) return c.notFound();

  const raw = c.req.query("path") || homedir();
  const dirPath = resolve(raw);

  try {
    const st = await stat(dirPath);
    if (!st.isDirectory()) return c.json({ error: "Not a directory" }, 400);
  } catch {
    return c.json({ error: "Directory not found" }, 404);
  }

  const entries = await readdir(dirPath, { withFileTypes: true });
  const dirs: { name: string; path: string; isProject: boolean }[] = [];

  await Promise.all(
    entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map(async (e) => {
        const childPath = join(dirPath, e.name);
        let isProject = false;
        try {
          const children = await readdir(childPath);
          isProject = children.some((m) => PROJECT_MARKERS.has(m));
        } catch {
          /* unreadable dir — skip marker check */
        }
        dirs.push({ name: e.name, path: childPath, isProject });
      }),
  );

  // Projects first, then alphabetical
  dirs.sort((a, b) => {
    if (a.isProject !== b.isProject) return a.isProject ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return c.json({ path: dirPath, directories: dirs });
}
