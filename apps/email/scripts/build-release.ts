#!/usr/bin/env bun
/**
 * Build a single, self-contained `apps/email/dist/` that ships the webmail
 * (Zero) - both client and server - ready to run with two commands:
 *
 *     cd apps/email/dist
 *     bun install         # one-time, installs server runtime deps
 *     bun start           # binds the server, serves /client as the SPA
 *
 * Why this exists:
 *
 * The deploy pipeline currently builds Zero on the target VPS, which is
 * slow (Vite SSR pass needs ~1.5 GB peak) and OOMs small VPSes. With a
 * pre-built release dist the deploy reduces to "clone → install →
 * start" - no toolchain, no Vite, no source on the target.
 *
 * Output tree:
 *
 *   apps/email/dist/
 *     package.json            ← `install` + `start` scripts (this file
 *                                only - no node_modules at root)
 *     start.sh                ← `bun install && bun start` one-liner
 *     README.md               ← env vars + run instructions
 *     client/                 ← static SPA from `client build` (already
 *                                minified, hashed assets, index.html)
 *     server/
 *       package.json          ← server runtime deps only
 *       tsconfig.json
 *       src/                  ← server source, ran via bun
 *
 * The script intentionally does NOT ship node_modules - that's the
 * caller's job after extraction (`bun install`). Keeps the release
 * tarball small enough to fetch quickly on tiny VPSes.
 */

import { spawn } from 'node:child_process';
import { cp, mkdir, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT_DIR = join(ROOT, 'client');
const SERVER_DIR = join(ROOT, 'server');
const CLIENT_BUILD = join(CLIENT_DIR, 'build', 'client');

/**
 * Output directory. Defaults to `apps/email/dist/` for the manual CLI run,
 * but the deploy orchestrator passes a per-deploy temp path via `DIST_DIR`
 * so concurrent deploys don't clobber each other.
 */
const DIST = process.env.DIST_DIR ? resolve(process.env.DIST_DIR) : join(ROOT, 'dist');

function log(msg: string) {
  console.log(`[release] ${msg}`);
}

function run(cmd: string, cwd: string, env?: Record<string, string>): Promise<void> {
  return new Promise((res, rej) => {
    const child = spawn(cmd, {
      cwd,
      shell: true,
      stdio: 'inherit',
      env: env ? { ...process.env, ...env } : process.env,
    });
    child.on('exit', (code) =>
      code === 0 ? res() : rej(new Error(`${cmd} (cwd=${cwd}) exited ${code}`)),
    );
  });
}

async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  log(label);
  const out = await fn();
  log(`  ✓ ${(performance.now() - t0).toFixed(0)}ms`);
  return out;
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf-8'));
}

/**
 * Cloudflare's own build artifact. `wrangler.json` is the fully-resolved
 * form of client/wrangler.jsonc that the Vite plugin emits for
 * `wrangler deploy` - the Hono server never reads it, and the two things
 * it does carry are actively unwanted in a published image: the dev
 * `VITE_PUBLIC_*` origins, and the absolute path of whoever ran the build
 * (`"configPath": "/Users/<name>/..."`).
 */
const CLIENT_BUILD_EXCLUDE = new Set(['wrangler.json']);

/**
 * A dev origin must never reach the shipped client.
 *
 * GH-567: the route guards built their redirects by interpolating
 * `import.meta.env.VITE_PUBLIC_APP_URL`, so whatever the BUILD host defined
 * got frozen into the bundle - `http://localhost:3000` in the published
 * image, the literal string `undefined` in a local build. Either way, a
 * session-expiry redirect threw the user off their own domain. The fix was
 * relative redirects (react-router resolves those against the live origin,
 * basename included); this scan is what keeps it fixed. A bundle that can
 * only be correct on ONE hostname must not be publishable.
 *
 * Two patterns, because the bug has two faces:
 *
 *   localhost:<port> / 127.0.0.1:<port> / 0.0.0.0:<port>
 *     An origin baked in from a dev env. Port-qualified DELIBERATELY:
 *     react-router (URL parse base), posthog, linkify and punycode each
 *     ship a bare portless "localhost" of their own and none is a bug, so
 *     matching plain `localhost` would only teach us to ignore this check.
 *
 *   "undefined/<path>
 *     The same interpolation with the env absent. Anchored to the start of
 *     a string literal so vendor code like `.replace(/undefined/g, '')`
 *     can't trip it.
 */
