import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

import { acquirePgliteLock, releasePgliteLock, createPgliteLock, releaseExitedWorkerLock } from "./pglite-lock";

// Exercise Linux process identity on every test platform without mocking lock I/O.
const procFiles = vi.hoisted(() => new Map<string, string | Error>());
const kernelProbe = vi.hoisted(() => ({ status: 0, error: undefined as Error | undefined }));
vi.mock("fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    readlinkSync: (path: string) => {
      const value = procFiles.get(path);
      if (value instanceof Error) throw value;
      return value ?? fs.readlinkSync(path);
    },
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
      const value = procFiles.get(String(args[0]));
      if (value instanceof Error) throw value;
      return value ?? fs.readFileSync(...args);
    },
  };
});
vi.mock("child_process", async (importOriginal) => {
  const childProcess = await importOriginal<typeof import("node:child_process")>();
  return {
    ...childProcess,
    spawnSync: (...args: Parameters<typeof childProcess.spawnSync>) =>
      args[0] === "flock"
        ? { status: kernelProbe.status, error: kernelProbe.error }
        : childProcess.spawnSync(...args),
  };
});

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
  procFiles.clear();
  kernelProbe.status = 0;
  kernelProbe.error = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
    rmSync(lk(dir), { force: true });
    rmSync(`${lk(dir)}.guard`, { force: true });
  }
});

