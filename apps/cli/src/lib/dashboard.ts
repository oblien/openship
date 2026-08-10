/**
 * Lazy-download of the Openship dashboard (Next standalone) so `openship up`
 * can serve a local browser UI without bloating the npm package. Mirrors the
 * desktop-app download in `openship install`: fetch the release asset, verify
 * its sha256 sidecar, extract, and cache under ~/.openship/cache/dashboard/<tag>/.
 *
 * The bundle has NO native deps (dashboard `output: "standalone"`, no
 * sharp/etc.), so a single Linux-built tarball runs cross-platform under Node.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CACHE_DIR, downloadToFile } from "./cache";
import { assetUrl, expectedSha256, resolveLatestTag } from "./github-releases";

/** Where release bundles are cached (named by `up --dry-run`). */
export const DASHBOARD_CACHE = join(CACHE_DIR, "dashboard");

function assetName(tag: string): string {
  return `openship-dashboard-${tag}.tar.gz`;
}

export interface DashboardBundle {
  tag: string;
  /** Entry to run with the CLI's runtime (Node/Bun): the WS-capable
   *  standalone-server.mjs wrapper when present, else the plain server.js. */
  entry: string;
  /** Directory the entry must run from so its relative .next/public resolve. */
  cwd: string;
}

/**
 * Ensure the dashboard bundle for `tag` is present (download + verify + extract
 * if missing) and return where to run it. Throws with an actionable message on
 * a missing asset or checksum mismatch.
 */
/**
 * The entry to run. Proxy-mode bundles (Docker image, `--from-source` stage)
 * ship `standalone-server.mjs` — a WS-capable wrapper that proxies `/api/proxy/*`
 * WebSocket upgrades (the server terminal) to the internal API, since the Next
 * `/api/proxy` route handler can't upgrade. Non-proxy bundles (which reach the
 * API directly, so WS needs no proxy) ship only `server.js`. Prefer the wrapper
 * when present; fall back to the plain standalone entry otherwise.
 */
function resolveDashboardEntry(cwd: string): string {
  const wrapped = join(cwd, "standalone-server.mjs");
  return existsSync(wrapped) ? wrapped : join(cwd, "server.js");
}

export async function ensureDashboard(
  opts: { tag?: string; onProgress?: (received: number, total: number) => void } = {},
): Promise<DashboardBundle> {
  // Local override for testing an UNPUBLISHED build (dev / pre-release / CI):
  // point at a locally-built Next standalone dir instead of downloading from
  // GitHub. Expects the monorepo-rooted layout <dir>/apps/dashboard/server.js
  // (i.e. apps/dashboard/.next/standalone). No checksum — it's your own build.
  const override = process.env.OPENSHIP_DASHBOARD_DIR?.trim();
  if (override) {
    const cwd = join(override, "apps", "dashboard");
    const serverJs = join(cwd, "server.js");
    if (!existsSync(serverJs)) {
      throw new Error(
        `OPENSHIP_DASHBOARD_DIR=${override} but ${serverJs} is missing — build the dashboard standalone first (see docs).`,
      );
    }
    return { tag: "local", entry: resolveDashboardEntry(cwd), cwd };
  }

  const requested = opts.tag ?? (await resolveLatestTag());
  try {
    return await fetchBundle(requested, opts.onProgress);
  } catch (err) {
    // A pinned tag whose dashboard asset isn't published — a dev/source build
    // whose version was never released, or a release that shipped no dashboard —
    // falls back to the latest published release instead of hard-404ing. Only
    // triggers when a tag was explicitly requested (default already = latest).
    if (opts.tag && /\b404\b/.test((err as Error)?.message ?? "")) {
      const latest = await resolveLatestTag();
      if (latest && latest !== requested) {
        return await fetchBundle(latest, opts.onProgress);
      }
    }
    throw err;
  }
}

/** Download + verify + extract the dashboard bundle for a specific tag (or reuse
 *  the cached copy). Throws with an actionable message on a missing asset,
 *  missing sidecar, or checksum mismatch. */
async function fetchBundle(
  tag: string,
  onProgress?: (received: number, total: number) => void,
): Promise<DashboardBundle> {
  const dir = join(DASHBOARD_CACHE, tag);
  const cwd = join(dir, "apps", "dashboard");
  const serverJs = join(cwd, "server.js");
  const marker = join(dir, ".extracted");

  // Cached + intact → reuse.
  if (existsSync(marker) && existsSync(serverJs)) {
    return { tag, entry: resolveDashboardEntry(cwd), cwd };
  }

  // Start from a clean dir (a prior run may have partially extracted).
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const name = assetName(tag);
  const tarball = join(dir, name);
  const { sha256 } = await downloadToFile(assetUrl(tag, name), tarball, onProgress);

  const expected = await expectedSha256(tag, name);
  if (!expected) {
    throw new Error(
      `No .sha256 sidecar for ${name}; refusing to run an unverified dashboard bundle.`,
    );
  }
  if (expected !== sha256) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`Dashboard bundle checksum mismatch (expected ${expected}, got ${sha256}).`);
  }

  // `tar` ships on macOS, Linux, and Windows 10+ (bsdtar).
  const untar = spawnSync("tar", ["-xzf", tarball, "-C", dir], { stdio: "inherit" });
  if (untar.status !== 0) {
    throw new Error("Failed to extract the dashboard bundle (is `tar` available?).");
  }
  rmSync(tarball, { force: true });

  if (!existsSync(serverJs)) {
    throw new Error(`Dashboard bundle extracted but ${serverJs} is missing (unexpected layout).`);
  }
  writeFileSync(marker, `${tag}\n`);
  return { tag, entry: resolveDashboardEntry(cwd), cwd };
}
