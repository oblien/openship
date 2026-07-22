/**
 * Stages the self-contained payload the packaged desktop app ships. Everything
 * here is a build OUTPUT — no source is copied.
 *
 *   resources/bin/openship-api[.exe]  the API as one `bun build --compile`
 *                                     binary (bundles the bun runtime; runs raw)
 *   resources/dashboard/              the dashboard's own Next standalone output
 *   resources/migrations/             drizzle .sql  → OPENSHIP_MIGRATIONS_DIR
 *   resources/pglite/                 pglite.wasm + pglite.data → OPENSHIP_PGLITE_ASSETS_DIR
 *
 * Invoked by electron-forge's `generateAssets` hook (forge.config.js) and also
 * runnable standalone with `bun run build/stage.ts`. Must run under bun — it
 * shells out to `bun build --compile` and `bun run build` via process.execPath.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = join(DESKTOP_DIR, "..", "..");
const RESOURCES = join(DESKTOP_DIR, "resources");

const API_DIR = join(REPO_ROOT, "apps/api");
const DASHBOARD_DIR = join(REPO_ROOT, "apps/dashboard");
const DB_DRIZZLE_DIR = join(REPO_ROOT, "packages/db/drizzle");

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
    // ssh2 + dockerode MUST stay external: bundling them into a --compile binary
    // mangles ssh2's dynamic cipher/KEX `require()`s and dockerode's transport,
    // so the SSH handshake / Docker socket-forward hangs (verified). They're
    // staged into resources/node_modules below and resolved at runtime via
    // NODE_PATH (services.ts). cpu-features is ssh2's optional native dep whose
    // .node binding can't be embedded either; ssh2 guards it and falls back.
    // NOTE: runtime resolution of these externals only works on Bun < 1.3.4 —
    // Bun 1.3.4 regressed --compile external resolution to the $bunfs root
    // (oven-sh/bun #25500, issue #111). Build is pinned pre-1.3.4 (.bun-version)
    // and the canary in step 1c fails the build if a bump reintroduces the bug.
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
        "--external",
        "ssh2",
        "--external",
        "dockerode",
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

  // 1b. Stage the SSH/Docker stack (externalized above) as a real node_modules
  //     the compiled binary resolves at runtime via NODE_PATH (set in
  //     services.ts). npm produces a hoisted tree with all transitive deps
  //     (asn1, bcrypt-pbkdf, docker-modem, …); versions track packages/adapters
  //     so the shipped copy matches what the API was built against.
  //
  //     `--omit=optional` is LOAD-BEARING for cross-arch correctness: the only
  //     native module in this tree is `cpu-features` (ssh2's optional CPU probe),
  //     and it has NO prebuilds — node-gyp compiles it for the BUILD-HOST arch,
  //     so a cross-built x64 dmg on the arm64 runner would ship an arm64
  //     `cpu-features.node`. Dropping it makes the tree 100% arch-independent
  //     (zero `.node` files → correct on x64 AND arm64, win/mac/linux); ssh2
  //     falls back to pure-JS/WASM crypto (negligible for control-plane SSH),
  //     dockerode is pure JS. This is why every platform's artifact ships a
  //     complete, working module set with nothing arch-mismatched.
  step("staging ssh2 + dockerode → resources/node_modules", () => {
    const adapters = JSON.parse(
      readFileSync(join(REPO_ROOT, "packages/adapters/package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    execFileSync(
      "npm",
      [
        "install",
        "--prefix",
        RESOURCES,
        "--omit=dev",
        "--omit=optional",
        "--no-audit",
        "--no-fund",
        "--no-package-lock",
        `ssh2@${adapters.dependencies.ssh2}`,
        `dockerode@${adapters.dependencies.dockerode}`,
      ],
      { cwd: REPO_ROOT, stdio: "inherit" },
    );
    process.stdout.write(
      `  node_modules: ${existsSync(join(RESOURCES, "node_modules", "ssh2")) ? "ssh2+dockerode staged" : "MISSING"}\n`,
    );
  });

  // 1c. CANARY for oven-sh/bun #25500 (issue #111). Bun 1.3.4 regressed
  //     `--compile --external` resolution to the virtual $bunfs root, ignoring
  //     NODE_PATH/CWD — so the compiled API silently can't load the externalized
  //     ssh2 and the desktop dies at startup with "Cannot find package 'ssh2'".
  //     Build is pinned pre-1.3.4 (.bun-version); this compiles a tiny probe with
  //     the SAME bun + --external and confirms ssh2 still resolves from the staged
  //     node_modules, so any future Bun bump that reintroduces the bug FAILS THE
  //     BUILD instead of shipping a broken app. Probe is host-arch (not
  //     BUN_TARGET) so it runs on the build machine — the regression is version-,
  //     not arch-, specific.
  step("verifying externalized ssh2 resolves in a compiled binary (bun #25500 canary)", () => {
    const probeSrc = join(RESOURCES, "__ssh2-probe.ts");
    const probeBin = join(RESOURCES, isWin ? "__ssh2-probe.exe" : "__ssh2-probe");
    writeFileSync(
      probeSrc,
      'const m: any = await import("ssh2");\n' +
        'if (typeof m.Client !== "function") { console.error("NO_CLIENT"); process.exit(1); }\n' +
        'console.log("SSH2_PROBE_OK");\n',
    );
    try {
      execFileSync(BUN, ["build", probeSrc, "--compile", "--external", "ssh2", "--outfile", probeBin], {
        cwd: REPO_ROOT,
        stdio: "inherit",
      });
      const out = execFileSync(probeBin, [], {
        env: { ...process.env, NODE_PATH: join(RESOURCES, "node_modules") },
        encoding: "utf8",
      });
      if (!out.includes("SSH2_PROBE_OK")) throw new Error(`probe did not confirm ssh2 (got: ${out.trim()})`);
    } catch (err) {
      throw new Error(
        "ssh2 external-resolution canary FAILED — the compiled binary can't load ssh2 from node_modules. " +
          "This is the Bun #25500 --compile regression (>=1.3.4). Keep .bun-version on a pre-1.3.4 release " +
          `until it is fixed upstream. Underlying: ${(err as Error).message}`,
      );
    } finally {
      rmSync(probeSrc, { force: true });
      rmSync(probeBin, { force: true });
    }
    process.stdout.write("  ssh2 resolves from node_modules ✓\n");
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

  // NB: OpenResty Lua is NOT staged here. Unlike migrations/pglite (plain data
  //   files), the .lua scripts are embedded as base64 in the API bundle itself
  //   (packages/adapters/src/infra/lua-embedded.ts) so they travel inside the
  //   compiled binary with no path to lose — see scripts/embed-lua.ts.

  process.stdout.write(
    `\n✓ Staged ${APP_NAME} v${APP_VERSION} for ${TARGET} → apps/desktop/resources\n`,
  );
}

main();
