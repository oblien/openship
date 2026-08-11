/**
 * Shared health-gathering + database-repair logic behind `openship doctor` and
 * the bare-`openship` control panel. Kept in one place so both entry points
 * present the same status readout and run the identical, well-tested repair
 * sequence.
 *
 * The repair itself lives here (not in the API) because a corrupt PGlite dir
 * crash-loops the API on boot — so recovery must run with the service STOPPED,
 * from this same-machine CLI, against ~/.openship/data directly. See lib/heal.ts.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { LOG_DIR, OS_DIR } from "./paths";
import chalk from "chalk";
import { spinner, log, select, confirm, isCancel, cancel } from "@clack/prompts";
import { serviceStatus, stop as stopService, type ServiceKind } from "./service";
import {
  readInstanceUrl,
  readStoredPorts as storedPorts,
  storedApiPort as apiPort,
  storedDashboardPort as dashboardPort,
} from "./ports";
import { startService, ensureInternalToken } from "../commands/up";
import {
  summarizeHostChannelCause,
  HOST_CHANNEL_PROVISION_COMMAND,
  type HostChannelCause,
} from "@repo/core";
import type { HostChannelCheck } from "./host-channel-preflight";
import {
  resolveDataDir,
  dataDirExists,
  backupDataDir,
  healDataDir,
  restoreBackup,
  freshStart,
  hasResetwal,
  deepHeal,
} from "./heal";

/** Narrow clack's cancel symbol; Ctrl-C/Esc exits cleanly. Copied from wizard.ts
 *  (that copy isn't exported) so both callers share one behaviour. */
export function ensure<T>(value: T | symbol): T {
  if (isCancel(value)) {
    cancel("Cancelled.");
    process.exit(0);
  }
  return value as T;
}

// Ports come from lib/ports.ts — the single reader/persister for every install
// mode. Re-exported under these names because doctor + the control panel import
// them from this module; they are NOT a second implementation.
export { storedPorts, apiPort, dashboardPort };

