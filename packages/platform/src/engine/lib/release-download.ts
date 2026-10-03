/**
 * Fetch and extract a published Openship release tarball into a local
 * cache directory. Used by `openship-dist.ts` and the webmail dist
 * resolver to fill the third resolution slot (cache miss → download
 * from GitHub releases) after the env override and repo-local dev
 * paths fail.
 *
 * Security model — what this defends against, in order:
 *
 *   1. **HTTPS-only.** Asset and sidecar URLs are constructed with a
 *      hardcoded `https://` prefix. Node's `fetch` follows redirects,
 *      and the runtime refuses cross-protocol downgrades, but we
 *      additionally assert the resolved URL scheme post-redirect.
 *
 *   2. **SHA-256 verified BEFORE extraction.** Every release ships a
 *      `<asset>.sha256` sidecar. We download both, hash the tarball,
 *      compare against the sidecar — mismatch deletes the partial
 *      download and throws. Extraction only happens on a matching hash.
 *
 *   3. **Path-traversal protection.** We inspect every archive header BEFORE extraction, including
 *      symlink targets, hardlink targets, and entry types. Each entry is validated:
 *        - no `..` segments in the name
 *        - no absolute paths
 *        - no symlink/hardlink target with `..`, absolute, or escapes root
 *        - the resolved entry path stays inside the extraction root
 *      Only after every header passes do we extract the archive. This
 *      closes the symlink-target attack vector (a malicious tarball
 *      with an entry like `evil → /etc/passwd` would otherwise create
 *      a symlink that subsequent code could be tricked into following).
 *
 *   4. **Atomic publish.** Extraction goes to a `<tag>.tmp.<pid>` dir
 *      and is renamed into place only on full success. Concurrent
 *      callers see either a complete `<tag>/` or nothing.
 *
 *   5. **Bounded timeouts.** Sidecar fetch 30s, tarball 5min, tar
 *      operations 5min — keeps a hung CDN from wedging the API.
 *
 *   6. **Operator escape hatch.** Every throw mentions the env var
 *      (`OPENSHIP_RELEASE_DIST_PATH`) the operator can point at a local
 *      directory to bypass the download entirely.
 *
 * Layout produced inside cacheDir:
 *
 *   <cacheDir>/<tag>/             ← final extracted dist (returned path)
 *   <cacheDir>/<tag>.tmp.<pid>/   ← scratch dir for in-flight extraction
 *   <cacheDir>/<tag>.<pid>.tar.gz ← scratch tarball, removed after extract
 *   <cacheDir>/<tag>.<pid>.sha256 ← scratch sidecar, removed after extract
 */

import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { t as listTar, x as extractTar } from "tar";
import { safeFetch, type SafeFetchResponse } from "./safe-fetch";
import { assertPublicHostLiteral, SsrfError } from "./ssrf-guard";

const SHA256_TIMEOUT_MS = 30_000;
const TARBALL_TIMEOUT_MS = 5 * 60_000;
const TAR_TIMEOUT_MS = 5 * 60_000;
/** Hard cap on a downloaded release artifact (buffered in memory before the
 *  sha-verify). Generous for real dists; bounds a hostile/oversized response. */
const MAX_RELEASE_ARTIFACT_BYTES = 512_000_000;

const DEFAULT_REPO = "oblien/openship";

export interface FetchAndExtractReleaseInput {
  /** Release tag / cache key, e.g. "v0.1.0". The extracted dist lives at `<cacheDir>/<tag>/`. */
  tag: string;
  /** Cache directory root. */
  cacheDir: string;

  // ── GitHub-Releases mode (asset name → github.com/<repo>/releases/download/…) ──
  /** GitHub `owner/repo`, e.g. "oblien/openship". Defaults to "oblien/openship". */
  repo?: string;
  /** Release asset filename, e.g. "openship-v0.1.0-linux-amd64.tar.gz". */
  asset?: string;

  // ── External-URL mode (bring-your-own dist) — set assetUrl to use it ──
  /** Direct HTTPS tarball URL. When set, GitHub mode is bypassed. */
  assetUrl?: string;
  /** HTTPS sha256 sidecar URL for the external tarball. */
  shaUrl?: string;
  /** OR a pinned inline sha256 hex (64 chars) for the external tarball. */
  sha256?: string;
  /** Error-message escape-hatch hint (defaults to `OPENSHIP_RELEASE_DIST_PATH`). */
  envOverride?: string;
}

export interface FetchAndExtractReleaseResult {
  /** Absolute path to the extracted release directory. */
  path: string;
  /** Whether a download happened (false = cache hit). */
  downloaded: boolean;
}

