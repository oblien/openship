import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveDataDir,
  backupDataDir,
  healDataDir,
  restoreBackup,
  freshStart,
} from "../../src/lib/heal";

const WAL_OLD = "000000010000000000000001";
const WAL_NEW = "000000010000000000000002";

let root: string;
let dataDir: string;

/** Build a minimal PGlite-ish data dir with two WAL segments (distinct mtimes),
 *  a committed page under base/, and a stale postmaster.pid. */
function seed(dir: string) {
  mkdirSync(join(dir, "base"), { recursive: true });
  mkdirSync(join(dir, "global"), { recursive: true });
  mkdirSync(join(dir, "pg_wal"), { recursive: true });
  writeFileSync(join(dir, "base", "committed"), "important-data");
  writeFileSync(join(dir, "global", "pg_control"), "control");
  writeFileSync(join(dir, "postmaster.pid"), "12345");
  writeFileSync(join(dir, "pg_wal", WAL_OLD), "old");
  writeFileSync(join(dir, "pg_wal", WAL_NEW), "new-corrupt-tail");
  // Make WAL_NEW the newest by mtime.
  utimesSync(join(dir, "pg_wal", WAL_OLD), new Date(1000), new Date(1000));
  utimesSync(join(dir, "pg_wal", WAL_NEW), new Date(2000), new Date(2000));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "openship-heal-"));
  dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  seed(dataDir);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.PGLITE_DATA_DIR;
});

describe("resolveDataDir", () => {
  it("honors PGLITE_DATA_DIR over the default", () => {
    process.env.PGLITE_DATA_DIR = "/tmp/custom-openship-data";
    expect(resolveDataDir()).toBe("/tmp/custom-openship-data");
  });
  it("defaults to ~/.openship/data when unset", () => {
    delete process.env.PGLITE_DATA_DIR;
    expect(resolveDataDir().endsWith(join(".openship", "data"))).toBe(true);
  });
});

describe("backupDataDir", () => {
  it("snapshots the whole dir to a sibling .backup-* and leaves the original", () => {
    const backup = backupDataDir(dataDir);
    expect(backup.startsWith(`${dataDir}.backup-`)).toBe(true);
    // Backup is a full copy.
    expect(readFileSync(join(backup, "base", "committed"), "utf8")).toBe("important-data");
    expect(existsSync(join(backup, "pg_wal", WAL_NEW))).toBe(true);
    // Original untouched.
    expect(existsSync(join(dataDir, "pg_wal", WAL_NEW))).toBe(true);
  });
});

describe("healDataDir", () => {
  it("removes postmaster.pid and trims ONLY the newest WAL segment", () => {
    const res = healDataDir(dataDir);
    expect(res.removedPostmasterPid).toBe(true);
    expect(res.trimmedWalSegment).toBe(WAL_NEW);
    // postmaster.pid gone.
    expect(existsSync(join(dataDir, "postmaster.pid"))).toBe(false);
    // Newest WAL removed, older WAL + committed pages kept.
    expect(existsSync(join(dataDir, "pg_wal", WAL_NEW))).toBe(false);
    expect(existsSync(join(dataDir, "pg_wal", WAL_OLD))).toBe(true);
    expect(readFileSync(join(dataDir, "base", "committed"), "utf8")).toBe("important-data");
  });

  it("is a no-op-safe when there is nothing to clean", () => {
    rmSync(join(dataDir, "postmaster.pid"), { force: true });
    rmSync(join(dataDir, "pg_wal"), { recursive: true, force: true });
    const res = healDataDir(dataDir);
    expect(res.removedPostmasterPid).toBe(false);
    expect(res.trimmedWalSegment).toBe(null);
  });
});

describe("restoreBackup", () => {
  it("restores a backup over the live dir, parking the current one aside", () => {
    const backup = backupDataDir(dataDir);
    healDataDir(dataDir); // mutate live (drop WAL_NEW)
    expect(existsSync(join(dataDir, "pg_wal", WAL_NEW))).toBe(false);
    restoreBackup(backup, dataDir);
    // Live dir is back to the pre-heal state.
    expect(existsSync(join(dataDir, "pg_wal", WAL_NEW))).toBe(true);
    // The discarded copy is parked, not deleted.
    expect(readdirSync(root).some((n) => n.startsWith("data.discarded-"))).toBe(true);
  });
});

describe("freshStart", () => {
  it("moves the corrupt dir aside so a fresh DB can be created", () => {
    const aside = freshStart(dataDir);
    expect(aside.startsWith(`${dataDir}.corrupt-`)).toBe(true);
    expect(existsSync(dataDir)).toBe(false);
    expect(existsSync(join(aside, "base", "committed"))).toBe(true);
  });
});
