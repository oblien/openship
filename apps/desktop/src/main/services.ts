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
import { createServer } from "node:net";
import { join } from "node:path";
import { LOCAL_API_URL, LOCAL_DASHBOARD_URL } from "@repo/core";

const API_BIN = process.platform === "win32" ? "openship-api.exe" : "openship-api";

type DashProc = ReturnType<typeof utilityProcess.fork> | ChildProcess;

let apiProc: ChildProcess | null = null;
let dashboardProc: DashProc | null = null;
let started = false;

// Resolved local origins. Default to the fixed dev ports (used unpackaged /
// before services start); overwritten with the dynamic ports actually bound.
let localApiUrl = LOCAL_API_URL;
let localDashboardUrl = LOCAL_DASHBOARD_URL;

/** The API origin the app is actually using (dynamic once packaged). */
export const getLocalApiUrl = (): string => localApiUrl;
/** The dashboard origin the app is actually using (dynamic once packaged). */
export const getLocalDashboardUrl = (): string => localDashboardUrl;

/** Reserve a free TCP port on loopback (bind :0, read it, release). */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = addr && typeof addr === "object" ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

/** True if a specific TCP port is bindable on loopback right now. */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

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
    apiBin: join(root, "bin", API_BIN),
    migrationsDir: join(root, "migrations"),
    pgliteDir: join(root, "pglite"),
    dashboardDir: join(root, "dashboard", "apps", "dashboard"),
    // ssh2 + dockerode live here (externalized from the compiled API binary);
    // the binary resolves them via NODE_PATH — see the spawn below.
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
): Promise<DashProc | null> {
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
 * Start the bundled API + dashboard and resolve once both answer. Idempotent.
 * @param internalToken shared secret for Electron → API internal calls
 */
export async function startLocalServices(internalToken: string): Promise<void> {
  if (started) return;
  started = true;

  const { apiBin, migrationsDir, pgliteDir, dashboardDir, nodeModulesDir } = resourcePaths();
  const userData = app.getPath("userData");
  const dataDir = join(userData, "data");
  mkdirSync(dataDir, { recursive: true });

  if (!existsSync(apiBin)) {
    throw new Error(`Bundled API binary missing at ${apiBin}`);
  }

  const authSecret = loadOrCreateAuthSecret();

  // Retry a few times: the pick→bind window is tiny, but if a chosen port
  // races away (another process grabs it first) the child exits early and we
  // just try fresh ports.
  const MAX_ATTEMPTS = 3;
  const stored = loadStoredPorts();
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Attempt 1 reuses last run's ports when they're still free (stable origin
    // → session survives restarts); otherwise pick fresh free ports.
    const apiPort =
      attempt === 1 && stored.api && (await isPortFree(stored.api))
        ? stored.api
        : await getFreePort();
    let dashPort =
      attempt === 1 &&
      stored.dashboard &&
      stored.dashboard !== apiPort &&
      (await isPortFree(stored.dashboard))
        ? stored.dashboard
        : await getFreePort();
    if (dashPort === apiPort) dashPort = await getFreePort();

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
      // The compiled API binary loads ssh2/dockerode (externalized from the
      // --compile bundle) from the staged Resources/node_modules via NODE_PATH.
      // This ONLY works on Bun < 1.3.4: Bun 1.3.4 regressed `--compile --external`
      // resolution to the virtual $bunfs root, ignoring NODE_PATH/CWD (oven-sh/bun
      // #25500), which broke desktop startup with "Cannot find package 'ssh2'"
      // (issue #111). The build pins a pre-1.3.4 Bun (.bun-version) + a stage.ts
      // canary — do NOT bump Bun past that until #25500 is fixed upstream.
      NODE_PATH: nodeModulesDir,
    });

    let apiDead = false;

    apiProc = spawn(apiBin, [], {
      cwd: userData, // writable, and free of any repo .env
      env: apiEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    apiProc.on("exit", (code, signal) => {
      apiDead = true;
      console.log(`[openship] api exited (code=${code ?? "null"} signal=${signal ?? "none"})`);
    });
    pipeLogs("api", apiProc);

    // API + dashboard start in parallel. startDashboard handles its own
    // readiness + utilityProcess→spawn fallback, resolving the live process.
    const [apiReady, dashProc] = await Promise.all([
      waitForPort(`http://127.0.0.1:${apiPort}/api/health`, () => apiDead),
      startDashboard(dashboardDir, dashPort, apiOrigin),
    ]);
    dashboardProc = dashProc;

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
  // API: SIGTERM then SIGKILL fallback.
  if (apiProc && apiProc.exitCode === null) {
    const p = apiProc;
    p.kill("SIGTERM");
    setTimeout(() => {
      if (p.exitCode === null) {
        try {
          p.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
    }, 4000).unref?.();
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

  if (p && p.exitCode === null) {
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

      p.once("exit", done);
      try {
        p.kill("SIGTERM");
      } catch {
        done(); // already gone
        return;
      }
      killTimer = setTimeout(() => {
        if (p.exitCode === null) {
          try {
            p.kill("SIGKILL");
          } catch {
            // already gone
          }
        }
      }, graceMs);
      // Backstop: resolve even if the 'exit' event is somehow missed after kill.
      capTimer = setTimeout(done, graceMs + 3000);
    });
  }

  apiProc = null;
}
