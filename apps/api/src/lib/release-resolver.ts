/**
 * ONE resolver for a prebuilt release/dist directory, generalizing the two
 * near-identical copies that used to live in migration/openship-dist.ts and
 * webmail-project.service.ts. A release-source project (or the openship-instance
 * / webmail apps) deploys the directory this returns as `localPath` with no
 * build.
 *
 * Three-slot resolution (unchanged from the originals):
 *   1. env override           → point at a local dist (Docker/CI/air-gapped)
 *   2. repo-local dev path     → the checkout's built dist
 *   3. <dataDir>/<name>-dist/v<version>/ → cache; downloaded on miss, from a
 *      GitHub release asset OR an external HTTPS tarball, sha256-verified.
 *
 * Also exposes the "latest version" lookup used by the release-drift banner,
 * reusing the same GitHub Releases shape the CLI/desktop self-update use.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { GithubReleasePayload, ReleaseSource } from "@repo/core";
import { renderAssetName } from "@repo/core";
import { APP_VERSION } from "./app-version";
import { assertPublicHttps, fetchAndExtractRelease } from "./release-download";

const __dirname = (() => {
  try {
    return resolve(fileURLToPath(import.meta.url), "..");
  } catch {
    return resolve(process.cwd(), "apps/api/src/lib");
  }
})();

/** apps/api/ directory — repo-local dist anchors + package.json read. */
const API_ROOT = resolve(__dirname, "../..");

/**
 * Resolve a path relative to apps/api/. Consumers use this for their
 * slot-2 repo-local dev dist anchor instead of re-deriving __dirname:
 *   openship → apiRootPath("release-dist")
 *   webmail  → apiRootPath("..", "email", "dist")
 */
export function apiRootPath(...segments: string[]): string {
  return resolve(API_ROOT, ...segments);
}

/**
 * The API's own version (mono-version default for openship/webmail dists).
 *
 * Returns the version EMBEDDED at build time — never package.json off disk. The
 * desktop ships the API as a `bun build --compile` binary where
 * `import.meta.url` is `/$bunfs/root`, so `API_ROOT` resolves to `/` and the
 * old `readFileSync(join(API_ROOT, "package.json"))` threw
 * `ENOENT: /package.json`. That took down webmail deploys and
 * migrate-to-server before they ever reached the release download, and forced
 * catalog-source.ts to wrap this in a try/catch (which silently disabled the
 * `minEngine` gate). `APP_VERSION` comes from a JSON *import*, which bun inlines
 * into the binary, so it works from source, from Docker, and compiled.
 */
export function readApiVersion(): string {
  return APP_VERSION;
}

function computeDataDir(): string {
  return process.env.OPENSHIP_DATA_DIR ?? join(homedir(), ".openship");
}

export class ReleaseDistMissingError extends Error {
  readonly code = "RELEASE_DIST_MISSING" as const;
  constructor(public readonly name: string, distPath: string, options?: { cause?: unknown }) {
    super(
      `Release dist for "${name}" not found at ${distPath}. Build it locally, ` +
        `set its env override to a prebuilt dir, or ensure the release asset exists.`,
      options,
    );
    this.name = "ReleaseDistMissingError";
  }
}

export interface ReleaseDistSpec {
  /** Cache subdir + error text, e.g. "openship" | "email" | project slug. */
  name: string;
  /** Semver (leading "v" tolerated). */
  version: string;
  source: ReleaseSource;
  /** Slot-1 env var name (e.g. "OPENSHIP_RELEASE_DIST_PATH"). */
  envOverride?: string;
  /** Subdir joined under the env-override dir (webmail joins "dist"). */
  envOverrideSubdir?: string;
  /** Slot-2 absolute repo-local dev dist path. */
  repoLocalPath?: string;
  /** Slot-3 cache root (default OPENSHIP_DATA_DIR ?? ~/.openship). */
  dataDir?: string;
}

export interface ReleaseDistResult {
  dir: string;
  version: string;
  asset?: string;
  origin: "env" | "repo-local" | "cache-hit" | "downloaded";
}

