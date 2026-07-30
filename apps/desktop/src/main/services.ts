/**
 * Local service supervisor for the PACKAGED desktop app.
 *
 * A shipped installer has no dev servers behind it, so the app boots its own:
 *   - API:       the bundled `openship-api` binary (bun --compile). Embedded
 *                PGlite (no external Postgres), in-process job runner (no Redis).
 *   - Dashboard: the bundled Next standalone server, run with Electron's own
 *                Node (ELECTRON_RUN_AS_NODE) — no separate Node install needed.
 *
 * Both bind DYNAMIC free ports chosen at launch (never fixed 4000/3001), so a
 * busy port never bricks the app. Electron is the single source of truth for
 * the chosen ports: it tells the API which dashboard origin to trust and tells
 * the dashboard where the API is. In dev (app.isPackaged === false) this module
 * is never called — servers run via `bun dev` on the fixed ports.
 */

import { app, net, utilityProcess } from "electron";
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LOCAL_API_URL, LOCAL_DASHBOARD_URL } from "@repo/core";
import { resolvePortPair } from "@repo/core/ports";

// The API + dashboard both run under Electron's OWN Node (utilityProcess.fork —
// no Dock tile), NOT a bun binary. `NodeService` is either that utility process
// or the ELECTRON_RUN_AS_NODE spawn fallback.
type NodeService = ReturnType<typeof utilityProcess.fork> | ChildProcess;

let apiProc: NodeService | null = null;
let dashboardProc: NodeService | null = null;
let started = false;
// Liveness for the API. A utilityProcess (the normal path) exposes no
// `exitCode`, so we track exit ourselves — startApi sets this on the process's
// exit event, and teardown reads it instead of a per-type property.
let apiExited = false;

/**
 * Terminate a service, whichever kind it is. A ChildProcess takes a signal
 * (SIGTERM graceful, SIGKILL forced); Electron's utilityProcess exposes only a
 * signal-less kill() (SIGTERM-equivalent, and Electron hard-kills it on app
 * quit regardless). Swallows "already gone".
 */
function killService(p: NodeService, signal?: NodeJS.Signals): void {
  try {
    if ("postMessage" in p) (p as ReturnType<typeof utilityProcess.fork>).kill();
    else (p as ChildProcess).kill(signal);
  } catch {
    // already gone
  }
}

// Resolved local origins. Default to the fixed dev ports (used unpackaged /
// before services start); overwritten with the dynamic ports actually bound.
let localApiUrl = LOCAL_API_URL;
let localDashboardUrl = LOCAL_DASHBOARD_URL;

/** The API origin the app is actually using (dynamic once packaged). */
export const getLocalApiUrl = (): string => localApiUrl;
/** The dashboard origin the app is actually using (dynamic once packaged). */
export const getLocalDashboardUrl = (): string => localDashboardUrl;

/**
 * Persist the chosen ports so a restart reuses the SAME origin. Session cookies
 * are bound to `localhost:<port>`, so a stable port is what keeps the user
 * logged in across restarts; we only pick a different port if the stored one
 * is taken.
 */
function portsFile(): string {
  return join(app.getPath("userData"), "ports.json");
}
function loadStoredPorts(): { api?: number; dashboard?: number } {
  try {
    return JSON.parse(readFileSync(portsFile(), "utf-8")) as {
      api?: number;
      dashboard?: number;
    };
  } catch {
    return {};
  }
}
function saveStoredPorts(api: number, dashboard: number): void {
  try {
    writeFileSync(portsFile(), JSON.stringify({ api, dashboard }));
  } catch {
    // best-effort
  }
}

