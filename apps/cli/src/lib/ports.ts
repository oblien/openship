/**
 * Dynamic port allocation for the CLI-run API + dashboard.
 *
 * There is NO permanent port: the defaults (API 4000, dashboard 3001) are only a
 * PREFERENCE. If a preferred port is already taken (a second instance, another
 * app, a leftover process), we switch to a free one — the same behaviour the
 * desktop app uses. Resolution happens BEFORE the env is injected / the service
 * unit is written, so the chosen ports are baked into the launchd/systemd args,
 * threaded to the edge-proxy target, and shown in the summary.
 *
 * Chosen ports are persisted to ~/.openship/ports.json so a restart REUSES the
 * same origin when it's still free — session cookies are bound to
 * `localhost:<port>`, so a stable port is what keeps you logged in across
 * restarts. We only move off a remembered port when it's actually occupied.
 */
import { createServer } from "node:net";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { OS_DIR } from "./paths";

const PORTS_FILE = join(OS_DIR, "ports.json");
const INSTANCE_FILE = join(OS_DIR, "instance.json");

// NOTE: stale PGlite-lock recovery is NOT the CLI's job. The API server reclaims
// a dead-owner lock itself on every boot (packages/db pglite-lock: dead-pid
// reclaim in acquirePgliteLock), so no CLI-side lock clearing is needed.

/** Remember the instance's canonical access URL (public domain, or localhost for
 *  a private box) so the control panel can show + open it without hitting the API. */
export function saveInstanceUrl(publicUrl: string | undefined | null): void {
  try {
    if (!existsSync(OS_DIR)) mkdirSync(OS_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(INSTANCE_FILE, JSON.stringify({ publicUrl: publicUrl ?? null }));
  } catch {
    // best-effort
  }
}

export function readInstanceUrl(): string | null {
  try {
    return (JSON.parse(readFileSync(INSTANCE_FILE, "utf8")) as { publicUrl?: string | null }).publicUrl ?? null;
  } catch {
    return null;
  }
}

const DEFAULT_API = 4000;
const DEFAULT_DASHBOARD = 3001;

/** True if a specific TCP port is bindable on loopback right now. */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

/**
 * Wait (bounded) for a specific port to become bindable. On a service restart
 * the supervisor stops the old process then starts the new one; the new process
 * often probes the remembered port BEFORE the old one has released it. Without
 * this wait, `resolvePorts` would immediately fall back to a random free port —
 * changing the origin, logging every user out (cookies are bound to
 * `localhost:<port>`), and stranding the edge upstream on the old port. Since a
 * restart's own dying process frees the port within a second or two, a short
 * wait reclaims the canonical port in the common case. A genuinely-held port
 * (another service) still times out and moves.
 */
export async function waitPortFree(
  port: number,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 6000;
  const intervalMs = opts.intervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await isPortFree(port)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Reserve a free TCP port on loopback (bind :0, read it, release). */
export function getFreePort(): Promise<number> {
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

interface StoredPorts {
  api?: number;
  dashboard?: number;
}

function loadStoredPorts(): StoredPorts {
  try {
    return JSON.parse(readFileSync(PORTS_FILE, "utf-8")) as StoredPorts;
  } catch {
    return {};
  }
}

function saveStoredPorts(api: number, dashboard: number): void {
  try {
    if (!existsSync(OS_DIR)) mkdirSync(OS_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(PORTS_FILE, JSON.stringify({ api, dashboard }));
  } catch {
    // best-effort — resolution still works without persistence.
  }
}

export interface ResolvedPorts {
  api: number;
  dashboard: number;
  /** Whether each port had to move off its preference (default/stored/flag). */
  switched: { api: boolean; dashboard: boolean };
}

/**
 * Resolve the API + dashboard ports, switching off any that are occupied.
 *
 * Preference order per port: explicit flag → last-used (ports.json) → default.
 * A preferred port that's free is kept (stable origin); otherwise a free port is
 * picked. API and dashboard are guaranteed distinct. The result is persisted.
 */
export async function resolvePorts(prefs: { api?: number; dashboard?: number }): Promise<ResolvedPorts> {
  const stored = loadStoredPorts();
  const apiPref = prefs.api ?? stored.api ?? DEFAULT_API;
  const dashPref = prefs.dashboard ?? stored.dashboard ?? DEFAULT_DASHBOARD;

  // A "remembered" port (came from ports.json, not an explicit flag) is one we
  // previously ran on, so a restart should RECLAIM it — briefly wait for our own
  // dying process to release it instead of instantly grabbing a random port
  // (which would break session cookies + the edge upstream bound to the old
  // port). Genuinely-held ports still time out and move.
  const apiRemembered = prefs.api === undefined && stored.api === apiPref;
  const dashRemembered = prefs.dashboard === undefined && stored.dashboard === dashPref;

  let api: number;
  if (await isPortFree(apiPref)) api = apiPref;
  else if (apiRemembered && (await waitPortFree(apiPref))) api = apiPref;
  else api = await getFreePort();

  let dashboard: number;
  if (dashPref !== api && (await isPortFree(dashPref))) dashboard = dashPref;
  else if (dashPref !== api && dashRemembered && (await waitPortFree(dashPref))) dashboard = dashPref;
  else dashboard = await getFreePort();
  // Defend against getFreePort() handing back the API port between reservations.
  if (dashboard === api) dashboard = await getFreePort();

  saveStoredPorts(api, dashboard);
  return {
    api,
    dashboard,
    switched: { api: api !== apiPref, dashboard: dashboard !== dashPref },
  };
}