/** Internal-token-gated GET against the loopback API. null on any failure. */
export async function internalGet(path: string, timeoutMs = 8000): Promise<any | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${apiPort()}${path}`, {
      headers: { "X-Internal-Token": ensureInternalToken() },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Is the local API answering its liveness stub right now? */
export async function apiReachable(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${apiPort()}/api/health`, {
      signal: AbortSignal.timeout(2500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Poll until the API answers (post-restart), or timeout. */
export async function waitApiHealthy(seconds = 60): Promise<boolean> {
  for (let i = 0; i < seconds; i++) {
    if (await apiReachable()) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/** Poll until the API STOPS answering (post-stop) so the DB lock is released
 *  before we touch the data dir. */
async function waitApiDown(seconds = 20): Promise<boolean> {
  for (let i = 0; i < seconds; i++) {
    if (!(await apiReachable())) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** Last error-ish line from the service logs — surfaces the real boot failure
 *  (e.g. a corrupt/locked DB) instead of a bare timeout. */
export function lastServiceError(): string | null {
  for (const name of ["up.err.log", "up.log", "instance.log"]) {
    const p = join(LOG_DIR, name);
    if (!existsSync(p)) continue;
    try {
      const lines = readFileSync(p, "utf8").trim().split("\n");
      const hit = [...lines]
        .reverse()
        .find((l) => /error|locked|aborted|malformed|corrupt|throw|cannot|EADDRINUSE/i.test(l));
      if (hit) return hit.trim().slice(0, 240);
    } catch {
      /* ignore */
    }
  }
  return null;
}

const CORRUPTION_RE = /aborted\(\)|malformed|corrupt|database disk image|locked/i;

/** Heuristic: the box is installed but not running, and the log carries a
 *  DB-corruption signature — the case `openship doctor` exists to fix. */
export function looksCorrupted(): boolean {
  const svc = serviceStatus();
  if (!svc.installed || svc.running) return false;
  if (!dataDirExists()) return false;
  const err = lastServiceError();
  return !!err && CORRUPTION_RE.test(err);
}

/* ── Services (live, via docker on the same machine) ──────────────────────── */

export type ServiceState = "running" | "stopped" | "failed";
export interface ServiceRow {
  name: string;
  project: string | null;
  state: ServiceState;
  raw: string;
}

function dockerAvailable(): boolean {
  const r = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
    timeout: 4000,
  });
  return r.status === 0 && !!r.stdout.trim();
}

function mapState(dockerState: string): ServiceState {
  const s = dockerState.toLowerCase();
  if (s.includes("running") || s.includes("restarting")) return "running";
  if (s.includes("dead") || s.includes("unhealthy")) return "failed";
  return "stopped"; // exited / created / paused
}

/** Live list of deployed-app containers (all openship deployments), via one
 *  `docker ps`. Empty when docker isn't the runtime / isn't reachable. */
export function dockerServices(): ServiceRow[] {
  if (!dockerAvailable()) return [];
  const fmt = '{{.Names}}\t{{.State}}\t{{.Label "openship.project"}}';
  const r = spawnSync(
    "docker",
    ["ps", "-a", "--filter", "label=openship.deployment", "--format", fmt],
    { encoding: "utf8", timeout: 6000 },
  );
  if (r.status !== 0 || !r.stdout.trim()) return [];
  return r.stdout
    .trim()
    .split("\n")
    .map((line) => {
      const [name, state, project] = line.split("\t");
      return { name: name ?? "?", project: project || null, state: mapState(state ?? ""), raw: state ?? "" };
    });
}

/** True if a container whose name matches `nameFilter` is currently running. */
function dockerNameRunning(nameFilter: string): boolean | null {
  if (!dockerAvailable()) return null;
  const r = spawnSync(
    "docker",
    ["ps", "--filter", `name=${nameFilter}`, "--format", "{{.Names}}"],
    { encoding: "utf8", timeout: 5000 },
  );
  if (r.status !== 0) return null;
  return r.stdout.trim().length > 0;
}

export type CheckState = "pass" | "warn" | "fail";
export interface ComponentCheck {
  name: string;
  state: CheckState;
  detail: string;
  /** Stable key for callers that act on a specific row — `name` is display copy. */
  id?: "api" | "dashboard" | "edge" | "host-control";
}

/**
 * The container→host SSH channel, dialed from inside the api container.
 *
 * `openship up --compose` provisions this channel (key + authorized_keys + env)
 * without ever sending a packet over it, so on a default-deny host it is dead from
 * birth and every host operation fails looking exactly like a bad key (#490). This
 * row is where an operator finds that out on purpose — the install-time preflight
 * points here by name.
 *
 * Null when there is no channel to speak of (bare install, non-Linux, or host
 * control switched off): a row about a channel nobody wanted is noise. A channel that
 * WAS wanted and never got provisioned is the opposite of noise — see below.
 */
async function hostControlCheck(api: ApiHostChannel | null): Promise<ComponentCheck | null> {
  // Imported lazily: the probe shells out to `docker compose exec`, and doctor's
  // other checks must not pay for that module on a bare install.
  const { checkHostChannel } = await import("./host-channel-preflight");
  return hostControlRow(await checkHostChannel().catch(() => null), api);
}

/**
 * `GET /api/system/health`'s `hostChannel` section — the API reporting on its OWN
 * process env.
 *
 * Narrowed to what a row needs, and typed here rather than imported: the CLI does not
 * depend on apps/api. `state` is `hostChannelHealth`'s code verbatim on both sides.
 */
export interface ApiHostChannel {
  ok?: boolean;
  state?: string;
  remedy?: string;
}

/** Said in exactly one place, because the local probe and the API fallback below are
 *  the same state and an operator may hit either. */
const NEVER_PROVISIONED_DETAIL = `never provisioned — run \`${HOST_CHANNEL_PROVISION_COMMAND}\``;

/**
 * The probe result → the row an operator reads. Exported so the copy and the fail/warn
 * split are pinned without shelling into a container.
 *
 * `api` is the fallback for an install shape the LOCAL probe can't see: it needs
 * `~/.openship/compose/docker-compose.yml` both to read the channel out of `.env` and to
 * `docker compose exec` into the api container, and a stack brought up by running
 * `docker/docker-compose.yml` by hand has neither. That install used to get no row at all
 * — from the one command #509's error text names (see HOST_CHANNEL_NOT_PROVISIONED).
 */
export function hostControlRow(
  res: HostChannelCheck | null,
  api?: ApiHostChannel | null,
): ComponentCheck | null {
  const at = res?.target ?? "the host";
  const row = (state: CheckState, detail: string): ComponentCheck => ({
    name: "Host control",
    state,
    detail,
    id: "host-control",
  });

  if (!res?.configured) {
    // #509 closed the loop the wrong way round: the error an operator reads when a host
    // op dies names `openship doctor` as the way to check this, and doctor printed no row
    // at all for the state that produces that error. A channel that was never provisioned
    // is exactly as broken as one that's firewalled off, and this is where an operator
    // finds that out.
    if (res?.unprovisioned) return row("fail", NEVER_PROVISIONED_DETAIL);
    // Nothing local to report. The API knows its own env on EVERY install shape, so ask
    // it before going silent — but only about the states it can establish structurally.
    // `disabled` and `not_applicable` are a box that wanted no channel (a choice, and a
    // bare install), which is the same non-event the local path returns null for.
    switch (api?.state) {
      case "not_configured":
        return row("fail", NEVER_PROVISIONED_DETAIL);
      case "ok":
        return row("pass", "reachable from the api container");
      // Real faults — but the endpoint deliberately withholds the address and the
      // firewall rule (both belong on a surface an operator is standing at, not in a
      // monitoring payload), so this row can only point at one that has them.
      case "key_unreadable":
      case "unreachable":
        return row("fail", `${api.state.replace(/_/g, " ")} — see the api container's boot log`);
      // `disabled` (a hardening choice) and `not_applicable` (a bare install) are the
      // same non-event the local path returns null for. Whitelisted rather than derived
      // from `ok === false`, which `disabled` also is.
      default:
        return null;
    }
  }
  // One clause per cause, from the shared vocabulary — a doctor row that disagreed
  // with the install-time preflight about the same probe would be worse than no row.
  const why = (cause: HostChannelCause) =>
    summarizeHostChannelCause(cause, {
      target: at,
      host: res.target?.split(":")[0],
      detail: res.detail,
    });

  switch (res.code) {
    case "open":
      return row("pass", `reachable at ${at}`);
    // Only a dropped SYN is the firewall shape, so it is the only row that names the
    // flag; pointing the others at ufw is the mistake the preflight exists to avoid.
    case "timeout":
      return row("fail", `${why("timeout")} — open the host firewall: openship up --open-host-firewall`);
    case "refused":
    case "unresolved":
    case "no_route":
      return row("fail", why(res.code));
    // Couldn't determine: a warn, never a hard fail (see below).
    case "unavailable":
      return row("warn", `couldn't check from the api container${res.detail ? ` (${res.detail})` : ""}`);
    default:
      return row("warn", why("error"));
  }
}

/** System-component rollup: API, dashboard, edge proxy, host control. Best-effort —
 *  a piece we can't determine is reported as a warn, never a hard fail.
 *
 *  `apiHostChannel` is `/api/system/health`'s `hostChannel` section, already fetched by
 *  `gatherStatus` — passed in rather than re-fetched, and the fallback for install shapes
 *  the local probe can't see (see {@link hostControlRow}). */
export async function componentChecks(
  apiUp: boolean,
  apiHostChannel: ApiHostChannel | null = null,
): Promise<ComponentCheck[]> {
  const checks: ComponentCheck[] = [];

  checks.push({
    name: "API",
    id: "api",
    state: apiUp ? "pass" : "fail",
    detail: apiUp ? `reachable on :${apiPort()}` : `not answering on :${apiPort()}`,
  });

  // Dashboard — any HTTP response on its port means it's serving.
  let dashUp = false;
  try {
    const res = await fetch(`http://127.0.0.1:${dashboardPort()}/`, {
      redirect: "manual",
      signal: AbortSignal.timeout(2500),
    });
    dashUp = res.status > 0;
  } catch {
    /* down */
  }
  checks.push({
    name: "Dashboard",
    id: "dashboard",
    state: dashUp ? "pass" : "warn",
    detail: dashUp ? `serving on :${dashboardPort()}` : `not serving on :${dashboardPort()}`,
  });

  // Edge (OpenResty) — our container is named `openship-edge`. Absent = not
  // installed (fine on a private/local box), so warn-not-fail.
  const edge = dockerNameRunning("openship-edge");
  checks.push(
    edge == null
      ? { name: "Edge", id: "edge", state: "warn", detail: "docker unavailable — can't check" }
      : edge
        ? { name: "Edge", id: "edge", state: "pass", detail: "openship-edge running" }
        : { name: "Edge", id: "edge", state: "warn", detail: "not installed (fine for a local box)" },
  );

  const hostControl = await hostControlCheck(apiHostChannel);
  if (hostControl) checks.push(hostControl);

  return checks;
}

/* ── Full status snapshot ─────────────────────────────────────────────────── */

export interface DoctorStatus {
  service: { kind: ServiceKind; installed: boolean; running: boolean };
  apiUp: boolean;
  health: { db?: { driver: string; ok: boolean; latencyMs: number | null; migrationsApplied: number | null }; projects?: { total: number; apps: number } | null; servicesConfigured?: number | null; hostChannel?: ApiHostChannel | null } | null;
  services: ServiceRow[];
  components: ComponentCheck[];
  corrupted: boolean;
  lastError: string | null;
  dataDir: string;
}

export async function gatherStatus(): Promise<DoctorStatus> {
  const service = serviceStatus();
  const apiUp = await apiReachable();
  const health = apiUp ? await internalGet("/api/system/health") : null;
  return {
    service,
    apiUp,
    health,
    services: dockerServices(),
    components: await componentChecks(apiUp, health?.hostChannel ?? null),
    corrupted: looksCorrupted(),
    lastError: lastServiceError(),
    dataDir: resolveDataDir(),
  };
}

/* ── Repair ───────────────────────────────────────────────────────────────── */

/** Reinstall + start the service, preserving a real public URL if one was set
 *  (a local/localhost URL means a private box → defaults are correct). */
async function bringUp(): Promise<boolean> {
  const url = readInstanceUrl();
  const publicUrl = url && !/^https?:\/\/localhost/i.test(url) ? url : undefined;
  await startService(publicUrl ? { publicUrl } : {}, { quiet: true } as { quiet?: boolean });
  return waitApiHealthy(60);
}

export interface RepairResult {
  healed: boolean;
  backupDir: string | null;
  detail: string;
}

/**
 * Backup → in-place heal → restart → verify, with restore/fresh fallbacks.
 * Must be run inside an existing clack session (uses spinner/log/select). The
 * caller has already confirmed intent.
 */
export async function runRepair(): Promise<RepairResult> {
  if (!dataDirExists()) {
    return { healed: false, backupDir: null, detail: "No embedded database at " + resolveDataDir() + " — nothing to repair (external/Postgres DBs are managed by the database server)." };
  }

  // 1. Stop the service so the DB lock is released before we touch the dir.
  const sp = spinner();
  sp.start("Stopping the service");
  const stopped = stopService();
  await waitApiDown(20);
  sp.stop(`Service stopped (${stopped.detail}).`);

  // 2. Back up the whole data dir FIRST — nothing destructive runs before this.
  let backupDir: string | null = null;
  const bk = spinner();
  bk.start("Backing up the database");
  try {
    backupDir = backupDataDir();
    bk.stop(`Backup saved → ${chalk.dim(backupDir)}`);
  } catch (err) {
    bk.stop("Backup failed — aborting to protect your data.", 1);
    await bringUp();
    return { healed: false, backupDir: null, detail: `Backup failed: ${(err as Error).message}` };
  }

  // 3. In-place heal (clear stale lock + trim the corrupt WAL tail).
  const hp = spinner();
  hp.start("Repairing the database");
  const healRes = healDataDir();
  hp.stop(
    `Repaired (${healRes.removedPostmasterPid ? "cleared stale lock; " : ""}${
      healRes.trimmedWalSegment ? `trimmed WAL ${healRes.trimmedWalSegment}` : "no WAL tail to trim"
    }).`,
  );

  // 4. Bring it back up and verify the DB actually answers.
  const up = spinner();
  up.start("Restarting and verifying");
  let healthy = await bringUp();
  let verified = healthy && !!(await internalGet("/api/system/health"))?.db?.ok;
  up.stop(verified ? chalk.green("Database is healthy again.") : "Still not healthy after the light repair.", verified ? 0 : 1);
  if (verified) {
    return { healed: true, backupDir, detail: "In-place repair succeeded — your data is intact." };
  }

  // 5. Escalate — offer a deeper heal (if pg_resetwal is present), then
  // restore-from-backup, then a fresh database (backup kept aside).
  const options: Array<{ value: string; label: string; hint?: string }> = [];
  if (hasResetwal()) options.push({ value: "deep", label: "Deeper repair (pg_resetwal)", hint: "rebuilds the write-ahead log" });
  options.push({ value: "restore", label: "Restore the pre-repair backup", hint: "back to exactly how it was" });
  options.push({ value: "fresh", label: "Start a fresh database", hint: "empty DB; your data is kept aside to recover manually" });
  options.push({ value: "abort", label: "Leave it and quit", hint: "backups are preserved" });

  const choice = ensure(
    await select({ message: "The light repair didn't fully recover it. What next?", options }),
  );

  if (choice === "deep") {
    stopService();
    await waitApiDown(20);
    const d = spinner();
    d.start("Running deep repair (pg_resetwal)");
    try {
      deepHeal();
      d.stop("Deep repair done.");
    } catch (err) {
      d.stop(`Deep repair failed: ${(err as Error).message}`, 1);
    }
    healthy = await bringUp();
    verified = healthy && !!(await internalGet("/api/system/health"))?.db?.ok;
    if (verified) return { healed: true, backupDir, detail: "Deep repair succeeded." };
    log.warn("Deep repair didn't recover it either.");
  }

  if (choice === "restore") {
    stopService();
    await waitApiDown(20);
    const r = spinner();
    r.start("Restoring the backup");
    try {
      restoreBackup(backupDir!);
      r.stop("Backup restored.");
    } catch (err) {
      r.stop(`Restore failed: ${(err as Error).message}`, 1);
    }
    await bringUp();
    return { healed: false, backupDir, detail: `Restored to the pre-repair state (${backupDir}).` };
  }

  if (choice === "fresh") {
    stopService();
    await waitApiDown(20);
    const f = spinner();
    f.start("Starting a fresh database");
    const aside = freshStart();
    f.stop(`Corrupt data parked → ${chalk.dim(aside)}`);
    const ok = await bringUp();
    return {
      healed: ok,
      backupDir,
      detail: ok
        ? `Fresh database started. Your old data is at ${aside} (and a backup at ${backupDir}).`
        : "Started a fresh database but the API still isn't healthy — check the logs.",
    };
  }

  return { healed: false, backupDir, detail: `Left unrepaired. Backup preserved at ${backupDir}.` };
}