/** Bundled payload lives under Resources/ (see forge.config.js extraResource). */
function resourcePaths() {
  const root = process.resourcesPath;
  return {
    // The API bundle (Bun.build target:node) — run under Electron's Node, not a
    // bun binary. Its sibling package.json marks it type:module so index.js loads
    // as ESM. See apps/desktop/build/stage.ts for why it's a Node bundle.
    apiEntry: join(root, "server", "index.js"),
    migrationsDir: join(root, "migrations"),
    pgliteDir: join(root, "pglite"),
    // Vendored GeoLite2-Country DB. geo-ip.ts otherwise probes paths relative to
    // its own module (inside the bundle, resources/server) — every candidate
    // misses and it silently downloads 8.8 MB from GitHub on the first
    // server-flag lookup (and shows no flags at all offline).
    geoipDb: join(root, "geoip", "GeoLite2-Country.mmdb"),
    // The iRedMail engine tree the mail-server install packs and streams to the
    // target VPS. Handed to the API as MAIL_SERVER_ENGINE_DIR below — its own
    // default resolves relative to apps/api's cwd, which is WRONG here (the API
    // runs with cwd=userData), producing "tar: could not chdir to
    // '…/Library/apps/email/engine'".
    engineDir: join(root, "engine"),
    dashboardDir: join(root, "dashboard", "apps", "dashboard"),
    // ssh2 + dockerode live here (external to the API bundle); the API resolves
    // them via NODE_PATH — see startApi below.
    nodeModulesDir: join(root, "node_modules"),
  };
}

/**
 * BETTER_AUTH_SECRET must be stable across launches (else every restart
 * invalidates sessions). Generate once, persist in userData.
 */
