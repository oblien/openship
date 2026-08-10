/**
 * Build + run Openship from SOURCE (a branch/tag/sha or a local checkout) for
 * `openship up --from-source` — the "preview main on a remote box" flow, the
 * remote sibling of `bun dev` locally.
 *
 * It reuses the canonical `apps/api/scripts/build-release.ts` (the same script
 * the migration wizard ships to servers) to produce a self-contained runnable
 * dist, so there's no bespoke build path to drift:
 *
 *   clone/checkout → bun install → build-release → frozen-lockfile install
 *
 * The result is a `{ apiDir, dashboardDir }` the caller runs through the normal
 * `up` foreground path: the API runs from raw TS via bun (dist/api), the
 * dashboard is the standalone build pointed at via OPENSHIP_DASHBOARD_DIR.
 *
 * This is an UNVERIFIED dev/preview build (no signed release asset, no
 * checksum) — the caller surfaces that; it must not become a production path.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { OS_DIR } from "./paths";

export { OS_DIR };
export const DEFAULT_REPO = "https://github.com/oblien/openship.git";

/** The clone `--from-source` builds from, and the dist it builds into. Exported
 *  so `up --dry-run` names the same dirs this module creates. */
export const SOURCE_CHECKOUT_DIR = join(OS_DIR, "src");
export const SOURCE_DIST_DIR = join(OS_DIR, "from-source-dist");

export interface FromSourceRun {
  /** release-dist/api — the API runs here via `bun run src/index.ts`. */
  apiDir: string;
  /** release-dist/dashboard — set as OPENSHIP_DASHBOARD_DIR (has apps/dashboard/server.js). */
  dashboardDir: string;
  /** Resolved branch/tag/sha, or "local" for --source. */
  ref: string;
  /** Short git sha of what was built (or "unknown"). */
  sha: string;
  /** The monorepo checkout the build ran from. */
  sourceDir: string;
}

/** True when `cmd --version` exits 0 — used to gate on bun/git presence. */
export function has(cmd: string): boolean {
  try {
    return spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

/** Run a command attached (stdio inherited so the operator sees build output),
 *  rejecting on a non-zero exit. */
export function run(cmd: string, args: string[], cwd: string, env?: Record<string, string>): Promise<void> {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: "inherit",
      // Windows resolves the bun/git shims (.cmd/.exe) only through a shell.
      shell: process.platform === "win32",
      env: env ? { ...process.env, ...env } : process.env,
    });
    child.on("error", rej);
    child.on("exit", (code) =>
      code === 0
        ? res()
        : rej(new Error(`\`${cmd} ${args.join(" ")}\` (cwd=${cwd}) exited ${code ?? "?"}`)),
    );
  });
}

export function shortSha(cwd: string): string {
  const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd, encoding: "utf8" });
  return r.status === 0 ? (r.stdout ?? "").trim() || "unknown" : "unknown";
}

export function isMonorepo(dir: string): boolean {
  return (
    existsSync(join(dir, "package.json")) &&
    existsSync(join(dir, "apps/api/package.json")) &&
    existsSync(join(dir, "apps/dashboard/package.json"))
  );
}

/**
 * Resolve source → build → return the runnable dist paths. Throws with an
 * actionable message on any failure (missing bun/git, bad --source, build/OOM).
 */
export async function prepareFromSource(opts: {
  ref?: string;
  source?: string;
  repo?: string;
}): Promise<FromSourceRun> {
  if (!has("bun")) {
    throw new Error(
      "`bun` is required to build from source but wasn't found on PATH — install it: https://bun.sh",
    );
  }

  let sourceDir: string;
  let ref: string;

  if (opts.source) {
    sourceDir = resolve(opts.source);
    if (!isMonorepo(sourceDir)) {
      throw new Error(
        `--source ${sourceDir} doesn't look like an Openship checkout ` +
          `(missing package.json / apps/api / apps/dashboard).`,
      );
    }
    ref = "local";
  } else {
    if (!has("git")) {
      throw new Error("`git` is required to clone the source but wasn't found on PATH.");
    }
    ref = (opts.ref || "main").trim();
    const repoUrl = opts.repo || DEFAULT_REPO;
    sourceDir = SOURCE_CHECKOUT_DIR;
    mkdirSync(OS_DIR, { recursive: true });
    if (!existsSync(join(sourceDir, ".git"))) {
      console.log(`  Cloning ${repoUrl} → ${sourceDir}`);
      await run("git", ["clone", repoUrl, sourceDir], OS_DIR);
    }
    console.log(`  Fetching + checking out ${ref}`);
    await run("git", ["fetch", "origin", ref, "--tags"], sourceDir);
    await run("git", ["checkout", ref], sourceDir);
    // Fast-forward to the remote tip on a branch; a tag/sha stays pinned (the
    // pull is best-effort so a detached ref doesn't hard-fail the build).
    await run("git", ["pull", "--ff-only", "origin", ref], sourceDir).catch(() => {
      console.log("  (pinned ref — not fast-forwarding)");
    });
  }

  const sha = shortSha(sourceDir);
  console.log(`  Source: ${sourceDir} @ ${ref} (${sha})`);

  // Workspace install — the dashboard build + build-release need their deps.
  console.log("  Installing workspace dependencies (bun install)…");
  await run("bun", ["install"], sourceDir);

  // Build the self-contained dist with the SAME script the migration wizard
  // ships (dashboard standalone + api src + workspace packages + lockfile).
  // Output to a stable dir OUTSIDE the checkout so a --source tree isn't dirtied.
  const distDir = SOURCE_DIST_DIR;
  console.log("  Building release dist (compiles the dashboard — needs RAM/CPU)…");
  await run(
    "bun",
    ["run", join(sourceDir, "apps/api/scripts/build-release.ts")],
    sourceDir,
    { DIST_DIR: distDir, NODE_ENV: "production", CLOUD_MODE: "false", OPENSHIP_TARGET: "local" },
  );

  // Reproduce the runtime dependency graph from the generated frozen lockfile.
  console.log("  Installing runtime dependencies in the dist…");
  await run("bun", ["install", "--production", "--frozen-lockfile"], distDir);

  const apiDir = join(distDir, "api");
  const dashboardDir = join(distDir, "dashboard");
  if (!existsSync(join(apiDir, "src/index.ts"))) {
    throw new Error(`Build produced no API at ${apiDir}/src/index.ts — build-release layout drift?`);
  }
  if (!existsSync(join(dashboardDir, "apps/dashboard/server.js"))) {
    throw new Error(`Build produced no dashboard at ${dashboardDir}/apps/dashboard/server.js.`);
  }

  return { apiDir, dashboardDir, ref, sha, sourceDir };
}
