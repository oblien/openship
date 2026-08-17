/**
 * One prepare interface for mounted code releases:
 *   git-prebuilt   — extract the fetched commit
 *   local-upload   — verify the uploaded archive, then extract
 *   server-prepared — extract, then run the disposable builder unless lockfiles match
 */
import { createHash } from "node:crypto";
import { LOCKFILE_BASENAMES, type ArtifactSource } from "@repo/adapters";
import { AppError, shellQuote } from "@repo/core";
import {
  mountedReleaseBuildMode,
  type MountedReleaseConfig,
} from "./mounted-release.config";

const RELEASE_ERROR = "MOUNTED_RELEASE_FAILED";
const SHA_MISMATCH = "ARTIFACT_SHA_MISMATCH";

export type ReleaseProvenance = {
  source: ArtifactSource;
  sha256: string;
  commitSha?: string;
  lockHashes?: Record<string, string>;
};

export type PrepareReleaseResult = {
  releaseDir: string;
  sha256: string;
  provenance: ReleaseProvenance;
  skippedPrepare: boolean;
};

export type HostExec = (command: string, opts?: { timeout?: number }) => Promise<string>;

export function normalizeSha256(value: string): string {
  return value.trim().toLowerCase().replace(/^sha256:/, "");
}

export function isSha256Hex(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(normalizeSha256(value));
}

/** Refuse activation when the uploaded bytes do not match the claimed digest. */
export function assertArtifactSha256(actual: string, claimed: string): void {
  if (!isSha256Hex(actual) || normalizeSha256(actual) !== normalizeSha256(claimed)) {
    throw new AppError(
      "Artifact SHA-256 does not match. Activation refused.",
      400,
      SHA_MISMATCH,
    );
  }
}

export function shouldSkipPrepare(
  current: Record<string, string>,
  previous: Record<string, string> | null | undefined,
): boolean {
  if (!previous || Object.keys(previous).length === 0) return false;
  if (Object.keys(current).length === 0) return false;
  const keys = new Set([...Object.keys(current), ...Object.keys(previous)]);
  for (const key of keys) {
    if ((current[key] ?? "") !== (previous[key] ?? "")) return false;
  }
  return true;
}

export function lockfileHashCommand(releaseDir: string): string {
  const paths = LOCKFILE_BASENAMES.map((name) => `${releaseDir}/${name}`);
  return (
    `for f in ${paths.map(shellQuote).join(" ")}; do ` +
    `if [ -f "$f" ]; then sha256sum "$f"; fi; ` +
    `done`
  );
}

export function parseLockfileHashes(stdout: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const match = line.trim().match(/^([a-f0-9]{64})\s+(\S+)$/i);
    if (!match) continue;
    const base = match[2]!.split("/").pop();
    if (base && (LOCKFILE_BASENAMES as readonly string[]).includes(base)) {
      hashes[base] = match[1]!.toLowerCase();
    }
  }
  return hashes;
}

export function reuseBuilderCacheCommand(
  hostRoot: string,
  releaseDir: string,
  cachePaths: string[],
  previousReleaseDir?: string | null,
): string | null {
  const dirs = cachePaths
    .map((path) => path.replace(/^\/+|\/+$/g, ""))
    .filter((path) => path && !path.split("/").includes(".."));
  if (dirs.length === 0) return null;
  const parts = dirs.map((rel) => {
    const cache = `${hostRoot}/builder-cache/paths/${rel}`;
    const previous = previousReleaseDir ? `${previousReleaseDir}/${rel}` : "";
    const dest = `${releaseDir}/${rel}`;
    const parent = dest.includes("/") ? dest.slice(0, dest.lastIndexOf("/")) : releaseDir;
    const fromPrevious = previous
      ? `elif [ -d ${shellQuote(previous)} ]; then mkdir -p ${shellQuote(parent)}; rm -rf ${shellQuote(dest)}; cp -a ${shellQuote(previous)} ${shellQuote(dest)}; `
      : "";
    return (
      `if [ -d ${shellQuote(cache)} ]; then ` +
      `mkdir -p ${shellQuote(parent)}; rm -rf ${shellQuote(dest)}; ` +
      `cp -a ${shellQuote(cache)} ${shellQuote(dest)}; ` +
      `${fromPrevious}fi`
    );
  });
  return parts.join("; ");
}