function loadOrCreateAuthSecret(): string {
  const file = join(app.getPath("userData"), "auth-secret");
  try {
    const existing = readFileSync(file, "utf-8").trim();
    if (existing) return existing;
  } catch {
    // not created yet
  }
  const secret = randomBytes(32).toString("base64url");
  writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

/** Prefix + forward a child's stdio to the main process console. */
function pipeLogs(
  name: string,
  proc: { stdout: NodeJS.ReadableStream | null; stderr: NodeJS.ReadableStream | null },
): void {
  proc.stdout?.on("data", (b: Buffer) => process.stdout.write(`[${name}] ${b}`));
  proc.stderr?.on("data", (b: Buffer) => process.stderr.write(`[${name}] ${b}`));
}

/** Poll a URL until it answers (any HTTP response), or the child dies / times out. */
async function waitForPort(
  url: string,
  isDead: () => boolean,
  maxAttempts = 60,
  intervalMs = 1000,
): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    if (isDead()) return false; // crashed before ready
    try {
      const res = await net.fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.status > 0) return true;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/**
 * Start the dashboard Next server and resolve with the process once it answers,
 * or null if it never comes up.
 *
 * Preferred: `utilityProcess.fork` — a hidden Node child OWNED by the app, with
 * NO Dock tile. Fallback: re-spawn the Electron binary as Node
 * (ELECTRON_RUN_AS_NODE) — this WORKS but shows a stray "exec" Dock tile, so
 * it's only used if utilityProcess somehow fails to boot. Either way the app
 * always comes up.
 */
async function startDashboard(
  dashboardDir: string,
  dashPort: number,
  apiOrigin: string,
): Promise<NodeService | null> {
  const url = `http://127.0.0.1:${dashPort}/`;
  const serverJs = join(dashboardDir, "server.js");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    OPENSHIP_TARGET: "local",
    HOSTNAME: "127.0.0.1",
    PORT: String(dashPort),
    // Tell the dashboard (SSR + injected into the browser) where the API is.
    OPENSHIP_LOCAL_API_URL: apiOrigin,
  };

  // 1. Preferred — utilityProcess (no Dock tile, owned by the app).
  const up = utilityProcess.fork(serverJs, [], { cwd: dashboardDir, stdio: "pipe", env });
  let upDead = false;
  up.on("exit", (code) => {
    upDead = true;
    console.log(`[openship] dashboard(utility) exited (code=${code})`);
  });
  pipeLogs("dashboard", up);
  if (await waitForPort(url, () => upDead, 45)) return up;

  // 2. Fallback — ELECTRON_RUN_AS_NODE spawn (works, but tiles the Dock).
  try {
    up.kill();
  } catch {
    // already gone
  }
  console.log("[openship] dashboard utilityProcess did not start — falling back to node spawn");
  const sp = spawn(process.execPath, [serverJs], {
    cwd: dashboardDir,
    env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let spDead = false;
  sp.on("exit", (code, signal) => {
    spDead = true;
    console.log(`[openship] dashboard exited (code=${code ?? "null"} signal=${signal ?? "none"})`);
  });
  pipeLogs("dashboard", sp);
  if (await waitForPort(url, () => spDead, 60)) return sp;
  return null;
}

/**
 * Start the API bundle and resolve with the process once it answers /api/health,
 * or null if it never comes up. Same two-tier launch as the dashboard: prefer
 * utilityProcess.fork (Electron's Node, no Dock tile), fall back to an
 * ELECTRON_RUN_AS_NODE spawn.
 *
 * This is what fixes Docker-over-SSH on the desktop: the API runs under Node
 * (Electron's), exactly like `bun dev` (node --import tsx) and the self-hosted
 * `node dist/index.js`. The old `bun --compile` binary could not — see
 * apps/desktop/build/stage.ts for the full why (ssh2/dockerode + bun #25500).
 */
async function startApi(
  apiEntry: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  healthUrl: string,
): Promise<NodeService | null> {
  apiExited = false;
  // 1. Preferred — utilityProcess (Electron's Node, no Dock tile). The API runs
  //    migrations on boot, so give it a generous readiness window.
  const up = utilityProcess.fork(apiEntry, [], { cwd, stdio: "pipe", env });
  let upDead = false;
  up.on("exit", (code) => {
    upDead = true;
    apiExited = true;
    console.log(`[openship] api(utility) exited (code=${code})`);
  });
  pipeLogs("api", up);
  if (await waitForPort(healthUrl, () => upDead)) return up;

  // 2. Fallback — ELECTRON_RUN_AS_NODE spawn (works, but tiles the Dock).
  killService(up);
  console.log("[openship] api utilityProcess did not start — falling back to node spawn");
  apiExited = false;
  const sp = spawn(process.execPath, [apiEntry], {
    cwd,
    env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let spDead = false;
  sp.on("exit", (code, signal) => {
    spDead = true;
    apiExited = true;
    console.log(`[openship] api exited (code=${code ?? "null"} signal=${signal ?? "none"})`);
  });
  pipeLogs("api", sp);
  if (await waitForPort(healthUrl, () => spDead)) return sp;
  return null;
}

/**
 * Start the bundled API + dashboard and resolve once both answer. Idempotent.
 * @param internalToken shared secret for Electron → API internal calls
 */
export async function startLocalServices(internalToken: string): Promise<void> {
  if (started) return;
  started = true;

  const { apiEntry, migrationsDir, pgliteDir, geoipDb, engineDir, dashboardDir, nodeModulesDir } =
    resourcePaths();
  const userData = app.getPath("userData");
  const dataDir = join(userData, "data");
  mkdirSync(dataDir, { recursive: true });

  if (!existsSync(apiEntry)) {
    throw new Error(`Bundled API entry missing at ${apiEntry}`);
  }

  const authSecret = loadOrCreateAuthSecret();

  // Retry a few times: the pick→bind window is tiny, but if a chosen port
  // races away (another process grabs it first) the child exits early and we
  // just try fresh ports.
  const MAX_ATTEMPTS = 3;
  const stored = loadStoredPorts();
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Attempt 1 reuses last run's ports when it can (stable origin → the session
    // survives a restart); a retry means a chosen port raced away, so it asks for
    // fresh ones rather than the pair that just failed.
    //
    // `resolvePortPair` is the SAME resolver the CLI installs with (@repo/core/ports).
    // This used to be a local `isPortFree() ? stored : getFreePort()`, which had no
    // grace period: on a restart the app probes the remembered port while its own
    // dying process still holds it, so it moved to a brand-new port and — cookies
    // being bound to `localhost:<port>` — logged the user out on every restart.
    // The shared resolver waits briefly for our own process to release it first.
    //
    // NO `defaults` on purpose: a packaged app must never land on 4000/3001, where
    // a dev server lives. Without them the resolver hands out ephemeral ports,
    // which is what this launcher has always wanted.
    const { api: apiPort, dashboard: dashPort } = await resolvePortPair(
      attempt === 1 ? { stored } : {},
    );

    // Use 127.0.0.1, not localhost: the API/dashboard bind IPv4 loopback only
    // (OPENSHIP_API_HOST=127.0.0.1), and clients that resolve `localhost` → ::1
    // first (e.g. Bun's fetch) get connection-refused before OAuth starts (#119).
    const apiOrigin = `http://127.0.0.1:${apiPort}`;
    const dashOrigin = `http://127.0.0.1:${dashPort}`;

    // Clean env: strip anything that would steer the API onto an external
    // Postgres. Empty DATABASE_URL + no POSTGRES_* → embedded PGlite.
    const apiEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const k of [
      "DATABASE_URL",
      "POSTGRES_HOST",
      "POSTGRES_PORT",
      "POSTGRES_USER",
      "POSTGRES_PASSWORD",
      "POSTGRES_DB",
      "PGHOST",
      "PGPORT",
      "PGUSER",
      "PGPASSWORD",
      "PGDATABASE",
    ]) {
      delete apiEnv[k];
    }
    Object.assign(apiEnv, {
      DEPLOY_MODE: "desktop",
      // DECLARE the auth mode. The API no longer infers zero-auth from
      // DEPLOY_MODE, and it no longer lets a persisted instance_settings row
      // override this — a stale "cloud" row used to send this loopback-only app to
      // a remote sign-in screen with no way back. The API refuses to boot in
      // desktop mode without this, so it can never silently become a lockout.
      // Not a bypass: zeroAuthAllowed() still requires a loopback peer.
      OPENSHIP_AUTH_MODE: "none",
      OPENSHIP_TARGET: "local",
      OPENSHIP_JOB_RUNNER: "in-process", // no Redis in desktop; skip the probe
      NODE_ENV: "production",
      PORT: String(apiPort),
      // Bind the API to loopback ONLY. Desktop runs authMode=none (zero-auth),
      // so a 0.0.0.0 listener would let any host on the LAN reach the local
      // session-mint endpoints. Mirrors the CLI `up` path (OPENSHIP_API_HOST).
      OPENSHIP_API_HOST: "127.0.0.1",
      PGLITE_DATA_DIR: dataDir,
      OPENSHIP_MIGRATIONS_DIR: migrationsDir,
      OPENSHIP_PGLITE_ASSETS_DIR: pgliteDir,
      // Point geo-ip.ts straight at the staged mmdb. Only set when the file is
      // actually there, so a stale/partial Resources dir falls back to geo-ip's
      // own download path instead of pinning a bad override.
      ...(existsSync(geoipDb) ? { OPENSHIP_GEOIP_DB: geoipDb } : {}),
      // Pin the mail-server install source to the staged engine tree. Gated on
      // existsSync so a stale/partial Resources dir falls back to the resolver's
      // default rather than pinning a path that definitely isn't there.
      ...(existsSync(engineDir) ? { MAIL_SERVER_ENGINE_DIR: engineDir } : {}),
      // The dashboard + API run on dynamic ports not in the API's static origin
      // table — trust both loopback spellings of each explicitly so CORS /
      // origin-guard / auth accept them regardless of which a client resolves.
      OPENSHIP_EXTRA_TRUSTED_ORIGINS: [
        `http://127.0.0.1:${dashPort}`,
        `http://localhost:${dashPort}`,
        `http://127.0.0.1:${apiPort}`,
        `http://localhost:${apiPort}`,
      ].join(","),
      // Where the API redirects after desktop-login / desktop-claim / cloud auth
      // (else it'd send the window to the static localhost:3001 → white screen).
      OPENSHIP_LOCAL_DASHBOARD_URL: dashOrigin,
      // The origin external MCP/OAuth clients actually reach this API at. Feeds
      // the OAuth discovery/issuer/authorize/token URLs (resolveAuthBaseUrl) so
      // they're reachable on the dynamic port instead of the static localhost:4000
      // fallback (#119). URL-construction ONLY — it must NOT be OPENSHIP_PUBLIC_URL,
      // which would trip zeroAuthAllowed's "publicly-served" rejection and kill
      // the desktop's zero-auth session.
      OPENSHIP_ADVERTISED_ORIGIN: apiOrigin,
      BETTER_AUTH_SECRET: authSecret,
      INTERNAL_TOKEN: internalToken,
      // The API bundle keeps ssh2/dockerode EXTERNAL (bundling them mangles
      // ssh2's dynamic cipher/KEX require()s + dockerode's transport). The bundle
      // is ESM and lives at Resources/server/index.js, so `import "ssh2"` resolves
      // by the normal parent-dir node_modules walk → Resources/node_modules (its
      // parent). ESM import IGNORES NODE_PATH; it's set only as a belt-and-braces
      // fallback for any CJS `require()` deep in the SSH/Docker stack. Running
      // under Electron's Node (startApi) makes this plain Node resolution — the
      // same as `bun dev` and self-hosted `node dist/index.js`, where Docker
      // over SSH works.
      NODE_PATH: nodeModulesDir,
    });

    // API + dashboard start in parallel. Each handles its own readiness +
    // utilityProcess→spawn fallback and resolves the live process (or null).
    const [apiRes, dashProc] = await Promise.all([
      startApi(apiEntry, userData, apiEnv, `http://127.0.0.1:${apiPort}/api/health`),
      startDashboard(dashboardDir, dashPort, apiOrigin),
    ]);
    apiProc = apiRes;
    dashboardProc = dashProc;
    const apiReady = Boolean(apiRes);

    if (apiReady && dashProc) {
      localApiUrl = apiOrigin;
      localDashboardUrl = dashOrigin;
      saveStoredPorts(apiPort, dashPort); // reuse next launch → session persists
      console.log(`[openship] services ready — api=${apiOrigin} dashboard=${dashOrigin}`);
      return;
    }

    // A child failed to come up (port race / crash). Tear down and retry.
    stopLocalServices();
    if (attempt === MAX_ATTEMPTS) {
      throw new Error(
        `Local services failed to start after ${MAX_ATTEMPTS} attempts ` +
          `(api ready=${apiReady}, dashboard ready=${Boolean(dashProc)})`,
      );
    }
  }
}

/** Kill both children. Safe to call anytime / repeatedly. */
export function stopLocalServices(): void {
  // API: SIGTERM then a SIGKILL fallback. The SIGKILL escalation only applies to
  // the ChildProcess fallback — a utilityProcess exposes just kill(), and
  // Electron hard-kills it on app quit anyway.
  if (apiProc && !apiExited) {
    const p = apiProc;
    killService(p, "SIGTERM");
    if ("exitCode" in p) {
      const cp = p as ChildProcess;
      setTimeout(() => {
        if (cp.exitCode === null) killService(cp, "SIGKILL");
      }, 4000).unref?.();
    }
  }
  // Dashboard: .kill() terminates it — works for both a utilityProcess and a
  // ChildProcess (the fallback). Electron also tears a utilityProcess down with
  // the app; kill it eagerly regardless.
  if (dashboardProc) {
    try {
      dashboardProc.kill();
    } catch {
      // already gone
    }
  }
  apiProc = null;
  dashboardProc = null;
}

/**
 * Like stopLocalServices, but AWAITS the API's real exit before resolving.
 *
 * Used on the auto-update handoff. The API holds a single-instance lock on the
 * PGlite data dir; the freshly-installed version opens the SAME dir on launch.
 * If we quit + relaunch without waiting, the old API keeps draining (up to its
 * ~30s graceful window) as an orphan and still holds the lock, so the new
 * version fails to acquire it and can refuse to launch. Waiting here guarantees
 * the lock is released before the new version opens the DB.
 *
 * SIGTERM first (lets the API's own shutdown release the lock cleanly), then a
 * SIGKILL after `graceMs`, then a hard cap so an update never blocks forever.
 * Force-killing is data-safe: migrations are transactional (roll back if
 * interrupted) and the lock self-heals from a dead pid on the next boot.
 */
export async function stopLocalServicesAndWait(graceMs = 8000): Promise<void> {
  const p = apiProc;

  // Dashboard shares no data dir — kill it eagerly, nothing to wait on.
  if (dashboardProc) {
    try {
      dashboardProc.kill();
    } catch {
      // already gone
    }
  }
  dashboardProc = null;

  if (p && !apiExited) {
    await new Promise<void>((resolve) => {
      let settled = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let capTimer: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        if (settled) return;
        settled = true;
        if (killTimer) clearTimeout(killTimer);
        if (capTimer) clearTimeout(capTimer);
        resolve();
      };

      // Both a utilityProcess and a ChildProcess emit "exit"; their typed once()
      // overloads differ, so register via the shared EventEmitter shape.
      (p as unknown as NodeJS.EventEmitter).once("exit", done);
      killService(p, "SIGTERM"); // lets the API release the PGlite lock cleanly
      killTimer = setTimeout(() => {
        // SIGKILL escalation is ChildProcess-only; a utilityProcess has no
        // forced-kill, but the capTimer + app-quit teardown still bound the wait.
        if ("exitCode" in p && (p as ChildProcess).exitCode === null) {
          killService(p, "SIGKILL");
        }
      }, graceMs);
      // Backstop: resolve even if the 'exit' event is somehow missed after kill.
      capTimer = setTimeout(done, graceMs + 3000);
    });
  }

  apiProc = null;
}