describe("Linux kernel ownership and PID reuse", () => {
  const bootId = "d2bf7980-f6b3-4f89-b60d-37c34e64ce45";
  const bootPath = "/proc/sys/kernel/random/boot_id";
  const statPath = `/proc/${process.pid}/stat`;
  const processStart = `${bootId}:200`;
  const procStat = (ticks: string, comm = "node") =>
    `${process.pid} (${comm}) S ${Array(18).fill("0").join(" ")} ${ticks}\n`;

  beforeEach(() => {
    vi.stubGlobal(
      "process",
      new Proxy(process, {
        get: (target, key, receiver) =>
          key === "platform" ? "linux" : Reflect.get(target, key, receiver),
      }),
    );
    procFiles.set(bootPath, `${bootId}\n`);
    procFiles.set(statPath, procStat("200"));
    procFiles.set("/etc/machine-id", "test-linux-machine\n");
    procFiles.set("/proc/self/ns/pid", "pid:[101]");
  });

  function writeHolder(dir: string, start: string | undefined, kernelLock = true) {
    const text = JSON.stringify({
      pid: process.pid,
      startedAt: 1,
      host: hostname(),
      ownerId: "previous-owner",
      processStart: start,
      ...(kernelLock ? { kernelLock: true, pidNamespace: "pid:[101]" } : {}),
    });
    writeFileSync(lk(dir), text);
    return text;
  }

  it("records kernel ownership and PID namespace alongside process identity", async () => {
    const dir = freshDir();
    await acquirePgliteLock(dir, { waitMs: 0, takeover: false });
    expect(JSON.parse(readFileSync(lk(dir), "utf8")).processStart).toBe(
      processStart,
    );
    expect(JSON.parse(readFileSync(lk(dir), "utf8"))).toMatchObject({
      kernelLock: true, pidNamespace: "pid:[101]",
    });
  });

  it.each([
    ["a reused PID", `${bootId}:100`],
    ["a previous kernel boot", "bd6e5523-d0e0-4674-b15b-d9c631323f92:200"],
  ])(
    "reclaims a lock from %s without enabling takeover or signaling a process",
    async (_, start) => {
      const dir = freshDir();
      writeHolder(dir, start);
      const kill = vi.spyOn(process, "kill");
      await acquirePgliteLock(dir, { waitMs: 0, takeover: false });
      expect(JSON.parse(readFileSync(lk(dir), "utf8"))).toMatchObject({
        pid: process.pid,
        processStart,
      });
      expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
    },
  );

  it("keeps a live holder even if its wall-clock timestamp looks old", async () => {
    const dir = freshDir();
    const original = writeHolder(dir, processStart);
    kernelProbe.status = 73;
    await expect(
      acquirePgliteLock(dir, { waitMs: 0, takeover: false }),
    ).rejects.toThrow("already using");
    expect(readFileSync(lk(dir), "utf8")).toBe(original);
  });

  it("preserves exclusion between connection owners sharing one PID", async () => {
    const dir = freshDir();
    const first = createPgliteLock();
    const second = createPgliteLock();
    try {
      await first.acquire(dir, { waitMs: 0, takeover: false });
      const original = readFileSync(lk(dir), "utf8");
      kernelProbe.status = 73;
      await expect(
        second.acquire(dir, { waitMs: 0, takeover: false }),
      ).rejects.toThrow("already using");
      second.release();
      expect(readFileSync(lk(dir), "utf8")).toBe(original);
    } finally {
      first.release();
      second.release();
    }
  });

  it("parses process names containing spaces and parentheses", async () => {
    const dir = freshDir();
    procFiles.set(statPath, procStat("200", "api (worker) name"));
    writeHolder(dir, `${bootId}:100`);
    await acquirePgliteLock(dir, { waitMs: 0, takeover: false });
    expect(JSON.parse(readFileSync(lk(dir), "utf8")).processStart).toBe(
      processStart,
    );
  });

  it.each([
    ["unreadable process stat", statPath, new Error("EACCES")],
    ["unreadable boot ID", bootPath, new Error("EACCES")],
    ["missing stat fields", statPath, `${process.pid} (node) S`],
    ["invalid start time", statPath, procStat("unknown")],
    ["empty boot ID", bootPath, "\n"],
  ])(
    "keeps the lock when identity is unavailable: %s",
    async (_, path, value) => {
      const dir = freshDir();
      const original = writeHolder(dir, `${bootId}:100`);
      kernelProbe.status = 73;
      procFiles.set(path as string, value);
      await expect(
        acquirePgliteLock(dir, { waitMs: 0, takeover: false }),
      ).rejects.toThrow("already using");
      expect(readFileSync(lk(dir), "utf8")).toBe(original);
    },
  );

  it("keeps PID-only protection for legacy locks", async () => {
    const dir = freshDir();
    const original = writeHolder(dir, undefined, false);
    await expect(
      acquirePgliteLock(dir, { waitMs: 0, takeover: false }),
    ).rejects.toThrow("already using");
    expect(readFileSync(lk(dir), "utf8")).toBe(original);
  });

  it("does not escalate takeover to SIGKILL after the holder's PID is reused", async () => {
    const dir = freshDir();
    const pid = process.pid + 1_000_000;
    const holderStat = `/proc/${pid}/stat`;
    procFiles.set(holderStat, procStat("200"));
    writeFileSync(
      lk(dir),
      JSON.stringify({ pid, host: hostname(), processStart, kernelLock: true, pidNamespace: "pid:[101]" }),
    );
    kernelProbe.status = 73;
    const kill = vi.spyOn(process, "kill").mockImplementation((_, signal) => {
      if (signal === "SIGTERM") {
        procFiles.set(holderStat, procStat("300"));
        kernelProbe.status = 0;
      }
      return true;
    });
    await acquirePgliteLock(dir, { waitMs: 0, takeover: true });
    expect(kill.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([
      [pid, "SIGTERM"],
    ]);
    expect(JSON.parse(readFileSync(lk(dir), "utf8")).pid).toBe(process.pid);
  });

  it("never reclaims or signals an active owner in another PID namespace", async () => {
    const dir = freshDir();
    const pid = process.pid + 1_000_000;
    const original = JSON.stringify({ pid, host: hostname(), kernelLock: true,
      processStart: `${bootId}:100`, pidNamespace: "pid:[101]" });
    writeFileSync(lk(dir), original);
    procFiles.set(`/proc/${pid}/stat`, procStat("100"));
    kernelProbe.status = 73;
    procFiles.set("/proc/self/ns/pid", "pid:[202]");
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    await expect(acquirePgliteLock(dir, { waitMs: 0, takeover: true })).rejects.toThrow("already using");
    expect(readFileSync(lk(dir), "utf8")).toBe(original);
    expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
  });

  it("rejects overlapping acquisitions by one owner without releasing its pending guard", async () => {
    const dir = freshDir();
    const owner = createPgliteLock();
    kernelProbe.status = 73;
    const pending = owner.acquire(dir, { waitMs: 1000, pollMs: 1 });
    try {
      await expect(owner.acquire(dir)).rejects.toThrow("already holds or is acquiring");
      kernelProbe.status = 0;
      await pending;
      expect(JSON.parse(readFileSync(lk(dir), "utf8")).kernelLock).toBe(true);
    } finally {
      kernelProbe.status = 0;
      await pending;
      owner.release();
    }
  });

  it("does not trust a reused PID in an unmarked lock from an older version", async () => {
    const dir = freshDir();
    const original = writeHolder(dir, `${bootId}:100`, false);
    await expect(acquirePgliteLock(dir, { waitMs: 0, takeover: false })).rejects.toThrow("already using");
    expect(readFileSync(lk(dir), "utf8")).toBe(original);
  });

  it("preserves unpublished metadata while the kernel owner is active", async () => {
    const dir = freshDir();
    writeFileSync(lk(dir), "corrupted");
    kernelProbe.status = 73;
    await expect(acquirePgliteLock(dir, { waitMs: 0, takeover: false })).rejects.toThrow("kernel lock held");
    expect(readFileSync(lk(dir), "utf8")).toBe("corrupted");
  });

  it("does not create a guard when a failed worker never created a database lock", () => {
    const dir = freshDir();
    expect(() => releaseExitedWorkerLock(join(dir, "missing", "data"), "worker")).not.toThrow();
    expect(existsSync(join(dir, "missing"))).toBe(false);
  });

  it("does not remove an exited worker's record while a kernel owner still holds the guard", () => {
    const dir = freshDir();
    const original = writeHolder(dir, processStart);
    kernelProbe.status = 73;
    releaseExitedWorkerLock(dir, "previous-owner");
    expect(readFileSync(lk(dir), "utf8")).toBe(original);
  });

  it.each([
    ["missing utility", 0, Object.assign(new Error("missing flock"), { code: "ENOENT" })],
    ["unsupported filesystem", 69, undefined],
  ])("fails closed with %s", async (_, status, error) => {
    const dir = freshDir();
    kernelProbe.status = status;
    kernelProbe.error = error;
    await expect(acquirePgliteLock(dir, { waitMs: 0 })).rejects.toThrow("util-linux");
    expect(existsSync(lk(dir))).toBe(false);
    kernelProbe.status = 0;
    kernelProbe.error = undefined;
    await acquirePgliteLock(dir, { waitMs: 0 });
  });

  it("does not treat unavailable process identity as evidence of a stale owner on other platforms", async () => {
    vi.stubGlobal(
      "process",
      new Proxy(process, {
        get: (target, key, receiver) =>
          key === "platform" ? "darwin" : Reflect.get(target, key, receiver),
      }),
    );
    const dir = freshDir();
    const original = writeHolder(dir, `${bootId}:100`);
    await expect(
      acquirePgliteLock(dir, { waitMs: 0, takeover: false }),
    ).rejects.toThrow("already using");
    expect(readFileSync(lk(dir), "utf8")).toBe(original);
  });
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
