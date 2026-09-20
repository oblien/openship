/** Build-time assembly of the shared engine for an owned Node worker. */
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(packageDir, "../..");
const out = join(packageDir, "dist/native");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const result = await Bun.build({
  entrypoints: [join(packageDir, "src/native-worker.ts")],
  outdir: out, target: "node", naming: "engine-worker.mjs",
  // Runtime configuration belongs to the owning instance. Bun otherwise folds
  // NODE_ENV from the build process, including when a test builds the worker.
  env: "disable",
  define: { "process.env.NODE_ENV": "process.env.NODE_ENV" },
  external: ["cpu-features", "ssh2", "dockerode"],
});
if (!result.success) throw new AggregateError(result.logs, "Native engine build failed");
const require = createRequire(join(root, "packages/db/package.json"));
const pglite = dirname(require.resolve("@electric-sql/pglite"));
mkdirSync(join(out, "pglite"));
for (const name of ["pglite.wasm", "pglite.data"]) cpSync(join(pglite, name), join(out, "pglite", name));
cpSync(join(root, "packages/db/drizzle"), join(out, "migrations"), { recursive: true });
cpSync(join(root, "apps/email/engine"), join(out, "engine"), { recursive: true });
cpSync(join(root, "packages/adapters/src/infra/lua"), join(out, "lua"), { recursive: true });
cpSync(join(root, "apps/api/assets/geoip"), join(out, "assets/geoip"), { recursive: true });
console.log("[platform] built native Node worker and runtime assets");
