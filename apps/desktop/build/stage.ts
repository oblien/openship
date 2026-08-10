/**
 * Stages the self-contained payload the packaged desktop app ships. Everything
 * here is a build OUTPUT — no source is copied.
 *
 *   resources/server/index.js         the API as one `Bun.build` node bundle
 *                                      (@repo/* + deps inlined; ssh2/dockerode
 *                                      external) — run under ELECTRON's Node,
 *                                      NOT a bun binary. See the note below.
 *   resources/dashboard/              the dashboard's own Next standalone output
 *   resources/migrations/             drizzle .sql  → OPENSHIP_MIGRATIONS_DIR
 *   resources/pglite/                 pglite.wasm + pglite.data → OPENSHIP_PGLITE_ASSETS_DIR
 *   resources/geoip/                  GeoLite2-Country.mmdb → OPENSHIP_GEOIP_DB
 *   resources/engine/                 iRedMail engine tree → MAIL_SERVER_ENGINE_DIR
 *   resources/node_modules/           ssh2 + dockerode (external) resolved via NODE_PATH
 *
 * WHY A NODE BUNDLE, NOT `bun build --compile`:
 *   The API talks to remote Docker daemons over SSH (ssh2 streamlocal +
 *   dockerode). A `bun --compile` binary can't ship that stack:
 *     • bundling ssh2/dockerode IN mangles ssh2's dynamic cipher/KEX require()s
 *       and dockerode's transport (the SSH/Docker socket-forward hangs), and
 *     • keeping them EXTERNAL only resolves at runtime on Bun < 1.3.4 — Bun
 *       1.3.4 regressed `--compile --external` to the virtual $bunfs root
 *       (oven-sh/bun #25500), and that pre-1.3.4 runtime carries node:http/
 *       node:net bugs that hang dockerode-over-loopback in a compiled binary.
 *   So there is NO Bun version where the compiled desktop API can reach Docker.
 *   Instead we bundle for Node (`Bun.build target:node`, exactly like the CLI's
 *   build/stage-server.ts) and run it under Electron's own Node (services.ts,
 *   utilityProcess.fork) — the same runtime as `bun dev` (node --import tsx) and
 *   the self-hosted `node dist/index.js`, where Docker-over-SSH works cleanly.
 *
 * Invoked by electron-forge's `generateAssets` hook (forge.config.js) and also
 * runnable standalone with `bun run build/stage.ts`. Must run under bun — it
 * uses `Bun.build` and shells out to `bun run build` via process.execPath.
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = join(DESKTOP_DIR, "..", "..");
const RESOURCES = join(DESKTOP_DIR, "resources");

const API_DIR = join(REPO_ROOT, "apps/api");
const DASHBOARD_DIR = join(REPO_ROOT, "apps/dashboard");
const DB_DRIZZLE_DIR = join(REPO_ROOT, "packages/db/drizzle");
const EMAIL_ENGINE_DIR = join(REPO_ROOT, "apps/email/engine");

const GEOIP_DB = "GeoLite2-Country.mmdb";

// Build arch — used only for the banner now. The API ships as a plain JS bundle
// run under Electron's Node, so it is arch-INDEPENDENT (no `bun --compile
// --target` cross-compile, no native .node in the API tree): one bundle runs on
// x64 and arm64 alike. A single arm64 runner can still produce every artifact.
const TARGET_ARCH = process.env.FORGE_ARCH || process.arch; // "x64" | "arm64"

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

async function step(title: string, fn: () => void | Promise<void>): Promise<void> {
  const start = Date.now();
  process.stdout.write(`\n▸ ${title}\n`);
  await fn();
  process.stdout.write(`  done in ${((Date.now() - start) / 1000).toFixed(1)}s\n`);
}

function sizeOf(path: string): string {
  const bytes = statSync(path).size;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function main(): Promise<void> {
  const bar = "━".repeat(46);
  process.stdout.write(
    `\n${bar}\n  Building ${APP_NAME} v${APP_VERSION}  ·  ${TARGET}\n${bar}\n`,
  );
  rmSync(RESOURCES, { recursive: true, force: true });
  mkdirSync(RESOURCES, { recursive: true });

  // 1. API → one Node-runnable bundle (NOT a bun --compile binary — see the
  //    file header for why the compiled binary can't reach Docker over SSH).
  //    `Bun.build target:node` inlines @repo/* + every pure-JS/WASM dep into a
  //    single index.js; ssh2/dockerode/cpu-features stay EXTERNAL (bundling them
  //    mangles ssh2's dynamic cipher/KEX require()s + dockerode's transport) and
  //    load from resources/node_modules via NODE_PATH at runtime (services.ts).
  //    This is the exact recipe apps/cli/build/stage-server.ts already ships.
  await step("bundling API → resources/server/index.js (Bun.build target:node)", async () => {
    const serverDir = join(RESOURCES, "server");
    mkdirSync(serverDir, { recursive: true });
    const result = await Bun.build({
      entrypoints: [join(API_DIR, "src/index.ts")],
      target: "node",
      outdir: serverDir,
      naming: "index.js",
      external: ["cpu-features", "ssh2", "dockerode"],
    });
    if (!result.success) {
      for (const log of result.logs) console.error(log);
      throw new Error("API bundle failed");
    }
    // The API is ESM (apps/api package.json `type: module`) and lands in a dir
    // with no package.json, so Node would treat a bare `.js` as CommonJS and the
    // top-level `import`s would throw. Drop a type:module marker so Electron's
    // Node loads index.js (and any dynamic-import chunks Bun emits alongside it)
    // as ESM. `private` keeps it from ever being mistaken for a publishable pkg.
    writeFileSync(
      join(serverDir, "package.json"),
      JSON.stringify({ name: "openship-api-bundle", private: true, type: "module" }, null, 2),
    );
    process.stdout.write(`  index.js: ${sizeOf(join(serverDir, "index.js"))}\n`);
  });

  // 1b. Stage the SSH/Docker stack (externalized above) as a real node_modules
  //     the Node bundle resolves at runtime via NODE_PATH (set in services.ts).
  //     npm produces a hoisted tree with all transitive deps (asn1,
  //     bcrypt-pbkdf, docker-modem, …); versions track packages/adapters so the
  //     shipped copy matches what the API was built against.
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
  await step("staging ssh2 + dockerode → resources/node_modules", () => {
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

  // 1c. CANARY: confirm the externalized ssh2/dockerode actually LOAD under
  //     Node using the EXACT resolution the packaged app performs at boot. The
  //     bundle is ESM, and ESM `import` IGNORES NODE_PATH — it walks parent
  //     `node_modules` from the importing file. So the probe lives in
  //     resources/server/ (beside the bundle) and resolves ssh2/dockerode from
  //     resources/node_modules by parent-dir walk, no NODE_PATH. Runs under the
  //     host `node` (not bun): a bundling change that drops a transitive dep, or
  //     a wrong node_modules placement, then FAILS THE BUILD here instead of
  //     shipping an app that dies at startup with "Cannot find package 'ssh2'".
  //     Pure-JS/WASM, so host-arch node represents Electron's Node on every target.
  await step("verifying ssh2 + dockerode resolve from the bundle's node_modules", () => {
    const probe = join(RESOURCES, "server", "__externals-probe.mjs");
    writeFileSync(
      probe,
      "import { Client } from 'ssh2';\n" +
        "import Dockerode from 'dockerode';\n" +
        "if (typeof Client !== 'function') { console.error('NO_SSH2'); process.exit(1); }\n" +
        "if (typeof Dockerode !== 'function') { console.error('NO_DOCKERODE'); process.exit(1); }\n" +
        "console.log('EXTERNALS_OK');\n",
    );
    try {
      const out = execFileSync("node", [probe], { encoding: "utf8" });
      if (!out.includes("EXTERNALS_OK")) {
        throw new Error(`canary did not confirm load (got: ${out.trim()})`);
      }
    } catch (err) {
      throw new Error(
        "ssh2/dockerode resolution canary FAILED — the packaged app won't be able to load them from " +
          "resources/node_modules. Check step 1b staged the full transitive tree beside the bundle. " +
          `Underlying: ${(err as Error).message}`,
      );
    } finally {
      rmSync(probe, { force: true });
    }
    process.stdout.write("  ssh2 + dockerode resolve from resources/node_modules ✓\n");
  });

  // 2. Dashboard → build fresh with prod/local env, then copy the Next
  //    standalone OUTPUT. A release is always local + production.
  await step("building dashboard (next build, standalone)", () => {
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

  await step("copying dashboard standalone → resources/dashboard/", () => {
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

  // 3. Migrations — plain .sql shipped beside the bundle. The API reads them
  //    via OPENSHIP_MIGRATIONS_DIR (set by the desktop at spawn).
  await step("copying migrations → resources/migrations/", () => {
    cpSync(DB_DRIZZLE_DIR, join(RESOURCES, "migrations"), { recursive: true });
  });

  // 4. PGlite WASM + fs image — data files shipped beside the bundle. The API
  //    hands them to PGlite via OPENSHIP_PGLITE_ASSETS_DIR (set at spawn).
  await step("copying pglite assets → resources/pglite/", () => {
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

  // 5. GeoLite2-Country DB — vendored in the repo, used for the country flag on
  //    each server row. geo-ip.ts probes paths relative to its own module, which
  //    inside the bundle is resources/server/, so an unstaged DB would miss and
  //    the desktop would silently download 8.8 MB from raw.githubusercontent.com
  //    on the first lookup (and show no flags offline) — the opposite of what
  //    geo-ip.ts documents ("production reads OUR shipped copy"). Handed over as
  //    OPENSHIP_GEOIP_DB at spawn (services.ts).
  await step("copying geoip db → resources/geoip/", () => {
    const src = join(API_DIR, "assets/geoip");
    if (!existsSync(join(src, GEOIP_DB))) {
      throw new Error(
        `geoip asset missing: ${join(src, GEOIP_DB)} — run \`bun run update:geoip\` at the repo root`,
      );
    }
    const dest = join(RESOURCES, "geoip");
    mkdirSync(dest, { recursive: true });
    cpSync(join(src, GEOIP_DB), join(dest, GEOIP_DB));
    process.stdout.write(`  ${GEOIP_DB}: ${sizeOf(join(dest, GEOIP_DB))}\n`);
  });

  // 6. iRedMail engine — the mail-server install source (apps/email/engine, the
  //    already-slimmed tree that is the source of truth; see mail.service.ts).
  //    mail.service.ts packs THIS tree into a tar and streams it to the target
  //    VPS in step "Transfer iRedMail Engine". Its default path is resolved
  //    relative to apps/api's cwd (the monorepo-dev layout) — which is WRONG in
  //    the packaged app, where the API runs with cwd=userData. Ship the tree and
  //    hand its absolute path over as MAIL_SERVER_ENGINE_DIR (services.ts) so the
  //    resolver never has to guess. Unstaged, mail-server setup fails with
  //    "tar: could not chdir to '…/Library/apps/email/engine'".
  await step("copying iRedMail engine → resources/engine/", () => {
    if (!existsSync(join(EMAIL_ENGINE_DIR, "iRedMail.sh"))) {
      throw new Error(
        `iRedMail engine missing or incomplete: expected ${join(EMAIL_ENGINE_DIR, "iRedMail.sh")}`,
      );
    }
    // Skip .DS_Store so the shipped tree is deterministic across dev machines
    // (apps/email/engine/.gitignore expects it to appear locally).
    cpSync(EMAIL_ENGINE_DIR, join(RESOURCES, "engine"), {
      recursive: true,
      filter: (src) => !src.endsWith("/.DS_Store"),
    });
  });

  // NB: OpenResty Lua is NOT staged here. Unlike migrations/pglite (plain data
  //   files), the .lua scripts are embedded as base64 in the API bundle itself
  //   (packages/adapters/src/infra/lua-embedded.ts) so they travel inside the
  //   JS bundle with no path to lose — see scripts/embed-lua.ts.
  //
  // NB: the openship + webmail RELEASE DISTS are not staged either — they are
  //   downloaded (sha256-verified) from the matching GitHub release on first use,
  //   via resolveReleaseDist slot 3. Staging them would mean shipping a second
  //   copy of the dashboard standalone. To test a packaged build against a dist
  //   that has not been published yet, build it locally
  //   (`bun run build:server`) and launch the app with
  //   OPENSHIP_RELEASE_DIST_PATH=<repo>/apps/api/release-dist — slot 1 — which
  //   gives the packaged app the same behaviour as a from-source dev run.

  process.stdout.write(
    `\n✓ Staged ${APP_NAME} v${APP_VERSION} for ${TARGET} → apps/desktop/resources\n`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
