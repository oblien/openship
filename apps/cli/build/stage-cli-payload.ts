/**
 * Stage the self-contained, ARCH-INDEPENDENT CLI payload that `scripts/install.sh`
 * (and Windows `install.ps1`) download and run under Node — the distribution that
 * replaces `bun add -g openship`. See the plan in the repo: Node is the shipped
 * runtime, Bun is only the build tool.
 *
 * Produces .cli-payload/openship-cli-<tag>.tar.gz (+ .sha256), whose contents are:
 *   dist/            the tsup CLI bundle (index.js) + staged API (server/) — pure
 *                    JS/WASM, @repo/* inlined, ssh2/dockerode/cpu-features external
 *   node_modules/    the FULL prod closure (commander/chalk/ora/open/@clack +
 *                    ssh2/dockerode + transitive), installed with --omit=optional
 *                    so cpu-features (ssh2's only native dep) is dropped → ZERO
 *                    .node files → the tree runs unchanged on x64 AND arm64.
 *   package.json     workspace-stripped, "type":"module" — mirrors the published
 *                    npm layout so dist/index.js + dist/server/index.js resolve
 *                    their externals from node_modules by ESM parent-dir walk.
 *
 * Because the whole payload is arch-independent, CI builds it ONCE (no matrix);
 * only the Node binary itself is per-platform, and the installer fetches that
 * from nodejs.org only when the box lacks a usable system node.
 *
 * Runs (under bun) AFTER `tsup` + `build/stage-server.ts`, which produce dist/.
 * `npm install` and the load canary run under `node` (the shipped runtime).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(CLI_DIR, "dist");
const OUT = join(CLI_DIR, ".cli-payload");
const STAGE = join(OUT, "stage");

const pkg = JSON.parse(readFileSync(join(CLI_DIR, "package.json"), "utf8")) as {
  name: string;
  version: string;
  type?: string;
  bin?: Record<string, string>;
  dependencies?: Record<string, string>;
};

// The release job runs on a tag push, so GITHUB_REF_NAME is the version tag
// (e.g. v0.5.0); local builds fall back to v<version>. The asset name mirrors
// the dashboard bundle's `openship-dashboard-<tag>.tar.gz`.
const TAG = process.env.GITHUB_REF_NAME || `v${pkg.version}`;
const ASSET = `openship-cli-${TAG}.tar.gz`;

if (!existsSync(join(DIST, "index.js"))) {
  console.error(`[stage-cli-payload] ${join(DIST, "index.js")} missing — run \`tsup\` first.`);
  process.exit(1);
}
if (!existsSync(join(DIST, "server", "index.js"))) {
  console.error(
    `[stage-cli-payload] ${join(DIST, "server", "index.js")} missing — run \`build/stage-server.ts\` first.`,
  );
  process.exit(1);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

// 1. dist/ verbatim (CLI bundle + staged server/pglite/migrations/engine/lua).
cpSync(DIST, join(STAGE, "dist"), { recursive: true });

// 2. Workspace-stripped package.json. The @repo/* packages are bundled INTO
//    dist by tsup (noExternal), so a `workspace:*` specifier here would be
//    uninstallable off the monorepo — the exact strip the publish-npm job does.
const deps: Record<string, string> = {};
const stripped: string[] = [];
for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
  if (String(spec).startsWith("workspace:")) stripped.push(name);
  else deps[name] = spec;
}
writeFileSync(
  join(STAGE, "package.json"),
  `${JSON.stringify(
    { name: pkg.name, version: pkg.version, private: true, type: "module", bin: pkg.bin, dependencies: deps },
    null,
    2,
  )}\n`,
);
console.log(`[stage-cli-payload] stripped workspace deps: ${stripped.join(", ") || "(none)"}`);

// 3. Install the FULL prod closure into the stage. `--omit=optional` drops
//    ssh2's only native dep (cpu-features → node-gyp, host-arch, no prebuild),
//    yielding a zero-`.node`, arch-independent tree; ssh2 falls back to pure-JS
//    crypto. `--omit=dev` skips devDependencies (none listed here, but explicit).
console.log("[stage-cli-payload] npm install (prod closure, --omit=optional) …");
execFileSync(
  "npm",
  [
    "install",
    "--prefix",
    STAGE,
    "--omit=dev",
    "--omit=optional",
    "--no-audit",
    "--no-fund",
    "--no-package-lock",
  ],
  { cwd: STAGE, stdio: "inherit" },
);

// 4. CANARY: every externalized runtime dep must LOAD under Node using the EXACT
//    ESM parent-dir walk the installed CLI performs — ESM import ignores
//    NODE_PATH. A dropped transitive dep or wrong placement FAILS THE BUILD here
//    instead of shipping a CLI that dies at startup. Broader than the desktop's
//    ssh2/dockerode probe because the CLI externalizes commander/chalk/ora/open/
//    @clack too (only @repo/* is bundled).
console.log("[stage-cli-payload] verifying the payload loads under node …");
const probe = join(STAGE, "__cli-payload-probe.mjs");
writeFileSync(
  probe,
  [
    "import { Client } from 'ssh2';",
    "import Dockerode from 'dockerode';",
    "import { Command } from 'commander';",
    "import chalk from 'chalk';",
    "import ora from 'ora';",
    "import openDefault from 'open';",
    "import * as clack from '@clack/prompts';",
    "if (typeof Client !== 'function') { console.error('NO_SSH2'); process.exit(1); }",
    "if (typeof Dockerode !== 'function') { console.error('NO_DOCKERODE'); process.exit(1); }",
    "if (typeof Command !== 'function') { console.error('NO_COMMANDER'); process.exit(1); }",
    "if (typeof chalk?.green !== 'function') { console.error('NO_CHALK'); process.exit(1); }",
    "if (typeof ora !== 'function') { console.error('NO_ORA'); process.exit(1); }",
    "if (typeof openDefault !== 'function') { console.error('NO_OPEN'); process.exit(1); }",
    "if (typeof clack?.intro !== 'function') { console.error('NO_CLACK'); process.exit(1); }",
    "console.log('PAYLOAD_OK');",
  ].join("\n"),
);
try {
  const out = execFileSync("node", [probe], { encoding: "utf8" });
  if (!out.includes("PAYLOAD_OK")) throw new Error(`canary did not confirm load (got: ${out.trim()})`);
} catch (err) {
  console.error(
    "[stage-cli-payload] load canary FAILED — the payload won't launch under Node. " +
      `Check the prod closure installed completely. Underlying: ${(err as Error).message}`,
  );
  process.exit(1);
} finally {
  rmSync(probe, { force: true });
}

// The built entry itself must run under node from the staged layout (all
// externals resolve by parent-walk, no ambient repo node_modules).
const ver = execFileSync("node", [join(STAGE, "dist", "index.js"), "--version"], { encoding: "utf8" }).trim();
if (!/^\d+\.\d+\.\d+/.test(ver)) {
  console.error(`[stage-cli-payload] \`node dist/index.js --version\` did not print a version (got: ${ver}).`);
  process.exit(1);
}
console.log(`[stage-cli-payload] payload loads ✓  (dist/index.js --version → ${ver})`);

// 5. Tarball + sha256 sidecar (`<hash>  <name>`, matching sha256sum so the CLI's
//    parseSha256 reads it). Hashing streams the file — the closure is tens of MB.
const tarball = join(OUT, ASSET);
execFileSync("tar", ["-czf", tarball, "-C", STAGE, "."], { stdio: "inherit" });

const hash = createHash("sha256");
for await (const chunk of createReadStream(tarball)) hash.update(chunk as Buffer);
const digest = hash.digest("hex");
writeFileSync(`${tarball}.sha256`, `${digest}  ${basename(tarball)}\n`);

const mb = (statSync(tarball).size / 1024 / 1024).toFixed(1);
console.log(`[stage-cli-payload] staged ${ASSET} (${mb} MB) + .sha256 → ${OUT}`);