const DEV_ORIGIN_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'dev origin', re: /(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+/g },
  { name: 'unset-env interpolation', re: /["'`]undefined\/[A-Za-z0-9/_-]*/g },
];

/**
 * Every text file is scanned - decided by a NUL sniff, not by an extension
 * allowlist. Vite emits two EXTENSIONLESS artifacts here (`_headers` and
 * `.assetsignore`, both `extname() === ''`), so an allowlist silently skips
 * them, and `.svg` with it. Sourcemaps are equally in scope: vite.config.ts
 * sets `build.sourcemap: false` today, but a map embeds the ORIGINAL source
 * text, so enabling it would ship the pre-minified literals.
 */
function isProbablyText(buf: Buffer): boolean {
  return !buf.subarray(0, 8192).includes(0);
}

async function scanForDevOrigins(dir: string): Promise<string[]> {
  const violations: string[] = [];

  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      const buf = await readFile(path);
      if (!isProbablyText(buf)) continue;
      const source = buf.toString('utf-8');
      for (const { name, re } of DEV_ORIGIN_PATTERNS) {
        for (const hit of source.match(re) ?? []) {
          violations.push(`${relative(dir, path)}: ${name} ${JSON.stringify(hit)}`);
        }
      }
    }
  }

  await walk(dir);
  return violations;
}

async function writeJson(path: string, data: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(data, null, 2) + '\n');
}

/**
 * The server's `package.json` is workspace-coupled in dev (catalog refs,
 * postinstall reaching back to the monorepo). For the release we want a
 * stand-alone shape: name/version/type/scripts + plain semver-resolved
 * dependencies, no workspace-protocol entries.
 *
 * `resolve-catalog-refs.ts` already runs as part of the dev install
 * pipeline and produces semver pins from the catalog. Re-running it
 * here means the dist's package.json is always semver-only - no
 * `catalog:` strings that would break a fresh `bun install`.
 */
async function buildServerPackageJson(): Promise<Record<string, unknown>> {
  const source = await readJson(join(SERVER_DIR, 'package.json'));
  const out: Record<string, unknown> = {
    name: '@zero/server',
    version: source.version ?? '0.0.0',
    private: true,
    type: 'module',
    scripts: {
      start: 'bun run src/main.ts',
    },
    dependencies: source.dependencies ?? {},
  };
  // Strip workspace-protocol values if any leaked through.
  const deps = out.dependencies as Record<string, string>;
  for (const [k, v] of Object.entries(deps)) {
    if (typeof v === 'string' && v.startsWith('workspace:')) {
      throw new Error(
        `Server package.json still has workspace-protocol dep "${k}": "${v}". ` +
          `Run \`bun run resolve-catalogs\` in apps/email before building the release.`,
      );
    }
  }
  return out;
}

const ROOT_PACKAGE_JSON = {
  name: '@zero/dist',
  version: '0.0.0',
  private: true,
  description:
    'Self-contained Zero webmail release. Run `bun install && bun start`.',
  type: 'module',
  scripts: {
    /**
     * One-shot install - pulls server runtime deps. Client is already
     * built; no install needed for static files. Production-only deps
     * keep the install lean.
     */
    install: 'cd server && bun install --production',
    /**
     * Boot. CLIENT_BUILD_DIR points the server at the bundled SPA. All
     * other env (port, COOKIE_DOMAIN, IMAP/SMTP defaults, BETTER_AUTH_SECRET,
     * BRANDING_PATH, SQLITE_PATH) is read from the process env - see
     * README.md in this dist for the full list.
     */
    start: 'CLIENT_BUILD_DIR="$PWD/client" bun run server/src/main.ts',
  },
};