/** Resolve (and download on miss) the prebuilt dist directory for a release source. */
export async function resolveReleaseDist(spec: ReleaseDistSpec): Promise<ReleaseDistResult> {
  const version = spec.version.replace(/^v/, "");
  const tag = `v${version}`;

  // Slot 1: env override.
  if (spec.envOverride) {
    const raw = process.env[spec.envOverride];
    if (raw) {
      const dir = spec.envOverrideSubdir ? resolve(raw, spec.envOverrideSubdir) : resolve(raw);
      if (existsSync(dir)) return { dir, version, origin: "env" };
      throw new ReleaseDistMissingError(spec.name, dir);
    }
  }

  // Slot 2: repo-local dev path.
  if (spec.repoLocalPath && existsSync(spec.repoLocalPath)) {
    return { dir: spec.repoLocalPath, version, origin: "repo-local" };
  }

  // Slot 3: cache; download on miss.
  const cacheDir = join(spec.dataDir ?? computeDataDir(), `${spec.name}-dist`);
  const cachedTarget = join(cacheDir, tag);
  if (existsSync(cachedTarget)) return { dir: cachedTarget, version, origin: "cache-hit" };

  const src = spec.source;
  try {
    if (src.mode === "url") {
      const assetUrl = subst(src.distUrl ?? "", version, tag);
      if (!assetUrl) throw new Error("release source mode=url is missing distUrl");
      const res = await fetchAndExtractRelease({
        tag,
        cacheDir,
        assetUrl,
        shaUrl: src.sha256Url ? subst(src.sha256Url, version, tag) : undefined,
        sha256: src.sha256,
        envOverride: spec.envOverride,
      });
      return { dir: res.path, version, asset: assetUrl, origin: "downloaded" };
    }
    // GitHub-Releases mode.
    const asset = renderAssetName(src.assetTemplate ?? `${spec.name}-{tag}-{os}-{arch}.tar.gz`, {
      version,
      os: src.os,
      arch: src.arch,
    });
    const res = await fetchAndExtractRelease({ repo: src.repo, asset, tag, cacheDir });
    return { dir: res.path, version, asset, origin: "downloaded" };
  } catch (err) {
    throw new ReleaseDistMissingError(spec.name, cachedTarget, { cause: err });
  }
}

/** Non-throwing, no-download variant (env + repo-local + already-cached only). */
export function resolveReleaseDistOrNull(spec: ReleaseDistSpec): string | null {
  const version = spec.version.replace(/^v/, "");
  if (spec.envOverride) {
    const raw = process.env[spec.envOverride];
    if (raw) {
      const dir = spec.envOverrideSubdir ? resolve(raw, spec.envOverrideSubdir) : resolve(raw);
      return existsSync(dir) ? dir : null;
    }
  }
  if (spec.repoLocalPath && existsSync(spec.repoLocalPath)) return spec.repoLocalPath;
  const cached = join(spec.dataDir ?? computeDataDir(), `${spec.name}-dist`, `v${version}`);
  return existsSync(cached) ? cached : null;
}

function subst(s: string, version: string, tag: string): string {
  return s.replaceAll("{version}", version).replaceAll("{tag}", tag);
}

// ─── Latest-version lookup (drift) ─────────────────────────────────────────────

/** Fetch a repo's latest published release (best-effort; null on any failure). */
export async function fetchLatestRelease(repo: string): Promise<GithubReleasePayload | null> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10_000);
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "openship" },
      signal: ctl.signal,
    }).finally(() => clearTimeout(timer));
    if (!res.ok) return null;
    return (await res.json()) as GithubReleasePayload;
  } catch {
    return null;
  }
}

/** Latest release tag (leading "v" stripped), or null. */
export async function resolveLatestReleaseTag(repo: string): Promise<string | null> {
  const release = await fetchLatestRelease(repo);
  const tag = release?.tag_name?.trim();
  return tag ? tag.replace(/^v/, "") : null;
}

/**
 * Newest version a release source advertises (leading "v" stripped), or null.
 * github → latest release tag; url → a `versionUrl` returning either JSON
 * (`version`/`tag_name`) or a bare version string. Ignores `pinnedVersion` —
 * this is "what's the newest out there", the drift banner's `latest`. SSRF-
 * guarded (public HTTPS only), best-effort (null on any failure).
 */
export async function resolveLatestVersion(source: ReleaseSource): Promise<string | null> {
  if (source.mode === "url") {
    if (!source.versionUrl) return null;
    return fetchVersionFromUrl(source.versionUrl);
  }
  return source.repo ? resolveLatestReleaseTag(source.repo) : null;
}

async function fetchVersionFromUrl(url: string): Promise<string | null> {
  try {
    assertPublicHttps(url, "releaseSource.versionUrl");
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10_000);
    const res = await fetch(url, {
      headers: { "User-Agent": "openship" },
      redirect: "follow",
      signal: ctl.signal,
    }).finally(() => clearTimeout(timer));
    if (!res.ok) return null;
    const body = (await res.text()).trim();
    if (!body) return null;
    // JSON { version | tag_name } first, else treat the body as a bare version.
    if (body.startsWith("{")) {
      try {
        const parsed = JSON.parse(body) as { version?: unknown; tag_name?: unknown };
        const v = typeof parsed.version === "string" ? parsed.version : parsed.tag_name;
        return typeof v === "string" && v.trim() ? v.trim().replace(/^v/, "") : null;
      } catch {
        return null;
      }
    }
    return body.replace(/^v/, "");
  } catch {
    return null;
  }
}
