import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { PACKAGE_ROOT_ONLY_EXCLUDES } from "@repo/core";

const execFileAsync = promisify(execFile);

/** Names that double as real source folders — anchor them to the archive root
 *  instead of matching at any depth (see stacks.ts). Only used on the no-git
 *  fallback path; the git-truth path doesn't guess by name at all. */
const ROOT_ONLY_EXCLUDES = new Set<string>(PACKAGE_ROOT_ONLY_EXCLUDES);

const NOOP_CLEANUP = async () => {};

export interface TarTransferOptions {
  excludes?: string[];
  includes?: string[];
  /**
   * Paths (relative to `localPath`) to append ON TOP of the git-truth file
   * list. Used to ship a gitignored build output (e.g. Next.js `.next`) that
   * `git ls-files --exclude-standard` would otherwise drop — the compiled-stack
   * `includes` path bypasses git entirely, but host-mode JS stacks want the
   * git-tracked source AND the build output. Non-existent paths are skipped.
   * Only consulted on the git-truth branch (ignored when `includes` is set or
   * there's no git work tree — the no-git branch keeps the output via the
   * exclude list instead).
   */
  alsoInclude?: string[];
}

export function getTarCreateEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    COPYFILE_DISABLE: "1",
    COPY_EXTENDED_ATTRIBUTES_DISABLE: "1",
  };
}

/**
 * The tar-create prefix shared by every packing path: gzip stream to stdout,
 * rooted at `localPath` (plus macOS metadata-stripping flags). The `-z` here is
 * load-bearing — extractors (docker context materialize, remote extract) pair
 * it with `-xzf`.
 */
function tarCreateBaseArgs(localPath: string): string[] {
  const darwinFlags =
    process.platform === "darwin"
      ? ["--no-mac-metadata", "--no-xattrs", "--no-acls", "--no-fflags"]
      : [];
  return [...darwinFlags, "-czf", "-", "-C", localPath];
}

/**
 * The exact set of files git would ship from `localPath`, relative to it:
 * tracked + untracked-but-not-ignored (`ls-files --cached --others
 * --exclude-standard`). This is the SINGLE source of truth for source-vs-
 * generated across every transfer/build-context path — it honours `.gitignore`
 * precisely (a *tracked* `build/` route survives; a gitignored `dist/`/`.next/`
 * drops), never guesses by folder name, and is tar-flavour independent.
 *
 * Returns null when `localPath` isn't inside a git work tree (or `git` is
 * unavailable) — callers then fall back to the name-based exclude list.
 */
export async function gitTrackedFiles(localPath: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", localPath, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { maxBuffer: 256 * 1024 * 1024 },
    );
    const files = stdout.split("\0").filter(Boolean);
    return files.length > 0 ? files : null;
  } catch (diagnosticFailure) {
    observeCaughtError(diagnosticFailure, "adapters/archive");
    // Not a repo, git missing, or the dir is outside any work tree.
    return null;
  }
}

/** Filter `paths` (relative to `root`) to those that actually exist on disk. */
async function existingRelativePaths(root: string, paths?: string[]): Promise<string[]> {
  if (!paths?.length) return [];
  const found: string[] = [];
  for (const p of paths) {
    try {
      await stat(join(root, p));
      found.push(p);
    } catch (diagnosticFailure) {
      observeCaughtError(diagnosticFailure, "adapters/archive");
      // Missing (e.g. build produced no such dir) — skip; never abort the pack.
    }
  }
  return found;
}

/**
 * Build the `tar` create args for packing `localPath` to stdout (`-czf -`),
 * plus a `cleanup` for any temp file created.
 *
 * Precedence:
 *   1. Explicit `includes` (compiled stacks ship only their built output dirs,
 *      which are themselves gitignored) → pack exactly those, never the git list.
 *   2. Git work tree → pack the git-truth file list via `--files-from` (no
 *      `--exclude` globbing, so `[id]` / `(group)` route dirs and tracked
 *      `build/` folders all survive regardless of tar flavour).
 *   3. No git → name-based `--exclude` fallback (best-effort anchoring).
 */
export async function prepareSourceTarArgs(
  localPath: string,
  options?: TarTransferOptions,
): Promise<{ args: string[]; cleanup: () => Promise<void> }> {
  if (options?.includes?.length) {
    return { args: getTarCreateArgs(localPath, options), cleanup: NOOP_CLEANUP };
  }

  const files = await gitTrackedFiles(localPath);
  if (files) {
    // Add gitignored build-output dirs (e.g. `.next`) the git list omits. They
    // go in as directory entries — tar recurses into them — and being gitignored
    // they never collide with the tracked-file list. Filtered to those that
    // exist so a missing path can't abort the whole pack.
    const extra = await existingRelativePaths(localPath, options?.alsoInclude);
    const entries = extra.length ? [...files, ...extra] : files;
    const tmpDir = await mkdtemp(join(tmpdir(), "openship-tarlist-"));
    const listFile = join(tmpDir, "files.null");
    await writeFile(listFile, entries.join("\0"));
    const args = [...tarCreateBaseArgs(localPath), "--null", "-T", listFile];
    return { args, cleanup: () => rm(tmpDir, { recursive: true, force: true }) };
  }

  return { args: getTarCreateArgs(localPath, options), cleanup: NOOP_CLEANUP };
}

/**
 * Name-based tar args — the no-git fallback. Kept for sources that aren't a
 * git checkout (imported tarballs, uploads). Prefer `prepareSourceTarArgs`,
 * which uses git truth when available.
 */
export function getTarCreateArgs(
  localPath: string,
  options?: TarTransferOptions,
): string[] {
  const args = tarCreateBaseArgs(localPath);

  if (options?.includes?.length) {
    args.push(...options.includes);
    return args;
  }

  for (const exclude of options?.excludes ?? []) {
    // Ambiguous output names (build/dist/data) also occur as real source
    // folders. Anchor them to the archive root (`./name`) so nested source
    // isn't deleted. NOTE: GNU tar honours this anchor; bsdtar does not — which
    // is exactly why the primary path uses the git list, not these patterns.
    const pattern = ROOT_ONLY_EXCLUDES.has(exclude) ? `./${exclude}` : exclude;
    args.push(`--exclude=${pattern}`);
  }

  args.push(".");
  return args;
}
