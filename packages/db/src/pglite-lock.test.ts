import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

import { acquirePgliteLock, releasePgliteLock } from "./pglite-lock";

// The lock lives BESIDE the data dir (`<dir>.lock`), never inside it — a file
// inside would break PGlite's fresh-cluster initdb (non-empty dir).
const lk = (dir: string): string => `${dir}.lock`;
const dirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pglite-lock-"));
  dirs.push(dir);
  return dir;
}

// Reset module-held lock state and scrub temp dirs (and their sibling locks).
afterEach(() => {
  releasePgliteLock();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
    rmSync(lk(dir), { force: true });
  }
});

/** A PID that is guaranteed dead: spawn a child, kill it, wait for exit. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
  const pid = child.pid!;
  child.kill("SIGKILL");
  await once(child, "exit");
  return pid;
}

describe("acquirePgliteLock", () => {
  it("acquires an uncontended dir and releases it", async () => {
    const dir = freshDir();
    await acquirePgliteLock(dir);

    const lockPath = lk(dir);
    expect(existsSync(lockPath)).toBe(true);
    expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(process.pid);

    releasePgliteLock();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("reclaims a lock left by a crashed process (dead pid)", async () => {
    const dir = freshDir();
    const pid = await deadPid();
    writeFileSync(lk(dir), JSON.stringify({ pid, startedAt: 0, host: hostname() }));

    await acquirePgliteLock(dir, { waitMs: 200 });

    // Ownership transferred to us.
    expect(JSON.parse(readFileSync(lk(dir), "utf8")).pid).toBe(process.pid);
  });

  it("reclaims an unreadable/garbage lock file", async () => {
    const dir = freshDir();
    writeFileSync(lk(dir), "}{ not json");

    await acquirePgliteLock(dir, { waitMs: 200 });

    expect(JSON.parse(readFileSync(lk(dir), "utf8")).pid).toBe(process.pid);
  });

  it.each(["", '{"pid":'])("does not steal a lock whose owner may still be publishing its record: %j", async text => {
    const dir = freshDir();
    writeFileSync(lk(dir), text);
    await expect(acquirePgliteLock(dir, { waitMs: 0, takeover: false })).rejects.toThrow("initialization in progress");
    expect(readFileSync(lk(dir), "utf8")).toBe(text);
  });

  it("reclaims a stale incomplete record left by a writer that crashed", async () => {
    const dir = freshDir();
    writeFileSync(lk(dir), '{"pid":');
    const stale = new Date(Date.now() - 11_000);
    utimesSync(lk(dir), stale, stale);
    await acquirePgliteLock(dir, { waitMs: 0, takeover: false });
    expect(JSON.parse(readFileSync(lk(dir), "utf8")).pid).toBe(process.pid);
  });

  it("refuses a dir held by a live process after the bounded wait", async () => {
    const dir = freshDir();
    // Our own pid stands in for a live sibling instance.
    writeFileSync(
      lk(dir),
      JSON.stringify({ pid: process.pid, startedAt: Date.now(), host: hostname() }),
    );

    await expect(acquirePgliteLock(dir, { waitMs: 150, pollMs: 50 })).rejects.toThrow(
      /already using the database/,
    );

    // The live holder's lock is untouched — we never stole it.
    expect(JSON.parse(readFileSync(lk(dir), "utf8")).pid).toBe(process.pid);
  });

  it("refuses a lock owned by another machine without deleting it", async () => {
    const dir = freshDir();
    // A genuinely different machine is identified by machineId, not hostname.
    writeFileSync(
      lk(dir),
      JSON.stringify({
        pid: 4242,
        startedAt: Date.now(),
        host: "some-other-host",
        machineId: "a-different-machine-uuid",
      }),
    );

    await expect(acquirePgliteLock(dir, { waitMs: 50 })).rejects.toThrow(/different machine/);
    expect(existsSync(lk(dir))).toBe(true);
  });

  it("reclaims a pre-fix lock (no machineId, dead pid) despite hostname drift", async () => {
    // Regression: os.hostname() drifts on macOS (e.g. bluemac.local → bluemac),
    // so a same-machine lock written by an older build (no machineId, a stale
    // hostname) must be reclaimed via pid liveness — NOT rejected as a different
    // host and left wedging the data dir shut.
    const dir = freshDir();
    const pid = await deadPid();
    writeFileSync(lk(dir), JSON.stringify({ pid, startedAt: 0, host: "some-drifted-hostname" }));

    await acquirePgliteLock(dir, { waitMs: 200 });

    expect(JSON.parse(readFileSync(lk(dir), "utf8")).pid).toBe(process.pid);
  });
});