/**
 * The env-override an operator can point at a local dist to bypass the download.
 * Surfaced in every error message so a stuck download isn't a dead end; callers
 * with their own escape hatch pass `envOverride` instead.
 */
const DEFAULT_ENV_OVERRIDE = "OPENSHIP_RELEASE_DIST_PATH";

export class ReleaseDownloadError extends Error {
  readonly code = "RELEASE_DOWNLOAD_FAILED" as const;
  constructor(opts: { reason: string; url?: string; envOverride: string; cause?: unknown }) {
    const parts = [opts.reason];
    if (opts.url) parts.push(`URL: ${opts.url}`);
    parts.push(
      `Escape hatch: set ${opts.envOverride} to a local directory containing the prebuilt dist.`,
    );
    super(parts.join(" — "), opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "ReleaseDownloadError";
  }
}

/**
 * Download `repo`'s `asset` for `tag` from GitHub releases and extract
 * it under `cacheDir`. Returns the cached path immediately if present.
 */
export async function fetchAndExtractRelease(
  input: FetchAndExtractReleaseInput,
): Promise<FetchAndExtractReleaseResult> {
  const { tag, cacheDir } = input;
  const external = Boolean(input.assetUrl);
  const envOverride = input.envOverride ?? DEFAULT_ENV_OVERRIDE;

  const targetDir = resolve(cacheDir, tag);

  // 1. Cache hit — return without any network round-trip.
  if (existsSync(targetDir)) {
    return { path: targetDir, downloaded: false };
  }

  // Resolve the asset + sha URLs for the chosen mode.
  let assetUrl: string;
  let shaUrl: string | undefined;
  if (external) {
    // Bring-your-own dist: a user-supplied HTTPS URL. Require a sha256 (sidecar
    // OR pinned inline) — never extract unverified external bytes — and refuse
    // private/loopback/link-local targets (SSRF).
    assetUrl = input.assetUrl!;
    assertPublicHttps(assetUrl, envOverride);
    if (!input.sha256 && !input.shaUrl) {
      throw new ReleaseDownloadError({
        reason: "External dist URL requires a sha256 (inline or sidecar) — refusing to extract unverified bytes.",
        url: assetUrl,
        envOverride,
      });
    }
    shaUrl = input.shaUrl;
    if (shaUrl) assertPublicHttps(shaUrl, envOverride);
  } else {
    if (!input.asset) {
      throw new ReleaseDownloadError({ reason: "GitHub release download requires an asset name.", envOverride });
    }
    const repo = input.repo ?? DEFAULT_REPO;
    assetUrl = `https://github.com/${repo}/releases/download/${tag}/${input.asset}`;
    shaUrl = `${assetUrl}.sha256`;
  }

  mkdirSync(cacheDir, { recursive: true });

  const scratchTarball = join(cacheDir, `${tag}.${process.pid}.tar.gz`);
  const scratchSha = join(cacheDir, `${tag}.${process.pid}.sha256`);
  const scratchDir = `${targetDir}.tmp.${process.pid}`;

  // Defensive: clean any pre-existing scratch with our pid (crashed
  // prior run with the same pid recycled — rare but possible).
  rmSync(scratchTarball, { force: true });
  rmSync(scratchSha, { force: true });
  rmSync(scratchDir, { recursive: true, force: true });

  try {
    // 2. Resolve the expected SHA-256: a pinned inline hash (external mode) or
    //    the sidecar (fetched first — small + cheap — so a bad sidecar never
    //    burns bandwidth on the multi-MB tarball).
    const inlineSha = input.sha256?.trim().toLowerCase();
    if (inlineSha && !/^[0-9a-f]{64}$/.test(inlineSha)) {
      throw new ReleaseDownloadError({
        reason: `Malformed inline sha256 — expected 64 hex chars, got ${JSON.stringify(input.sha256)}`,
        url: assetUrl,
        envOverride,
      });
    }
    const expectedSha = inlineSha ?? (await downloadShaSidecar(shaUrl!, scratchSha, envOverride));

    // 3. Download the tarball.
    await downloadTarball(assetUrl, scratchTarball, envOverride);

    // 4. Verify SHA-256 BEFORE any extraction.
    const actualSha = await sha256Of(scratchTarball);
    if (actualSha !== expectedSha) {
      throw new ReleaseDownloadError({
        reason: `SHA-256 mismatch — expected ${expectedSha}, got ${actualSha}. Tarball may be corrupted or tampered with.`,
        url: assetUrl,
        envOverride,
      });
    }

    // 5. Path-traversal + symlink-target validation BEFORE extraction.
    //    Read link targets directly from archive headers.
    await assertTarEntriesSafe(scratchTarball, scratchDir, envOverride);

    // 6. Extract into scratch dir.
    mkdirSync(scratchDir, { recursive: true });
    await readArchive(scratchTarball, extractTar({ cwd: scratchDir, strict: true, preservePaths: false }), envOverride);

    // 7. Atomic publish.
    try {
      renameSync(scratchDir, targetDir);
    } catch (err) {
      // Another worker may have won the race; if the target now
      // exists, accept it and clean up our scratch.
      if (existsSync(targetDir)) {
        rmSync(scratchDir, { recursive: true, force: true });
        return { path: targetDir, downloaded: true };
      }
      throw new ReleaseDownloadError({
        reason: `Failed to publish extracted release to ${targetDir}.`,
        envOverride,
        cause: err,
      });
    }

    return { path: targetDir, downloaded: true };
  } catch (err) {
    // Best-effort cleanup of scratch dir on any failure mid-extract.
    if (existsSync(scratchDir)) {
      rmSync(scratchDir, { recursive: true, force: true });
    }
    throw err;
  } finally {
    // Always clean scratch tarball + sidecar — only needed during this run.
    rmSync(scratchTarball, { force: true });
    rmSync(scratchSha, { force: true });
  }
}

/* ─── Internals ─────────────────────────────────────────────────── */

function ensureHttps(url: string, envOverride: string): void {
  if (!url.startsWith("https://")) {
    throw new ReleaseDownloadError({
      reason: `Refusing non-HTTPS URL: ${url}`,
      envOverride,
    });
  }
}

/**
 * For user-supplied external dist URLs: HTTPS + refuse literal loopback /
 * private / link-local / metadata hosts (SSRF). This early literal check is
 * backed by safeFetch's DNS validation and pinned transport at download time.
 */
export function assertPublicHttps(url: string, envOverride: string): void {
  ensureHttps(url, envOverride);
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new ReleaseDownloadError({ reason: `Malformed URL: ${url}`, envOverride });
  }
  // Delegate to the centralized guard (complete v4/v6/v4-mapped/CGNAT/metadata
  // classification via ipaddr.js) — the previous hand-rolled regex missed
  // v4-mapped IPv6, CGNAT, and alternate encodings. This is the sync literal
  // fast-reject; the download-time safeFetch below also resolves DNS + pins the IP.
  try {
    assertPublicHostLiteral(host);
  } catch (e) {
    throw new ReleaseDownloadError({
      reason: e instanceof SsrfError ? e.message : `Refusing dist URL targeting a private/loopback host: ${host}`,
      url,
      envOverride,
    });
  }
}

