/**
 * "Installed from source" plumbing shared by the from-source installer
 * (scripts/install-source.sh) and `openship update`'s quick-rebuild path.
 *
 * A source install is marked by ~/.openship/source-install.json. Its presence
 * is what flips `openship update` from "reinstall the published npm package" to
 * "pull the git checkout and rebuild the CLI like `bun dev`" — a quick update
 * with no npm release in the loop. Reuses the clone/build primitives from
 * from-source.ts so the two code paths can't drift.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_REPO, has, run, shortSha } from "./from-source";
import { OS_DIR } from "./paths";

export interface SourceInstall {
  /** Git remote the checkout was cloned from. */
  repo: string;
  /** Branch/tag/sha the checkout tracks. */
  ref: string;
  /** Absolute path of the monorepo checkout the CLI runs from. */
  dir: string;
}

const MARKER = join(OS_DIR, "source-install.json");

/** Parse marker JSON, filling repo/ref defaults; null if it's not a source install. */
export function parseSourceInstall(raw: string): SourceInstall | null {
  try {
    const obj = JSON.parse(raw) as Partial<SourceInstall>;
    if (!obj || typeof obj.dir !== "string" || !obj.dir) return null;
    return { repo: obj.repo || DEFAULT_REPO, ref: obj.ref || "main", dir: obj.dir };
  } catch {
    return null;
  }
}

/** The source-install marker, or null when the CLI wasn't installed from source. */
export function readSourceInstall(): SourceInstall | null {
  if (!existsSync(MARKER)) return null;
  try {
    return parseSourceInstall(readFileSync(MARKER, "utf8"));
  } catch {
    return null;
  }
}

/** First-column short sha from `git ls-remote <repo> <ref>` output, or null. */
export function parseRemoteSha(stdout: string): string | null {
  const sha = stdout.split("\n")[0]?.trim().split(/\s+/)[0];
  return sha && /^[0-9a-f]{7,40}$/i.test(sha) ? sha.slice(0, 7) : null;
}

/** Remote tip short sha for the tracked ref, or null if git/network is unavailable. */
export function remoteSha(repo: string, ref: string): string | null {
  const r = spawnSync("git", ["ls-remote", repo, ref], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout) return null;
  return parseRemoteSha(r.stdout);
}

/**
 * Pull latest source for a marked install and rebuild the CLI + dashboard the
 * same way `bun dev` does (bun install → apps/cli build → stage-dashboard).
 * Returns the new short sha. Throws with an actionable message if bun/git are
 * missing, the checkout is gone, or the build fails. stdio is inherited so the
 * operator sees git + build progress.
 */
export async function rebuildFromSource(info: SourceInstall): Promise<string> {
  if (!has("bun")) {
    throw new Error("`bun` is required to rebuild from source but wasn't found on PATH — https://bun.sh");
  }
  if (!has("git")) {
    throw new Error("`git` is required to update the source checkout but wasn't found on PATH.");
  }
  if (!existsSync(join(info.dir, ".git"))) {
    throw new Error(
      `Source checkout ${info.dir} is missing (no .git) — reinstall from source with scripts/install-source.sh.`,
    );
  }

  await run("git", ["fetch", "origin", info.ref, "--tags"], info.dir);
  await run("git", ["checkout", info.ref], info.dir);
  // Fast-forward a branch; a pinned tag/sha stays put (best-effort).
  await run("git", ["pull", "--ff-only", "origin", info.ref], info.dir).catch(() => {});

  const cliDir = join(info.dir, "apps/cli");
  await run("bun", ["install"], info.dir);
  await run("bun", ["run", "build"], cliDir); // tsup + build/stage-server.ts
  await run("bun", ["run", "build/stage-dashboard.ts"], cliDir);

  return shortSha(info.dir);
}
