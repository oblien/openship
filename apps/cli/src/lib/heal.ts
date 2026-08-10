/**
 * PGlite data-dir recovery — get a corrupted embedded database back to a
 * startable state WITHOUT losing committed data. This is the pure-Node port of
 * `packages/db/scripts/heal-pglite.ts`, brought into the shipped CLI so
 * `openship doctor` can repair a box that's crash-looping on boot.
 *
 * Symptom this fixes:
 *   DrizzleQueryError: Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"
 *   cause: RuntimeError: Aborted()
 * — a partial WAL record written when the API process was killed mid-write
 * (OOM / kill -9 / lock collision) aborts the WASM Postgres on replay.
 *
 * INVARIANT: every mutating function here assumes the API service is STOPPED.
 * The running API holds the single-instance PGlite lock and keeps the data dir
 * open; touching `pg_wal` under a live server would itself corrupt it. Callers
 * (repair.ts) MUST `stop()` the service first.
 */

import {
  existsSync,
  readdirSync,
  statSync,
  unlinkSync,
  mkdirSync,
  copyFileSync,
  renameSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { DATA_DIR } from "./paths";

/** The embedded DB directory: `PGLITE_DATA_DIR` (with `~` expansion) else
 *  `~/.openship/data` — matches `resolvePgliteDataDir()` in packages/db. */
export function resolveDataDir(): string {
  const fromEnv = process.env.PGLITE_DATA_DIR?.trim();
  if (fromEnv) {
    return fromEnv.startsWith("~")
      ? join(homedir(), fromEnv.slice(1).replace(/^[/\\]/, ""))
      : fromEnv;
  }
  return DATA_DIR;
}

export function dataDirExists(dataDir = resolveDataDir()): boolean {
  return existsSync(dataDir);
}

/** Filesystem-safe timestamp suffix for sibling backup/aside dirs. */
function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function copyDirRecursive(src: string, dest: string): void {
  if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const s = join(src, entry);
    const d = join(dest, entry);
    if (statSync(s).isDirectory()) copyDirRecursive(s, d);
    else copyFileSync(s, d);
  }
}

/**
 * Full byte-for-byte snapshot of the data dir to a `<dir>.backup-<ts>` SIBLING
 * (never inside — PGlite refuses a non-empty dir). Returns the backup path. This
 * is the "take a backup first" step: nothing else in here runs before it.
 */
export function backupDataDir(dataDir = resolveDataDir()): string {
  const backup = `${dataDir}.backup-${stamp()}`;
  copyDirRecursive(dataDir, backup);
  return backup;
}

export interface HealResult {
  removedPostmasterPid: boolean;
  trimmedWalSegment: string | null;
}

/**
 * In-place heal of an already-backed-up dir:
 *   1. remove a stale `postmaster.pid` control file
 *   2. delete ONLY the newest `pg_wal` segment (the suspected-corrupt tail) —
 *      committed pages in `base/` and `global/` are never touched.
 * Idempotent and conservative; if it doesn't fix the dir, the pre-heal backup
 * is intact and the caller can restore or start fresh.
 */
export function healDataDir(dataDir = resolveDataDir()): HealResult {
  const result: HealResult = { removedPostmasterPid: false, trimmedWalSegment: null };

  const pidPath = join(dataDir, "postmaster.pid");
  if (existsSync(pidPath)) {
    unlinkSync(pidPath);
    result.removedPostmasterPid = true;
  }

  const walDir = join(dataDir, "pg_wal");
  if (existsSync(walDir)) {
    const segments = readdirSync(walDir)
      .filter((name) => /^[0-9A-F]{24}$/.test(name))
      .map((name) => ({ name, mtime: statSync(join(walDir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (segments.length > 0) {
      const newest = segments[0];
      unlinkSync(join(walDir, newest.name));
      result.trimmedWalSegment = newest.name;
    }
  }

  return result;
}

/** Restore a previously-taken backup OVER the live dir (used when a heal made
 *  things no better). Moves the current dir aside first so nothing is lost. */
export function restoreBackup(backupDir: string, dataDir = resolveDataDir()): void {
  if (!existsSync(backupDir)) throw new Error(`Backup not found: ${backupDir}`);
  if (existsSync(dataDir)) renameSync(dataDir, `${dataDir}.discarded-${stamp()}`);
  copyDirRecursive(backupDir, dataDir);
}

/**
 * Last resort: move the corrupt dir aside so the API recreates a fresh, empty
 * database on next boot. The data isn't deleted — it's parked at
 * `<dir>.corrupt-<ts>` (and the pre-heal backup still exists) so it can be
 * recovered manually. Returns the parked path.
 */
export function freshStart(dataDir = resolveDataDir()): string {
  const aside = `${dataDir}.corrupt-${stamp()}`;
  if (existsSync(dataDir)) renameSync(dataDir, aside);
  return aside;
}

/** Locate a system `pg_resetwal` (Postgres 17/16 preferred) for the deeper
 *  heal. Not bundled — returns null when absent, so deepHeal is opt-in. */
export function findResetwal(): string | null {
  const candidates = [
    "/opt/homebrew/opt/postgresql@17/bin/pg_resetwal",
    "/opt/homebrew/opt/postgresql@16/bin/pg_resetwal",
    "/usr/local/opt/postgresql@17/bin/pg_resetwal",
    "/usr/lib/postgresql/17/bin/pg_resetwal",
    "/usr/lib/postgresql/16/bin/pg_resetwal",
    "/usr/bin/pg_resetwal",
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  try {
    const found = execFileSync("bash", ["-lc", "command -v pg_resetwal"], {
      encoding: "utf8",
      timeout: 3000,
    }).trim();
    return found || null;
  } catch {
    return null;
  }
}

export function hasResetwal(): boolean {
  return findResetwal() != null;
}

/**
 * Deeper recovery via `pg_resetwal -f` — rebuilds a consistent WAL when the
 * lighter WAL-tail trim wasn't enough. Assumes the dir is already backed up and
 * the service is stopped. Throws if no `pg_resetwal` binary is available.
 */
export function deepHeal(dataDir = resolveDataDir()): void {
  const bin = findResetwal();
  if (!bin) throw new Error("pg_resetwal not found — install PostgreSQL 17 client tools to enable deep repair.");
  execFileSync(bin, ["-f", dataDir], { encoding: "utf8", timeout: 60_000 });
}
