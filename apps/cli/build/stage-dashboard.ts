/**
 * Dev-only: build the dashboard from local SOURCE and stage a COMPLETE Next
 * standalone, so `openship up` can serve the CURRENT dashboard through the same
 * `OPENSHIP_DASHBOARD_DIR` folder-override the production CLI already supports —
 * fed from a local build instead of a GitHub download. The CLI code stays the
 * single production version; this just prepares the folder for `cli:dev`.
 *
 * `next build` (output: "standalone") does NOT copy `.next/static` or `public/`
 * into the standalone — in prod they're served from a CDN — so a raw standalone
 * renders unstyled. We build with the same env as the release, then copy those
 * assets in next to server.js. Mirrors apps/api/scripts/build-release.ts staging.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DASHBOARD_DIR = resolve(CLI_DIR, "../dashboard");
const STANDALONE = join(DASHBOARD_DIR, ".next", "standalone");
const INNER = join(STANDALONE, "apps", "dashboard"); // monorepo-rooted standalone

function run(cmd: string, args: string[], cwd: string, env: Record<string, string>): void {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", env: { ...process.env, ...env } });
  if (r.status !== 0) {
    console.error(`\n[stage-dashboard] \`${cmd} ${args.join(" ")}\` failed`);
    process.exit(1);
  }
}

// Build with the release env so it behaves like production: local target, no
// cloud, same-origin API proxy on.
run("bun", ["run", "build"], DASHBOARD_DIR, {
  NODE_ENV: "production",
  CLOUD_MODE: "false",
  OPENSHIP_TARGET: "local",
  NEXT_PUBLIC_API_PROXY: "true",
});

if (!existsSync(join(INNER, "server.js"))) {
  console.error(`[stage-dashboard] standalone missing at ${INNER} — check output:"standalone" in next.config.`);
  process.exit(1);
}

// Copy the assets next build omits, so the served UI has its CSS/JS.
cpSync(join(DASHBOARD_DIR, ".next", "static"), join(INNER, ".next", "static"), { recursive: true });
if (existsSync(join(DASHBOARD_DIR, "public"))) {
  cpSync(join(DASHBOARD_DIR, "public"), join(INNER, "public"), { recursive: true });
}

// WS-capable entry (server terminal). This build is proxy mode
// (NEXT_PUBLIC_API_PROXY), so ship the wrapper next to server.js — ensureDashboard
// prefers it. See apps/dashboard/standalone-server.mjs.
cpSync(join(DASHBOARD_DIR, "standalone-server.mjs"), join(INNER, "standalone-server.mjs"));

console.log(`[stage-dashboard] staged complete standalone at ${STANDALONE}`);
