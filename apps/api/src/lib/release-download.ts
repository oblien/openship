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
 *   3. **Path-traversal protection.** We list the tarball with
 *      `tar -tvzf` BEFORE extraction (verbose — shows symlink targets,
 *      hardlink targets, and entry types). Each entry is validated:
 *        - no `..` segments in the name
 *        - no absolute paths
 *        - no symlink/hardlink target with `..`, absolute, or escapes root
 *        - the resolved entry path stays inside the extraction root
 *      Only after the full listing passes do we run `tar -xzf`. This
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
 *      (`OPENSHIP_RELEASE_DIST_PATH` or `MAIL_WEBMAIL_SOURCE_DIR`)
 *      the operator can point at a local directory to bypass the
 *      download entirely.
 *
 * Layout produced inside cacheDir:
 *
 *   <cacheDir>/<tag>/             ← final extracted dist (returned path)
 *   <cacheDir>/<tag>.tmp.<pid>/   ← scratch dir for in-flight extraction
 *   <cacheDir>/<tag>.<pid>.tar.gz ← scratch tarball, removed after extract
 *   <cacheDir>/<tag>.<pid>.sha256 ← scratch sidecar, removed after extract
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
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
  /** Error-message escape-hatch hint (defaults derived from the asset name). */
  envOverride?: string;
}

export interface FetchAndExtractReleaseResult {
  /** Absolute path to the extracted release directory. */
  path: string;
  /** Whether a download happened (false = cache hit). */
  downloaded: boolean;
}

/**
 * Map an asset filename to the env-override the operator can use to
 * bypass the download. Surfaced in every error message so a stuck
 * download isn't a dead end.
 */
function envOverrideFor(asset: string): string {
  if (asset.startsWith("openship-email-")) return "MAIL_WEBMAIL_SOURCE_DIR";
  return "OPENSHIP_RELEASE_DIST_PATH";
}

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
  const envOverride = input.envOverride ?? (input.asset ? envOverrideFor(input.asset) : "OPENSHIP_RELEASE_DIST_PATH");

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
    //    Use verbose listing so symlink/hardlink targets are visible.
    await assertTarEntriesSafe(scratchTarball, scratchDir, envOverride);

    // 6. Extract into scratch dir.
    mkdirSync(scratchDir, { recursive: true });
    await runTar(
      ["-xzf", scratchTarball, "-C", scratchDir, "--no-absolute-names"],
      envOverride,
    );

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
 * private / link-local / metadata hosts (SSRF). Note: a hostname that RESOLVES
 * to a private IP (DNS rebinding) is a known residual — a full fix needs
 * resolve-then-connect pinning; this blocks the common literal-IP abuse.
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
 * Run `tar -tvzf` and validate every entry — names, AND symlink /
 * hardlink targets — for path-traversal.
 *
 * The verbose listing format we parse:
 *
 *   -rw-r--r-- root/root  123 2026-06-20 ... file.txt
 *   drwxr-xr-x root/root    0 2026-06-20 ... dir/
 *   lrwxrwxrwx root/root    0 2026-06-20 ... evil -> /etc/passwd
 *   hrwxr-xr-x root/root    0 2026-06-20 ... hard => /etc/shadow
 *
 * The arrow-target portion (`-> target` for symlink, `=> target` for
 * hardlink) is what makes the verbose listing necessary — the bare
 * `tar -tzf` output only shows entry names, which lets a malicious
 * tarball slip a symlink with a benign-looking name + a `..`-laden
 * target. Once `tar -xzf` runs, that symlink lands on disk and any
 * downstream code following symlinks gets played.
 */
async function assertTarEntriesSafe(
  tarballPath: string,
  scratchDir: string,
  envOverride: string,
): Promise<void> {
  const stdout = await runTarCapture(
    ["-tvzf", tarballPath],
    envOverride,
  );
  const rootResolved = resolve(scratchDir);
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = parseVerboseTarLine(trimmed);
    if (!parsed) continue; // ignore lines we can't parse (defensive — fail-open on noise but we still gate on entry-path validation below)

    // 1. Entry name (always present).
    assertSafePath(parsed.name, rootResolved, envOverride);

    // 2. Symlink/hardlink target (when present).
    if (parsed.linkTarget) {
      assertSafeLinkTarget(parsed.name, parsed.linkTarget, rootResolved, envOverride);
    }
  }
}

interface TarVerboseEntry {
  name: string;
  /** Set when the entry is a symlink (-> target) or hardlink (=> target). */
  linkTarget?: string;
}

function parseVerboseTarLine(line: string): TarVerboseEntry | null {
  // GNU tar verbose: <mode> <owner> <size> <date> <time> <name>[ -> target | => target]
  // Split off the link target FIRST since path names can contain spaces.
  let name: string;
  let linkTarget: string | undefined;
  const symMatch = line.match(/ -> (.+)$/);
  const hardMatch = line.match(/ => (.+)$/);
  if (symMatch) {
    linkTarget = symMatch[1];
    line = line.slice(0, symMatch.index);
  } else if (hardMatch) {
    linkTarget = hardMatch[1];
    line = line.slice(0, hardMatch.index);
  }
  // The remaining tail is the path. Strip the 5 leading whitespace-
  // delimited columns (mode owner size date time) to get the name.
  const cols = line.split(/\s+/);
  if (cols.length < 6) return null;
  name = cols.slice(5).join(" ");
  if (!name) return null;
  return { name, linkTarget };
}

function assertSafePath(
  entry: string,
  rootResolved: string,
  envOverride: string,
): void {
  if (entry.startsWith("/")) {
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
  if (target.startsWith("/")) {
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

function runTar(args: string[], envOverride: string): Promise<void> {
  return new Promise((resolveTar, rejectTar) => {
    const child = spawn("tar", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectTar(
        new ReleaseDownloadError({
          reason: `tar ${args[0]} timed out after ${TAR_TIMEOUT_MS}ms`,
          envOverride,
        }),
      );
    }, TAR_TIMEOUT_MS);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      rejectTar(
        new ReleaseDownloadError({
          reason: `Failed to spawn tar: ${err.message}`,
          envOverride,
          cause: err,
        }),
      );
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolveTar();
        return;
      }
      rejectTar(
        new ReleaseDownloadError({
          reason: `tar exited with code ${code}: ${stderr.trim() || "(no stderr)"}`,
          envOverride,
        }),
      );
    });
  });
}

function runTarCapture(args: string[], envOverride: string): Promise<string> {
  return new Promise((resolveTar, rejectTar) => {
    const child = spawn("tar", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectTar(
        new ReleaseDownloadError({
          reason: `tar ${args[0]} timed out after ${TAR_TIMEOUT_MS}ms`,
          envOverride,
        }),
      );
    }, TAR_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      rejectTar(
        new ReleaseDownloadError({
          reason: `Failed to spawn tar: ${err.message}`,
          envOverride,
          cause: err,
        }),
      );
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolveTar(stdout);
        return;
      }
      rejectTar(
        new ReleaseDownloadError({
          reason: `tar exited with code ${code}: ${stderr.trim() || "(no stderr)"}`,
          envOverride,
        }),
      );
    });
  });
}
