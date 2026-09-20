/**
 * Project-link file written by `openship init` and read by deploy/logs to
 * resolve a projectId without a flag. Lives at `.openship/project.json` in the
 * project root; commands search upward from cwd so they work from subdirs.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, parse } from "node:path";

export interface ProjectLink {
  projectId?: string;
  branch?: string;
  name?: string;
  slug?: string;
  context?: string;
  native?: { instanceId: string; organizationId: string };
  defaults?: { environment: string };
}

const LINK_REL = join(".openship", "project.json");

/** Absolute path of the nearest `.openship/project.json`, or null. */
export function findProjectLinkPath(from: string = process.cwd()): string | null {
  let dir = from;
  const root = parse(dir).root;
  for (;;) {
    const candidate = join(dir, LINK_REL);
    if (existsSync(candidate)) return candidate;
    if (dir === root) return null;
    dir = dirname(dir);
  }
}

/** Parse the nearest project-link file, or null if absent/unreadable. */
export function readProjectLink(from?: string): ProjectLink | null {
  const path = findProjectLinkPath(from);
  if (!path) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ProjectLink;
  } catch {
    return null;
  }
}