const README = `# Zero webmail - release dist

Self-contained build. Bring your own \`bun\` (>= 1.1) and the env vars
listed below.

## Run

\`\`\`bash
bun install            # one-time, fetches server runtime deps
bun start              # boots the server, serves the SPA
\`\`\`

The server listens on \`PORT\` (default 4080). Put openresty / nginx in
front to terminate TLS and route public traffic to it.

## Required runtime environment

| Variable                | Purpose                                            |
| ----------------------- | -------------------------------------------------- |
| \`BETTER_AUTH_SECRET\`    | Cookie encryption key (long random string)         |
| \`COOKIE_DOMAIN\`         | Cookie domain (or omit for host-only)              |

> The client reads its backend URL from \`window.location.origin\` at
> runtime - no build-time URL baking, no env required. One dist
> deploys to any hostname unchanged.

## Optional environment

| Variable             | Default                  | Purpose                       |
| -------------------- | ------------------------ | ----------------------------- |
| \`PORT\`               | \`4080\`                   | HTTP listen port              |
| \`DEFAULT_IMAP_HOST\`  | \`mail.<email-domain>\`    | Pinned IMAP host              |
| \`DEFAULT_IMAP_PORT\`  | \`993\`                    |                               |
| \`DEFAULT_SMTP_HOST\`  | \`mail.<email-domain>\`    | Pinned SMTP host              |
| \`DEFAULT_SMTP_PORT\`  | \`587\`                    |                               |
| \`MINIMAX_API_KEY\`    | unset                    | Enables AI email generation   |
| \`MINIMAX_MODEL\`      | \`MiniMax-M3\`             | Chat model                    |
| \`MINIMAX_BASE_URL\`   | \`https://api.minimax.io/v1\` | Global or CN API endpoint  |
| \`BRANDING_PATH\`      | \`./data/branding\`        | Where branding lives on disk  |
| \`SQLITE_PATH\`        | \`./data/zero.db\`         | Session DB                    |
| \`IMAP_DEBUG\`         | unset                    | Verbose IMAP per-op timings   |

Set \`MINIMAX_BASE_URL\` to \`https://api.minimaxi.com/v1\` for the CN endpoint.

## What's in the dist

- \`client/\` - pre-built SPA static assets (no build step on this server)
- \`server/\` - server source (bun runs TS directly, no transpile)
- \`package.json\` - \`install\` + \`start\`
`;

const START_SH = `#!/usr/bin/env bash
# Convenience wrapper - fetches deps if missing, then boots.
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -d server/node_modules ]; then
  echo "[zero] first run - installing server dependencies..."
  bun install
fi
exec bun start
`;