export function extractArchiveCommand(archivePath: string, destDir: string): string {
  return (
    `mkdir -p ${shellQuote(destDir)} && ` +
    `(tar -xaf ${shellQuote(archivePath)} -C ${shellQuote(destDir)} || ` +
    `tar -xzf ${shellQuote(archivePath)} -C ${shellQuote(destDir)} || ` +
    `tar -I zstd -xf ${shellQuote(archivePath)} -C ${shellQuote(destDir)})`
  );
}

export function hostSha256Command(filePath: string): string {
  return `sha256sum ${shellQuote(filePath)} | awk '{print $1}'`;
}

export function resolveArtifactSource(config: MountedReleaseConfig): ArtifactSource {
  const mode = mountedReleaseBuildMode(config);
  if (mode === "upload") return "local-upload";
  if (mode === "server") return "server-prepared";
  return "git-prebuilt";
}

export interface PrepareReleaseContext {
  exec: HostExec;
  config: MountedReleaseConfig;
  hostRoot: string;
  releaseDir: string;
  incoming: string;
  deploymentId: string;
  /** Host path of the uploaded archive (local-upload). */
  uploadedArchive?: string;
  claimedSha256?: string;
  /** After git archive extract, the commit SHA. */
  commitSha?: string;
  previousLockHashes?: Record<string, string> | null;
  previousReleaseDir?: string | null;
  /** Tree already extracted to releaseDir — skip extract, still verify + prepare. */
  treeReady?: boolean;
  runPrepare: (lockHashes: Record<string, string>) => Promise<void>;
  log?: (message: string) => void;
}

export async function prepareRelease(ctx: PrepareReleaseContext): Promise<PrepareReleaseResult> {
  const source = resolveArtifactSource(ctx.config);
  let sha256: string;

  if (source === "local-upload") {
    if (!ctx.uploadedArchive || !ctx.claimedSha256) {
      throw new AppError("Upload a release artifact before activating this project.", 409, RELEASE_ERROR);
    }
    const actual = (await ctx.exec(hostSha256Command(ctx.uploadedArchive))).trim();
    assertArtifactSha256(actual, ctx.claimedSha256);
    sha256 = normalizeSha256(actual);
    if (!ctx.treeReady) {
      await ctx.exec(`rm -rf ${shellQuote(ctx.releaseDir)} ${shellQuote(ctx.incoming)}`);
      await ctx.exec(extractArchiveCommand(ctx.uploadedArchive, ctx.incoming), { timeout: 120_000 });
      await ctx.exec(`mv ${shellQuote(ctx.incoming)} ${shellQuote(ctx.releaseDir)}`);
    }
  } else {
    sha256 = ctx.commitSha
      ? createHash("sha256").update(ctx.commitSha).digest("hex")
      : "";
  }

  const lockHashes = parseLockfileHashes(await ctx.exec(lockfileHashCommand(ctx.releaseDir)));
  const skipPrepare =
    source === "server-prepared" && shouldSkipPrepare(lockHashes, ctx.previousLockHashes);

  if (source === "server-prepared") {
    if (skipPrepare) {
      ctx.log?.("Lockfiles unchanged; reusing cached dependency layers");
      const reuse = reuseBuilderCacheCommand(
        ctx.hostRoot,
        ctx.releaseDir,
        ctx.config.builderCachePaths ?? ["vendor", "node_modules"],
        ctx.previousReleaseDir,
      );
      if (reuse) await ctx.exec(reuse);
    } else {
      await ctx.runPrepare(lockHashes);
    }
  }

  if (!sha256) {
    const digest = Object.values(lockHashes).sort().join(":");
    sha256 = createHash("sha256").update(digest || ctx.releaseDir).digest("hex");
  }

  return {
    releaseDir: ctx.releaseDir,
    sha256,
    provenance: {
      source,
      sha256,
      ...(ctx.commitSha ? { commitSha: ctx.commitSha } : {}),
      ...(Object.keys(lockHashes).length ? { lockHashes } : {}),
    },
    skippedPrepare: skipPrepare,
  };
}
