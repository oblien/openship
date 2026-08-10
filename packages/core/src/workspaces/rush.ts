import { stripJsonComments } from "./comments";
import type { WorkspaceDetector } from "./types";

/**
 * Rush - `rush.json` lists every project explicitly as
 * `{ "projects": [{ "packageName": "@foo/bar", "projectFolder": "apps/bar" }, …] }`.
 *
 * We pull `projectFolder` from each entry. Rush projects are always literal
 * paths (no globs), so the downstream matcher treats them as exact.
 *
 * `rush.json` is JSONC - Rush reads it with a comment-tolerant parser and the
 * file `rush init` generates opens with a block comment - so comments are
 * stripped before `JSON.parse`.
 */
function parseRushJson(content: string): string[] {
  let parsed: { projects?: unknown } | null = null;
  try {
    parsed = JSON.parse(stripJsonComments(content)) as { projects?: unknown };
  } catch {
    return [];
  }
  if (!parsed || !Array.isArray(parsed.projects)) return [];

  return parsed.projects
    .map((entry) => {
      if (!entry || typeof entry !== "object") return "";
      const folder = (entry as { projectFolder?: unknown }).projectFolder;
      return typeof folder === "string" ? folder.trim() : "";
    })
    .filter((folder) => folder.length > 0);
}

export const rushWorkspaceDetector: WorkspaceDetector = {
  id: "rush",
  label: "Rush",
  manifestFiles: ["rush.json"],
  packageManager: "pnpm", // Rush wraps pnpm under the hood by default
  parseSubProjects: parseRushJson,
};
