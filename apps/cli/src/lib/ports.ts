/**
 * The CLI's port STORAGE + operator-facing messaging.
 *
 * The resolution algorithm itself lives in `@repo/core/ports` (`resolvePortPair`),
 * shared with the desktop app so the two launchers can't drift — that divergence is
 * why the desktop one lacked the restart grace period. What's CLI-specific and
 * stays here: remembering the pair in `~/.openship/ports.json` (OS_DIR), the
 * documented 4000/3001 defaults, and the lines we print when a port moves.
 *
 * Ports are persisted so a restart REUSES the same origin when it's still free —
 * session cookies are bound to `localhost:<port>`, so a stable port is what keeps
 * you logged in across restarts. ports.json is also how `openship status`,
 * `doctor`, `reset-admin` and the control panel find the running instance, which is
 * why EVERY install mode (bare + compose) resolves through here.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_API_PORT,
  DEFAULT_DASHBOARD_PORT,
  resolvePortPair,
  type PortPrefs as CorePortPrefs,
  type ResolvedPorts,
  type StoredPorts,
} from "@repo/core/ports";

import { OS_DIR } from "./paths";

// One import site for anything port-related, even though the primitives are now
// shared code rather than local functions.
export {
  DEFAULT_API_PORT,
  DEFAULT_DASHBOARD_PORT,
  findPortNear,
  getFreePort,
  isPortFree,
  waitPortFree,
  type ResolvedPorts,
  type StoredPorts,
} from "@repo/core/ports";

export const PORTS_FILE = join(OS_DIR, "ports.json");
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

/**
 * The ports the running instance last resolved to — the ONE reader.
 *
 * Every command that has to reach the local instance (`status`, `doctor`,
 * `reset-admin`, the control panel, the orphan-port sweep in lib/service.ts) needs
 * this, and each used to inline its own `JSON.parse(readFileSync(...))`. One of
 * those copies pointed at `~/.openship` instead of OS_DIR, which under
 * OPENSHIP_HOME (a from-source install) read the OTHER install's ports.
 */
export function readStoredPorts(): StoredPorts {
  try {
    return JSON.parse(readFileSync(PORTS_FILE, "utf-8")) as StoredPorts;
  } catch {
    return {};
  }
}

/** Remembered API port, falling back to the default preference. */
export function storedApiPort(): number {
  return readStoredPorts().api ?? DEFAULT_API_PORT;
}

/** Remembered dashboard port, falling back to the default preference. */
export function storedDashboardPort(): number {
  return readStoredPorts().dashboard ?? DEFAULT_DASHBOARD_PORT;
}

function saveStoredPorts(api: number, dashboard: number): void {
  try {
    if (!existsSync(OS_DIR)) mkdirSync(OS_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(PORTS_FILE, JSON.stringify({ api, dashboard }));
  } catch {
    // best-effort — resolution still works without persistence.
  }
}

/**
 * The operator-facing lines for a port that MOVED — empty when nothing moved.
 *
 * One builder, three printers: `openship up` (compose), `openship up` (bare) and
 * the wizard all have to say this, and the wizard prints through clack rather than
 * console.log. Returning lines instead of printing keeps the wording identical
 * without forcing one output style on all three.
 */
export function portMoveNotice(
  resolved: ResolvedPorts,
  trustedOriginUrls: Array<string | undefined | null> = [],
): string[] {
  if (!resolved.switched.api && !resolved.switched.dashboard) return [];
  const lines = [
    `A preferred port was busy — using API ${resolved.api}, dashboard ${resolved.dashboard}.`,
  ];
  const stale = [...new Set(stalePortOrigins(resolved.preferred.dashboard, trustedOriginUrls))];
  if (stale.length) {
    lines.push(
      `Heads up: ${stale.join(", ")} still names port ${resolved.preferred.dashboard}, so logins`,
      `from that origin will be rejected. Point it at :${resolved.dashboard} (or free port`,
      `${resolved.preferred.dashboard} and re-run to move back).`,
    );
  }
  return lines;
}

/**
 * URLs that still name the port the dashboard just moved OFF.
 *
 * `OPENSHIP_PUBLIC_URL` and `OPENSHIP_EXTRA_TRUSTED_ORIGINS` are the API's
 * `trustedOrigins` allowlist. If one names `:3001` and the dashboard is now on
 * `:3002`, the browser's origin no longer matches: the install serves reads and
 * 403s every login with `ORIGIN_REJECTED` — an error that names neither the cause
 * nor the fix. Matched against the ABANDONED port specifically, so a URL naming a
 * reverse proxy's own port (`https://ops.example.com:8443`) is left alone.
 */
export function stalePortOrigins(
  movedFrom: number,
  urls: Array<string | undefined | null>,
): string[] {
  const stale: string[] = [];
  for (const raw of urls) {
    for (const candidate of (raw ?? "").split(",")) {
      const value = candidate.trim();
      if (!value) continue;
      try {
        if (new URL(value).port === String(movedFrom)) stale.push(value);
      } catch {
        // Not a parseable URL — nothing to reason about.
      }
    }
  }
  return stale;
}

/**
 * What a CLI caller may ask for. `stored` + `defaults` are filled in by
 * `resolvePorts` itself — the file and the documented defaults are this module's
 * business, not the caller's.
 */
export type PortPrefs = Omit<CorePortPrefs, "stored" | "defaults">;

/**
 * Resolve the API + dashboard ports, switching off any that are occupied.
 *
 * Preference order per port: explicit flag → the install's current config →
 * last-used (ports.json) → default. A preferred port that's free (or held by us)
 * is kept, so the origin stays stable; otherwise the nearest free neighbour is
 * taken. API and dashboard are guaranteed distinct. The result is persisted to
 * ports.json for every install mode, since that is what `openship doctor`,
 * `reset-admin` and the control panel read to find the running instance.
 *
 * `persist: false` resolves WITHOUT writing ports.json — for `--dry-run`, which
 * must report the ports a real run would take without becoming the run that
 * claims them (a preview that rewrote ports.json would repoint `openship
 * status`/`doctor` at a port nothing is listening on).
 */
export async function resolvePorts(
  prefs: PortPrefs,
  opts: { persist?: boolean } = {},
): Promise<ResolvedPorts> {
  const resolved = await resolvePortPair({
    ...prefs,
    stored: readStoredPorts(),
    defaults: { api: DEFAULT_API_PORT, dashboard: DEFAULT_DASHBOARD_PORT },
  });
  if (opts.persist !== false) saveStoredPorts(resolved.api, resolved.dashboard);
  return resolved;
}
