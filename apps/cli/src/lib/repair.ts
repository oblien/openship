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
}

/** System-component rollup: API, dashboard, edge proxy. Best-effort — a piece
 *  we can't determine is reported as a warn, never a hard fail. */
export async function componentChecks(apiUp: boolean): Promise<ComponentCheck[]> {
  const checks: ComponentCheck[] = [];

  checks.push({
    name: "API",
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
    state: dashUp ? "pass" : "warn",
    detail: dashUp ? `serving on :${dashboardPort()}` : `not serving on :${dashboardPort()}`,
  });

  // Edge (OpenResty) — our container is named `openship-edge`. Absent = not
  // installed (fine on a private/local box), so warn-not-fail.
  const edge = dockerNameRunning("openship-edge");
  checks.push(
    edge == null
      ? { name: "Edge", state: "warn", detail: "docker unavailable — can't check" }
      : edge
        ? { name: "Edge", state: "pass", detail: "openship-edge running" }
        : { name: "Edge", state: "warn", detail: "not installed (fine for a local box)" },
  );

  return checks;
}

/* ── Full status snapshot ─────────────────────────────────────────────────── */

export interface DoctorStatus {
  service: { kind: ServiceKind; installed: boolean; running: boolean };
  apiUp: boolean;
  health: { db?: { driver: string; ok: boolean; latencyMs: number | null; migrationsApplied: number | null }; projects?: { total: number; apps: number } | null; servicesConfigured?: number | null } | null;
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
    components: await componentChecks(apiUp),
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
