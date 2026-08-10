/**
 * Dynamic port allocation — the ONE resolver behind every launcher.
 *
 * There is NO permanent port. A preference (a flag, the ports an install is
 * already configured with, the pair we ran on last time, or a documented default
 * like API 4000) is only ever a preference: if it's taken by a second instance,
 * another app, or a leftover process, we move to a free one instead of failing to
 * start. Resolution always happens BEFORE anything is written or spawned, so the
 * chosen ports can be baked into a service unit, a compose `.env`, or a child's
 * env in one pass.
 *
 * Storage lives with the caller, deliberately — the CLI remembers ports in
 * `~/.openship/ports.json` (OS_DIR) and the desktop app in Electron's `userData`.
 * This module takes the remembered pair as INPUT and returns the resolved pair, so
 * the algorithm is shared without either launcher inheriting the other's paths.
 *
 * NOT imported by the dashboard: this is a `node:net` module reached through the
 * `@repo/core/ports` subpath, never the browser-facing barrel.
 */
import { createServer } from "node:net";

/** Documented defaults for the self-hosted CLI. The desktop app passes NO
 *  defaults — a packaged app must not fight a dev server on 4000/3001. */
export const DEFAULT_API_PORT = 4000;
export const DEFAULT_DASHBOARD_PORT = 3001;

const LOOPBACK = "127.0.0.1";
/** How far past a busy preference to look for a NEIGHBOURING port before falling
 *  back to whatever the OS hands out. A moved port is operator-facing on a server
 *  install (browsed, firewalled, put in a proxy config), so 4001 beats 54317. */
const SCAN_SPAN = 20;
const MAX_PORT = 65535;

/** True if a specific TCP port is bindable right now on `host` (default loopback). */
export function isPortFree(port: number, host: string = LOOPBACK): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, host, () => srv.close(() => resolve(true)));
  });
}

/**
 * Wait (bounded) for a specific port to become bindable.
 *
 * On a restart the supervisor stops the old process then starts the new one, and
 * the new one often probes the remembered port BEFORE the old one has released
 * it. Without this wait the resolver instantly falls back to a different port —
 * changing the origin, logging every user out (session cookies are bound to
 * `localhost:<port>`), and stranding an edge upstream on the old port. A dying
 * process frees its port within a second or two, so a short wait reclaims the
 * canonical port in the common case; a genuinely-held port still times out and
 * moves.
 */