async function downloadShaSidecar(
  url: string,
  scratchPath: string,
  envOverride: string,
): Promise<string> {
  let res: SafeFetchResponse;
  try {
    // SSRF-safe: resolves once, pins the validated IP, re-validates redirect hops.
    res = await safeFetch(url, { timeoutMs: SHA256_TIMEOUT_MS, maxRedirects: 5, maxBodyBytes: 8192 });
  } catch (err) {
    if (err instanceof ReleaseDownloadError) throw err;
    throw new ReleaseDownloadError({
      reason: `Failed to download SHA-256 sidecar`,
      url,
      envOverride,
      cause: err,
    });
  }
  if (!res.ok) {
    throw new ReleaseDownloadError({
      reason: `Server returned ${res.status} for SHA-256 sidecar`,
      url,
      envOverride,
    });
  }
  const text = await res.text();
  await writeFile(scratchPath, text);
  // Sidecar format: "<hex>  <filename>\n" — pick the hex token only.
  const hex = text.trim().split(/\s+/)[0]?.toLowerCase();
  if (!hex || !/^[0-9a-f]{64}$/.test(hex)) {
    throw new ReleaseDownloadError({
      reason: `Malformed SHA-256 sidecar — expected 64 hex chars, got: ${JSON.stringify(text.slice(0, 80))}`,
      url,
      envOverride,
    });
  }
  return hex;
}

async function downloadTarball(
  url: string,
  scratchPath: string,
  envOverride: string,
): Promise<void> {
  let res: SafeFetchResponse;
  try {
    // SSRF-safe: pins the validated IP (closes DNS-rebind), re-validates every
    // redirect hop, and caps the buffered artifact. Bytes are sha256-verified by
    // the caller before extraction.
    res = await safeFetch(url, {
      timeoutMs: TARBALL_TIMEOUT_MS,
      maxRedirects: 5,
      maxBodyBytes: MAX_RELEASE_ARTIFACT_BYTES,
    });
  } catch (err) {
    if (err instanceof ReleaseDownloadError) throw err;
    throw new ReleaseDownloadError({
      reason: `Failed to download release tarball`,
      url,
      envOverride,
      cause: err,
    });
  }
  if (!res.ok) {
    throw new ReleaseDownloadError({
      reason: `Server returned ${res.status} for release tarball`,
      url,
      envOverride,
    });
  }
  const buf = await res.bytes();
  if (buf.length === 0) {
    throw new ReleaseDownloadError({ reason: `Empty response body`, url, envOverride });
  }
  await writeFile(scratchPath, buf);
}

