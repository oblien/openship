import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { createGzip } from "node:zlib";

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
  } catch {
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
    } catch {
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

/** Lockfiles whose hash decides whether a server-prepare step can be skipped. */
export const LOCKFILE_BASENAMES = [
  "composer.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "Cargo.lock",
  "go.sum",
] as const;

export type ArtifactSource = "local-upload" | "git-prebuilt" | "server-prepared";

export interface ArtifactManifest {
  version: 1;
  sha256: string;
  files: string[];
  source: ArtifactSource;
  commitSha?: string;
  lockHashes?: Record<string, string>;
  compression: "zstd" | "gzip";
}

export function artifactManifestPath(archivePath: string): string {
  return archivePath.replace(/\.tar\.(zst|gz)$/i, "") + ".manifest.json";
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex");
}

export async function hashLockfiles(root: string): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const name of LOCKFILE_BASENAMES) {
    const path = join(root, name);
    try {
      const info = await stat(path);
      if (!info.isFile()) continue;
      hashes[name] = await sha256File(path);
    } catch {
      // Lockfile not present in this tree.
    }
  }
  return hashes;
}

export async function hasZstdBinary(): Promise<boolean> {
  try {
    await execFileAsync("zstd", ["-V"]);
    return true;
  } catch {
    return false;
  }
}

/** Recursively list relative paths (posix) so two walks of the same tree match. */
export async function listArtifactFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = relative(root, full).split("\\").join("/");
      if (!rel || rel.split("/").includes("..")) continue;
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (entry.isFile() || entry.isSymbolicLink()) files.push(rel);
    }
  }
  await walk(root);
  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return files;
}

function normalizeGzipHeader(buffer: Buffer): void {
  // Bytes 4-7 are mtime; byte 9 is OS. Zero both so Node/gzip builds match.
  if (buffer.length >= 10 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    buffer.writeUInt32LE(0, 4);
    buffer[9] = 255;
  }
}

async function packTarToFile(sourceDir: string, files: string[], tarPath: string): Promise<void> {
  const tmpDir = await mkdtemp(join(tmpdir(), "openship-artlist-"));
  const listFile = join(tmpDir, "files.null");
  await writeFile(listFile, files.join("\0"));
  try {
    await execFileAsync(
      "tar",
      [
        "--sort=name",
        "--mtime=@0",
        "--owner=0",
        "--group=0",
        "--numeric-owner",
        "--pax-option=exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime",
        "-cf",
        tarPath,
        "-C",
        sourceDir,
        "--null",
        "-T",
        listFile,
      ],
      { env: getTarCreateEnv() },
    );
  } catch {
    // GNU --sort/--mtime flags are missing (bsdtar). tar-fs + header map is portable.
    const { pack } = await import("tar-fs");
    await pipeline(
      pack(sourceDir, {
        entries: files,
        map(header) {
          header.mtime = new Date(0);
          header.uid = 0;
          header.gid = 0;
          header.uname = "";
          header.gname = "";
          header.mode = header.type === "directory" || ((header.mode ?? 0) & 0o111) ? 0o755 : 0o644;
          return header;
        },
      }),
      createWriteStream(tarPath),
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Pack `sourceDir` into a deterministic compressed archive. Prefers zstd when
 * the `zstd` binary is on PATH; otherwise gzip with sorted files, mtime 0, and
 * a normalized gzip header.
 */
export async function packDeterministicArtifact(opts: {
  sourceDir: string;
  destPath: string;
  source: ArtifactSource;
  commitSha?: string;
  lockHashes?: Record<string, string>;
}): Promise<ArtifactManifest & { archivePath: string; manifestPath: string }> {
  const files = await listArtifactFiles(opts.sourceDir);
  const lockHashes = opts.lockHashes ?? (await hashLockfiles(opts.sourceDir));
  const useZstd = await hasZstdBinary();
  const archivePath = opts.destPath.replace(/\.tar\.(zst|gz)$/i, "") + (useZstd ? ".tar.zst" : ".tar.gz");
  const tarPath = `${archivePath}.partial.tar`;

  try {
    await packTarToFile(opts.sourceDir, files, tarPath);
    if (useZstd) {
      await execFileAsync("zstd", ["-T1", "-f", "-q", "-o", archivePath, tarPath]);
    } else {
      await pipeline(createReadStream(tarPath), createGzip({ level: 9 }), createWriteStream(archivePath));
      const { readFile, writeFile: write } = await import("node:fs/promises");
      const gzipped = await readFile(archivePath);
      normalizeGzipHeader(gzipped);
      await write(archivePath, gzipped);
    }
  } finally {
    await rm(tarPath, { force: true });
  }

  const sha256 = await sha256File(archivePath);
  const manifest: ArtifactManifest = {
    version: 1,
    sha256,
    files,
    source: opts.source,
    compression: useZstd ? "zstd" : "gzip",
    ...(opts.commitSha ? { commitSha: opts.commitSha } : {}),
    ...(Object.keys(lockHashes).length ? { lockHashes } : {}),
  };
  const manifestPath = artifactManifestPath(archivePath);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { ...manifest, archivePath, manifestPath };
}

export async function extractArtifact(archivePath: string, destDir: string): Promise<void> {
  const args = ["-xaf", archivePath, "-C", destDir];
  try {
    await execFileAsync("tar", args, { maxBuffer: 16 * 1024 * 1024 });
  } catch (first) {
    const zstd = archivePath.endsWith(".zst") || archivePath.endsWith(".tar.zst");
    try {
      await execFileAsync("tar", zstd ? ["-I", "zstd", "-xf", archivePath, "-C", destDir] : ["-xzf", archivePath, "-C", destDir], {
        maxBuffer: 16 * 1024 * 1024,
      });
    } catch {
      throw first;
    }
  }
}
