/**
 * Bundle the Openship API into the CLI package so `openship up` can run the
 * control plane on the user's Node — no monorepo, no bun, no external Postgres.
 *
 * Produces apps/cli/dist/server/:
 *   index.js       the API as one node-runnable bundle (@repo/* + deps inlined,
 *                  EXCEPT the SSH/Docker native stack — see `external` below)
 *   pglite/        pglite.wasm + pglite.data → OPENSHIP_PGLITE_ASSETS_DIR
 *   migrations/    drizzle .sql → OPENSHIP_MIGRATIONS_DIR
 *   engine/        iRedMail engine tree → MAIL_SERVER_ENGINE_DIR (mail-server install source)
 *   lua/           OpenResty scripts read by openresty-lua.ts relative to its own bundled path
 *
 * Runs (under bun) after tsup, since tsup's `clean` wipes dist first. This only
 * runs at build/publish time in the monorepo; the published package ships the
 * pre-built dist/server, so the user never needs apps/api present.
 */
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = join(CLI_DIR, "..", "..");
const API_ENTRY = join(REPO_ROOT, "apps/api/src/index.ts");
const OUT = join(CLI_DIR, "dist/server");

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const result = await Bun.build({
  entrypoints: [API_ENTRY],
  target: "node",
  outdir: OUT,
  naming: "index.js",
  // ssh2 + dockerode MUST stay external and load from the installed package's
  // node_modules (they're runtime `dependencies` of the CLI). Bundling them
  // mangles ssh2's dynamic cipher/KEX `require()`s and dockerode's transport,
  // so a bundled build hangs at the SSH handshake / Docker socket-forward
  // (works under `bun dev` only because that loads them unbundled). cpu-features
  // is ssh2's optional native dep — external + optional, ssh2 falls back.
  external: ["cpu-features", "ssh2", "dockerode"],
});
if (!result.success) {
  console.error("[stage-server] API bundle failed:");
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const require = createRequire(join(REPO_ROOT, "packages/db/package.json"));
const pgliteDist = dirname(require.resolve("@electric-sql/pglite"));
const pgliteOut = join(OUT, "pglite");
mkdirSync(pgliteOut, { recursive: true });
for (const file of ["pglite.wasm", "pglite.data"]) {
  const src = join(pgliteDist, file);
  if (!existsSync(src)) {
    console.error(`[stage-server] missing pglite asset: ${src}`);
    process.exit(1);
  }
  cpSync(src, join(pgliteOut, file));
}

cpSync(join(REPO_ROOT, "packages/db/drizzle"), join(OUT, "migrations"), { recursive: true });

// iRedMail engine → dist/server/engine. mail.service.ts packs this tree and
// streams it to the target VPS during mail-server setup; its default path
// resolves relative to apps/api's cwd (monorepo dev), which the bundled CLI
// doesn't have, so up.ts pins MAIL_SERVER_ENGINE_DIR at this staged copy.
const engineSrc = join(REPO_ROOT, "apps/email/engine");
if (!existsSync(join(engineSrc, "iRedMail.sh"))) {
  console.error(`[stage-server] iRedMail engine missing or incomplete: ${join(engineSrc, "iRedMail.sh")}`);
  process.exit(1);
}
cpSync(engineSrc, join(OUT, "engine"), {
  recursive: true,
  filter: (src) => !src.endsWith("/.DS_Store"),
});

// openresty-lua.ts resolves LUA_SRC_DIR relative to its own bundled module path
// (dist/server/index.js after bundling), i.e. it expects dist/server/lua/*.lua.
cpSync(join(REPO_ROOT, "packages/adapters/src/infra/lua"), join(OUT, "lua"), { recursive: true });

const mb = (statSync(join(OUT, "index.js")).size / 1024 / 1024).toFixed(1);
console.log(`[stage-server] staged API bundle → dist/server (${mb} MB) + pglite + migrations + engine + lua`);