export async function waitPortFree(
  port: number,
  opts: { timeoutMs?: number; intervalMs?: number; host?: string } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 6000;
  const intervalMs = opts.intervalMs ?? 250;
  const host = opts.host ?? LOOPBACK;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await isPortFree(port, host)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Reserve a free TCP port (bind :0, read it, release). */
export function getFreePort(host: string = LOOPBACK): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, host, () => {
      const addr = srv.address();
      const port = addr && typeof addr === "object" ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

/**
 * First free port at or after `from`, else an OS-assigned one.
 *
 * `skip` excludes ports we must not land on even though they probe free — the
 * sibling service's just-chosen port (nothing is bound to it yet, so it probes
 * free right up until it's used), and ports our own stack currently publishes for
 * a DIFFERENT service (free-after-recreate, but not free for this one).
 */
export async function findPortNear(
  from: number,
  opts: { host?: string; span?: number; skip?: (port: number) => boolean } = {},
): Promise<number> {
  const host = opts.host ?? LOOPBACK;
  const span = opts.span ?? SCAN_SPAN;
  const skip = opts.skip ?? (() => false);
  for (let port = from; port <= Math.min(from + span, MAX_PORT); port++) {
    if (!skip(port) && (await isPortFree(port, host))) return port;
  }
  let port = await getFreePort(host);
  for (let tries = 0; tries < 10 && skip(port); tries++) port = await getFreePort(host);
  return port;
}

export interface StoredPorts {
  api?: number;
  dashboard?: number;
}

export interface ResolvedPorts {
  api: number;
  dashboard: number;
  /** Whether each port had to move off its preference. False when there was none. */
  switched: { api: boolean; dashboard: boolean };
  /** What was asked for, so a caller can say what MOVED, not just where to. */
  preferred: { api: number; dashboard: number };
}

export interface PortPrefs {
  /** Explicit request (`--port` / `--dashboard-port`) — outranks everything. */
  api?: number;
  dashboard?: number;
  /**
   * Ports the CURRENT install is already configured with (a compose stack's
   * `.env`). Ranked above `stored`: for a compose install the `.env` is what the
   * running containers actually publish, while the remembered pair may be a
   * leftover from a different install mode on the same box.
   */
  previous?: StoredPorts;
  /** The pair we ran on last time, read from wherever the caller keeps it. */
  stored?: StoredPorts;
  /**
   * Last-resort preference when nothing above applies. OMIT IT to mean "any free
   * port": that's the desktop app, which must never land on 4000/3001 because a
   * dev server owns those, and whose users never type the port anyway.
   */
  defaults?: StoredPorts;
  /**
   * Interface the ports will be published on. A compose stack publishes on
   * 0.0.0.0, and a port can be free on loopback while a foreign process holds it
   * on a specific external IP — probing the wrong interface reports "free" and
   * then the bind fails. Default loopback.
   */
  bindAddr?: string;
  /**
   * Busy ports that belong to THIS install and are therefore reclaimable: the
   * containers holding them are recreated (or removed) by the very command that
   * is asking. Without this, every compose re-run sees its own api on 4000, calls
   * it occupied, and walks the install to a new port each time — changing the
   * origin, logging everyone out, and stranding the edge on the old port.
   */
  reclaimable?: number[];
}

/**
 * Resolve the API + dashboard ports, moving off any that are occupied.
 *
 * Preference order per port: explicit → the install's current config → last-used
 * → `defaults` → (none: any free port). A preference that's free, or held by an
 * install we're about to replace, is kept so the origin stays stable; otherwise
 * the nearest free neighbour is taken. The two ports are always distinct.
 *
 * Pure with respect to storage: pass `stored` in, persist the result yourself.
 */
export async function resolvePortPair(prefs: PortPrefs = {}): Promise<ResolvedPorts> {
  const host = prefs.bindAddr?.trim() || LOOPBACK;
  const ours = new Set(prefs.reclaimable ?? []);

  const prefFor = (kind: "api" | "dashboard"): number | undefined =>
    prefs[kind] ?? prefs.previous?.[kind] ?? prefs.stored?.[kind] ?? prefs.defaults?.[kind];

  // A "remembered" port (the install's config or the last-used pair, not an
  // explicit request) is one we previously ran on, so a restart should RECLAIM it:
  // briefly wait for our own dying process to release it rather than instantly
  // taking another port. See waitPortFree for what that costs when it's skipped.
  const remembered = (kind: "api" | "dashboard", pref: number): boolean =>
    prefs[kind] === undefined &&
    (prefs.previous?.[kind] === pref || prefs.stored?.[kind] === pref);

  // Available FOR ITS OWN PREFERENCE: free, or held by the install we're about to
  // replace. Only applied to the preference — the scan below still demands a
  // genuinely free port, so a moved service never lands on a port our own stack
  // is holding for a different one.
  const availableForPref = async (port: number) =>
    ours.has(port) || (await isPortFree(port, host));

  const apiPref = prefFor("api");
  const dashPref = prefFor("dashboard");

  let api: number;
  if (apiPref === undefined) api = await getFreePort(host);
  else if (await availableForPref(apiPref)) api = apiPref;
  else if (remembered("api", apiPref) && (await waitPortFree(apiPref, { host }))) api = apiPref;
  else {
    api = await findPortNear(apiPref + 1, {
      host,
      skip: (p) => ours.has(p) || p === dashPref,
    });
  }

  const skipForDash = (p: number) => ours.has(p) || p === api;
  let dashboard: number;
  if (dashPref === undefined) {
    dashboard = await getFreePort(host);
    // getFreePort can hand back the port the api just reserved (nothing is bound
    // to it yet), and two services on one port is a launch failure.
    for (let tries = 0; tries < 10 && dashboard === api; tries++) {
      dashboard = await getFreePort(host);
    }
  } else if (dashPref !== api && (await availableForPref(dashPref))) {
    dashboard = dashPref;
  } else if (
    dashPref !== api &&
    remembered("dashboard", dashPref) &&
    (await waitPortFree(dashPref, { host }))
  ) {
    dashboard = dashPref;
  } else {
    dashboard = await findPortNear(dashPref + 1, { host, skip: skipForDash });
  }

  return {
    api,
    dashboard,
    switched: {
      api: apiPref !== undefined && api !== apiPref,
      dashboard: dashPref !== undefined && dashboard !== dashPref,
    },
    preferred: { api: apiPref ?? api, dashboard: dashPref ?? dashboard },
  };
}