async function main() {
  log(`root = ${ROOT}`);
  if (!existsSync(CLIENT_DIR) || !existsSync(SERVER_DIR)) {
    throw new Error('Missing apps/email/client or apps/email/server');
  }

  // No build-time env required - the client reads its backend URL from
  // `window.location.origin` at runtime (Zero is always served
  // same-origin by the bundled Hono server). One dist deploys to any
  // hostname unchanged. See client/lib/backend-url.ts.

  await step('cleaning previous dist/', async () => {
    await rm(DIST, { recursive: true, force: true });
    await mkdir(DIST, { recursive: true });
  });

  // 1. Resolve workspace catalog refs so the dist's package.json has
  //    plain semver. Idempotent; safe to re-run.
  await step('resolving workspace catalog refs', async () => {
    await run('bun run scripts/resolve-catalog-refs.ts', ROOT);
  });

  // 2. Build the client SPA. Vite output goes to client/build/client/.
  //
  // NODE_ENV=production is scoped to THIS command, and it is load-bearing.
  // `react-router build` runs under `#!/usr/bin/env node`, and in the
  // oven/bun base image `node` IS bun (/usr/local/bun-node-fallback-bin/node
  // -> /usr/local/bin/bun, on PATH). Bun auto-loads `.env.development` into
  // process.env whenever NODE_ENV is unset - which Dockerfile.webmail's
  // builder stage does deliberately, to keep the client's devDependencies -
  // and Vite then hoists every VITE_-prefixed process.env key into
  // import.meta.env and freezes it into the bundle. That is how GH-567 put
  // `http://localhost:3000` in the published image while a laptop build (real
  // node, no dotenv autoload) produced the string `undefined` from the same
  // commit: the shared script was never the divergence, the JS runtime
  // executing the shebang was.
  //
  // Pinning it here makes the image and the release tarball genuinely the
  // same bits - the claim Dockerfile.webmail already makes - and keeps the
  // scan below free of any vendor allowlist. It is NOT set process-wide: bun
  // reads NODE_ENV=production as an implicit `--production`, which would
  // strip devDependencies from the installs in the later steps.
  await step('building client SPA', async () => {
    await run('bun run build', CLIENT_DIR, { NODE_ENV: 'production' });
  });

  if (!existsSync(CLIENT_BUILD)) {
    throw new Error(
      `Client build missing - expected ${CLIENT_BUILD}. Check client/react-router.config.ts.`,
    );
  }

  // 3. Copy the built client into dist/client/. fs.cp recursive is
  //    portable; no shell-out cross-platform concerns.
  await step('copying client/ to dist/client/', async () => {
    await cp(CLIENT_BUILD, join(DIST, 'client'), {
      recursive: true,
      filter: (src) => !CLIENT_BUILD_EXCLUDE.has(relative(CLIENT_BUILD, src)),
    });
  });

  // 3b. Refuse to publish a client that only works on one hostname. Scans
  //     what actually ships (post-copy), so it covers the image and the
  //     release tarball alike - both come through this script. See
  //     DEV_ORIGIN_PATTERNS above for why this is worth a hard failure.
  await step('scanning client/ for baked dev origins', async () => {
    const violations = await scanForDevOrigins(join(DIST, 'client'));
    if (violations.length > 0) {
      throw new Error(
        `Client bundle has ${violations.length} baked dev-origin literal(s) - it would ` +
          `redirect users off their own hostname (GH-567). Build same-origin: use a ` +
          `relative \`replace('/path')\` / \`redirect('/path')\` from react-router, or ` +
          `client/lib/backend-url.ts.\n` +
          violations.map((v) => `  - ${v}`).join('\n'),
      );
    }
  });

  // 4. Copy the server source into dist/server/. Bun runs TS directly,
  //    so no transpile step - the .ts files ARE the runtime artifacts.
  await step('copying server source to dist/server/', async () => {
    const target = join(DIST, 'server');
    await mkdir(target, { recursive: true });
    await cp(join(SERVER_DIR, 'src'), join(target, 'src'), { recursive: true });
    await cp(join(SERVER_DIR, 'tsconfig.json'), join(target, 'tsconfig.json'));
  });

  // 5. Synthesize the server's release package.json (no workspace refs,
  //    no dev deps, just runtime semver pins + a `start` script).
  await step('writing dist/server/package.json', async () => {
    const pkg = await buildServerPackageJson();
    await writeJson(join(DIST, 'server', 'package.json'), pkg);
  });

  // 5b. Generate a standalone lockfile for the release. Without this,
  //     `bun install --production` on the target resolves fresh from the
  //     registry on every deploy - semver ranges drift, peer-dep contracts
  //     break, and the container crashes with "Cannot find module ..." for
  //     a sub-dep the dev workspace happened to resolve differently.
  //
  //     `bun install` writes `bun.lock` next to the package.json with
  //     EXACT versions pinned. The lockfile ships with the dist; the
  //     target's install reads it and reproduces the same graph we
  //     dev'd against.
  //
  //     We delete `node_modules` afterwards: shipping it would bloat the
  //     dist by ~130 MB. The target re-installs from the lockfile in ~30s
  //     and gets identical bits.
  await step('generating dist/server/bun.lock (standalone, no workspace refs)', async () => {
    await run('bun install', join(DIST, 'server'));
  });
  await step('removing dist/server/node_modules (deps install on deploy from lockfile)', async () => {
    await rm(join(DIST, 'server', 'node_modules'), { recursive: true, force: true });
  });

  // 6. Top-level dist orchestration files.
  await step('writing dist/package.json + start.sh + README.md', async () => {
    await writeJson(join(DIST, 'package.json'), ROOT_PACKAGE_JSON);
    await writeFile(join(DIST, 'start.sh'), START_SH, { mode: 0o755 });
    await writeFile(join(DIST, 'README.md'), README);
  });

  log('');
  log(`release dist is at: ${DIST}`);
  log('');
  log('  cd apps/email/dist');
  log('  bun install   # one-time');
  log('  bun start');
}

main().catch((err) => {
  console.error('[release] FAILED:', err);
  process.exit(1);
});