async function sha256Of(filePath: string): Promise<string> {
  const buf = await readFile(filePath);
  return createHash("sha256").update(buf).digest("hex").toLowerCase();
}

/**
 * Validate every entry and link target before extracting any files.
 *
 * Entry paths and link targets are validated from the archive headers. No
 * shell process or locale-dependent listing is involved.
 */
async function assertTarEntriesSafe(
  tarballPath: string,
  scratchDir: string,
  envOverride: string,
): Promise<void> {
  const rootResolved = resolve(scratchDir);
  let invalid: Error | undefined;
  const listing = listTar({ strict: true, onReadEntry: entry => {
    if (invalid) return;
    try {
      assertSafePath(entry.path, rootResolved, envOverride);
      if (!["File", "OldFile", "Directory", "SymbolicLink", "Link"].includes(entry.type))
        throw new ReleaseDownloadError({ reason: `Refusing tarball entry type ${entry.type}`, envOverride });
      if (entry.linkpath) assertSafeLinkTarget(entry.path, entry.linkpath, rootResolved, envOverride);
    } catch (error) {
      invalid = error instanceof Error ? error : new Error(String(error));
    }
  } });
  await readArchive(tarballPath, listing, envOverride);
  if (invalid) throw invalid;
}

function assertSafePath(
  entry: string,
  rootResolved: string,
  envOverride: string,
): void {
  if (entry.startsWith("/") || entry.includes("\\")) {
    throw new ReleaseDownloadError({
      reason: `Refusing tarball: absolute path entry "${entry}"`,
      envOverride,
    });
  }
  if (/^[a-zA-Z]:[\\/]/.test(entry)) {
    throw new ReleaseDownloadError({
      reason: `Refusing tarball: Windows drive-letter path entry "${entry}"`,
      envOverride,
    });
  }
  const segments = entry.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.some((s) => s === "..")) {
    throw new ReleaseDownloadError({
      reason: `Refusing tarball: ".." path segment in entry "${entry}"`,
      envOverride,
    });
  }
  const resolved = resolve(rootResolved, entry);
  if (!resolved.startsWith(rootResolved + "/") && resolved !== rootResolved) {
    throw new ReleaseDownloadError({
      reason: `Refusing tarball: entry "${entry}" resolves outside extraction root`,
      envOverride,
    });
  }
}

function assertSafeLinkTarget(
  entry: string,
  target: string,
  rootResolved: string,
  envOverride: string,
): void {
  if (target.startsWith("/") || target.includes("\\")) {
    throw new ReleaseDownloadError({
      reason: `Refusing tarball: entry "${entry}" links to absolute path "${target}"`,
      envOverride,
    });
  }
  if (/^[a-zA-Z]:[\\/]/.test(target)) {
    throw new ReleaseDownloadError({
      reason: `Refusing tarball: entry "${entry}" links to Windows-style absolute path "${target}"`,
      envOverride,
    });
  }
  const segments = target.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.some((s) => s === "..")) {
    throw new ReleaseDownloadError({
      reason: `Refusing tarball: entry "${entry}" links to "${target}" containing ".."`,
      envOverride,
    });
  }
  // Resolve the link target RELATIVE TO THE LINK'S CONTAINING DIRECTORY,
  // mirroring how the kernel resolves a symlink at runtime. The link
  // sits at <rootResolved>/<entry>; its target is resolved against
  // <rootResolved>/<dirname(entry)>.
  const containingDir = resolve(rootResolved, entry, "..");
  const resolved = resolve(containingDir, target);
  if (!resolved.startsWith(rootResolved + "/") && resolved !== rootResolved) {
    throw new ReleaseDownloadError({
      reason: `Refusing tarball: entry "${entry}" link target "${target}" resolves outside extraction root`,
      envOverride,
    });
  }
}

async function readArchive(
  file: string,
  target: ReturnType<typeof listTar> | ReturnType<typeof extractTar>,
  envOverride: string,
): Promise<void> {
  try {
    await pipeline(createReadStream(file), target as NodeJS.WritableStream, {
      signal: AbortSignal.timeout(TAR_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ReleaseDownloadError({
      reason: `Could not read release archive: ${error instanceof Error ? error.message : String(error)}`,
      envOverride,
      cause: error,
    });
  }
}
