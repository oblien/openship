/**
 * Stages the self-contained payload the packaged desktop app ships. Everything
 * here is a build OUTPUT — no source is copied.
 *
 *   resources/bin/openship-api[.exe]  the API as one `bun build --compile`
 *                                     binary (bundles the bun runtime; runs raw)
 *   resources/dashboard/              the dashboard's own Next standalone output
 *   resources/migrations/             drizzle .sql  → OPENSHIP_MIGRATIONS_DIR
 *   resources/pglite/                 pglite.wasm + pglite.data → OPENSHIP_PGLITE_ASSETS_DIR
 *   resources/lua/                    OpenResty scripts → OPENSHIP_LUA_DIR
 *
 * Invoked by electron-forge's `generateAssets` hook (forge.config.js) and also
 * runnable standalone with `bun run build/stage.ts`. Must run under bun — it
 * shells out to `bun build --compile` and `bun run build` via process.execPath.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = join(DESKTOP_DIR, "..", "..");
const RESOURCES = join(DESKTOP_DIR, "resources");

const API_DIR = join(REPO_ROOT, "apps/api");
const DASHBOARD_DIR = join(REPO_ROOT, "apps/dashboard");
const DB_DRIZZLE_DIR = join(REPO_ROOT, "packages/db/drizzle");
const ADAPTERS_LUA_DIR = join(REPO_ROOT, "packages/adapters/src/infra/lua");

const isWin = process.platform === "win32";
const API_BIN = isWin ? "openship-api.exe" : "openship-api";

// Target arch for the compiled API binary. electron-forge passes the build
// arch to the generateAssets hook, which forwards it as FORGE_ARCH; default to
// the host arch. This lets a single arm64 macOS runner cross-compile the x64
// binary too (bun --compile --target downloads the target runtime), so we don't
// depend on scarce Intel (macos-13) CI runners.
const TARGET_ARCH = process.env.FORGE_ARCH || process.arch; // "x64" | "arm64"
const BUN_OS = process.platform === "win32" ? "windows" : process.platform; // darwin|linux|windows
const BUN_TARGET = `bun-${BUN_OS}-${TARGET_ARCH}`;

// Identity shown in the build banner.
const pkg = JSON.parse(
  readFileSync(join(DESKTOP_DIR, "package.json"), "utf8"),
) as { productName?: string; name?: string; version?: string };
const APP_NAME = pkg.productName ?? pkg.name ?? "Openship";
const APP_VERSION = pkg.version ?? "0.0.0";
const TARGET = `${process.platform}/${TARGET_ARCH}`;

// `bun` is whatever runtime is executing this script (the hook launches it via
// `bun run`), so compiling with process.execPath guarantees the same bun.
const BUN = process.execPath;

function step(title: string, fn: () => void): void {
  const start = Date.now();
  process.stdout.write(`\n▸ ${title}\n`);
  fn();
  process.stdout.write(`  done in ${((Date.now() - start) / 1000).toFixed(1)}s\n`);
}

function sizeOf(path: string): string {
  const bytes = statSync(path).size;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function main(): void {
  const bar = "━".repeat(46);
  process.stdout.write(
    `\n${bar}\n  Building ${APP_NAME} v${APP_VERSION}  ·  ${TARGET}\n${bar}\n`,
  );
  rmSync(RESOURCES, { recursive: true, force: true });
  mkdirSync(RESOURCES, { recursive: true });

  // 1. API → single self-contained binary. No source ships; --compile embeds
  //    the bun runtime + all bundled modules into one executable. (It links no
  //    GUI framework, so it never shows a Dock tile.)
  step(`compiling API → resources/bin/${API_BIN}`, () => {
    const binDir = join(RESOURCES, "bin");
    mkdirSync(binDir, { recursive: true });
    const out = join(binDir, API_BIN);
    // cpu-features is an optional native dep of ssh2 whose .node binding can't
    // be embedded in a --compile binary. ssh2 guards its require in try/catch
    // and falls back to pure JS, so keep it external instead of failing here.
    // --target pins the output arch so we can cross-compile x64 on an arm64 host.
    execFileSync(
      BUN,
      [
        "build",
        join(API_DIR, "src/index.ts"),
        "--compile",
        `--target=${BUN_TARGET}`,
        "--external",
        "cpu-features",
        "--outfile",
        out,
      ],
      { cwd: REPO_ROOT, stdio: "inherit" },
    );
    // Set the exec bit HERE, before electron packages + signs the bundle. Doing
    // it post-package (the old forge postPackage hook) mutated an already-signed
    // .app and broke the code-signature seal on macOS. Windows doesn't use it.
    if (!isWin) chmodSync(out, 0o755);
    process.stdout.write(`  ${API_BIN}: ${sizeOf(out)}\n`);
  });

  // 2. Dashboard → build fresh with prod/local env, then copy the Next
  //    standalone OUTPUT. A release is always local + production.
  step("building dashboard (next build, standalone)", () => {
    execFileSync(BUN, ["run", "build"], {
      cwd: DASHBOARD_DIR,
      stdio: "inherit",
      env: {
        ...process.env,
        NODE_ENV: "production",
        CLOUD_MODE: "false",
        OPENSHIP_TARGET: "local",
      },
    });
  });

  step("copying dashboard standalone → resources/dashboard/", () => {
    const standalone = join(DASHBOARD_DIR, ".next/standalone");
    const staticDir = join(DASHBOARD_DIR, ".next/static");
    const publicDir = join(DASHBOARD_DIR, "public");
    if (!existsSync(standalone)) {
      throw new Error(
        `Next standalone output missing — expected ${standalone}. ` +
          `Check apps/dashboard/next.config.mjs has \`output: "standalone"\`.`,
      );
    }
    const target = join(RESOURCES, "dashboard");
    // The monorepo-rooted standalone lands as:
    //   dashboard/apps/dashboard/server.js   ← entry (cwd for spawn)
    //   dashboard/node_modules, dashboard/packages, dashboard/package.json
    // `.next/static` and `public/` are excluded from standalone (Next assumes a
    // CDN); re-home them where the standalone server expects to find them.
    cpSync(standalone, target, { recursive: true });
    const innerNext = join(target, "apps/dashboard/.next");
    mkdirSync(innerNext, { recursive: true });
    cpSync(staticDir, join(innerNext, "static"), { recursive: true });
    if (existsSync(publicDir)) {
      cpSync(publicDir, join(target, "apps/dashboard/public"), { recursive: true });
    }
  });

  // 3. Migrations — plain .sql the compiled binary can't embed. The API reads
  //    them via OPENSHIP_MIGRATIONS_DIR (set by the desktop at spawn).
  step("copying migrations → resources/migrations/", () => {
    cpSync(DB_DRIZZLE_DIR, join(RESOURCES, "migrations"), { recursive: true });
  });

  // 4. PGlite WASM + fs image — data files bun --compile can't embed. The API
  //    hands them to PGlite via OPENSHIP_PGLITE_ASSETS_DIR (set at spawn).
  step("copying pglite assets → resources/pglite/", () => {
    const require = createRequire(join(REPO_ROOT, "packages/db/package.json"));
    const pgliteDist = dirname(require.resolve("@electric-sql/pglite"));
    const dest = join(RESOURCES, "pglite");
    mkdirSync(dest, { recursive: true });
    for (const file of ["pglite.wasm", "pglite.data"]) {
      const src = join(pgliteDist, file);
      if (!existsSync(src)) {
        throw new Error(`pglite asset missing: ${src}`);
      }
      cpSync(src, join(dest, file));
    }
  });

  // 5. OpenResty Lua scripts — data files bun --compile can't embed. The API
  //    reads them via OPENSHIP_LUA_DIR (set by the desktop at spawn).
  step("copying OpenResty scripts → resources/lua/", () => {
    cpSync(ADAPTERS_LUA_DIR, join(RESOURCES, "lua"), { recursive: true });
  });

  process.stdout.write(
    `\n✓ Staged ${APP_NAME} v${APP_VERSION} for ${TARGET} → apps/desktop/resources\n`,
  );
}

main();
