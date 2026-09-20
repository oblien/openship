/**
 * The Redis capture used to archive a STALE dump.rdb and report a green backup: it
 * polled LASTSAVE 60 times, `break`ed out either way, and `cat`ted the file regardless.
 * Three different situations landed there — a save slower than the wait, a wrong
 * password (which makes both LASTSAVE calls fail identically, so the timestamp "never
 * changes"), and a save Redis started but could not finish. The artifact was valid,
 * restorable, and old, which is the one shape neither the zero-byte guard nor the
 * integrity hash can catch.
 *
 * So these run the GENERATED SCRIPT under a real `/bin/sh` against a stub `redis-cli`,
 * rather than asserting on its text. The failure being fixed was a shell-semantics one
 * (`break` in the wrong place), and a substring assertion would have passed against the
 * broken version too.
 */

import { execFile } from "node:child_process";
import { mkdtemp, writeFile, chmod, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { RedisRdbProducer } from "./redis";
import type { ArtifactRef, BackupExecutor, ServiceHandle } from "../types";

const service = {
  id: "svc_1",
  projectId: "prj_1",
  projectSlug: "app",
  name: "cache",
  image: "redis:7",
  env: {},
  volumes: ["redisdata:/data"],
  containerId: "ctr_1",
} as unknown as ServiceHandle;

/** The `sh -c` script the producer would run in the container. */
async function dumpScript(target: ServiceHandle = service): Promise<string> {
  const cmds: string[][] = [];
  const executor = {
    execStream: async (_s: ServiceHandle, cmd: string[]) => {
      cmds.push(cmd);
      return {
        stdout: Readable.from([]),
        awaitExit: Promise.resolve({ code: 0, stderr: "" }),
      };
    },
  } as unknown as BackupExecutor;

  // One `next()` is enough: the artifact is yielded before the exit is awaited.
  const it = RedisRdbProducer.produce(target, executor, {})[Symbol.asyncIterator]();
  await it.next();
  // [0] is the codec probe (answers nothing → "none", so the dump is not piped).
  const dump = cmds[1];
  expect(dump?.slice(0, 2)).toEqual(["sh", "-c"]);
  return dump[2] as string;
}

/**
 * A `redis-cli` (and `cat`) stub on PATH, driven by env. `LASTSAVE` answers `BEFORE`
 * until BGSAVE is called and `AFTER` afterwards, which is exactly the signal the
 * producer is supposed to be reading.
 */
async function runScript(
  script: string,
  env: Record<string, string>,
  cliName = "redis-cli",
): Promise<{ code: number; stdout: string; stderr: string }> {
  const dir = await mkdtemp(join(tmpdir(), "openship-redis-stub-"));
  const cli = join(dir, cliName);
  await writeFile(
    cli,
    [
      "#!/bin/sh",
      '[ -n "$EXPECT_PASSWORD" ] && [ "$2" != "$EXPECT_PASSWORD" ] && { echo NOAUTH; exit 1; }',
      // Every real redis-cli 4+ prints this on stderr when -a is used. Folding it into
      // the timestamp is the regression this stub exists to catch.
      '[ -n "$WARN" ] && echo "Warning: Using a password with \'-a\' may not be safe." >&2',
      'case "$*" in',
      "  *LASTSAVE*)",
      '    [ -n "$AUTH_FAIL" ] && { echo "NOAUTH Authentication required."; exit 1; }',
      '    if [ -f "$STATE/bgsave" ]; then echo "$AFTER"; else echo "$BEFORE"; fi ;;',
      "  *BGSAVE*)",
      '    [ -z "$NO_START" ] && : > "$STATE/bgsave"',
      '    echo "${BGSAVE_REPLY:-Background saving started}"',
      '    exit "${BGSAVE_EXIT:-0}" ;;',
      "  *INFO*)",
      '    printf "%s\\n" "$INFO_OUT" ;;',
      "esac",
      "exit 0",
    ].join("\n"),
  );
  await chmod(cli, 0o755);
  const cat = join(dir, "cat");
  await writeFile(cat, "#!/bin/sh\nprintf RDBDATA\n");
  await chmod(cat, 0o755);

  // Keep command discovery inside this fixture; a host-installed database CLI
  // must never be selected when exercising the Valkey-only image shape.
  for (const [name, source] of Object.entries({
    tr: "/usr/bin/tr",
    grep: "/usr/bin/grep",
    tail: "/usr/bin/tail",
    sleep: "/bin/sleep",
  }))
    await symlink(source, join(dir, name));

  try {
    return await new Promise((resolve) => {
      execFile(
        "/bin/sh",
        ["-c", script],
        {
          env: {
            ...process.env,
            PATH: dir,
            STATE: dir,
            BEFORE: "1000",
            AFTER: "2000",
            INFO_OUT: "rdb_bgsave_in_progress:1\nrdb_last_bgsave_status:ok",
            ...env,
          },
        },
        (err, stdout, stderr) => {
          const code = err ? ((err as { code?: number }).code ?? 1) : 0;
          resolve({ code, stdout: String(stdout), stderr: String(stderr) });
        },
      );
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("Valkey uses the existing Redis backup path", () => {
  const valkey: ServiceHandle = {
    ...service,
    image: "valkey/valkey:8.1-alpine",
    env: { VALKEY_PASSWORD: "audit's password $value" },
  };

  it("selects the RDB producer only when the service can execute commands", () => {
    expect(RedisRdbProducer.detects(valkey)).toBe(true);
    expect(RedisRdbProducer.detects({ ...valkey, containerId: null })).toBe(false);
    expect(RedisRdbProducer.detects({ ...valkey, containerRunning: false })).toBe(false);
  });

  it.each([undefined, ""])(
    "authenticates with VALKEY_PASSWORD when REDIS_PASSWORD is %s",
    async (redisPassword) => {
      const target = {
        ...valkey,
        env: {
          ...valkey.env,
          ...(redisPassword === undefined ? {} : { REDIS_PASSWORD: redisPassword }),
        },
      };
      const result = await runScript(
        await dumpScript(target),
        { EXPECT_PASSWORD: valkey.env.VALKEY_PASSWORD },
        "valkey-cli",
      );
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toBe("RDBDATA");
    },
  );

  it("retains the AOF restore refusal before writing any snapshot bytes", async () => {
    const execStream = vi.fn(async () => ({
      stdout: Readable.from(["appendonly\nyes\n"]),
      awaitExit: Promise.resolve({ code: 0, stderr: "" }),
    }));
    await expect(
      RedisRdbProducer.restore(
        valkey,
        { execStream } as unknown as BackupExecutor,
        {} as ArtifactRef,
        {},
      ),
    ).rejects.toThrow(/AOF persistence enabled/);
    expect(execStream).toHaveBeenCalledTimes(1);
  });
});

describe("RDB restore verifies persistence before writing", () => {
  const probe = (output: string, code = 0) => ({
    stdout: Readable.from([output]),
    awaitExit: Promise.resolve({ code, stderr: "" }),
  });

  function restoreWith(...responses: ReturnType<typeof probe>[]) {
    const open = vi.fn(async () => Readable.from(["snapshot"]));
    const artifact = { metadata: { compression: "none" }, open } as unknown as ArtifactRef;
    const execStream = vi.fn(async () => responses.shift()!);
    const pipeIntoCommand = vi.fn(async (_s, _cmd, body) => {
      const chunks: Buffer[] = [];
      for await (const chunk of body) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).toString()).toBe("snapshot");
      return { code: 0, stderr: "" };
    });
    const executor = { execStream, pipeIntoCommand } as unknown as BackupExecutor;
    return {
      open,
      execStream,
      pipeIntoCommand,
      run: () => RedisRdbProducer.restore(service, executor, artifact, {}),
    };
  }

  it.each([
    ["", 0],
    ["NOAUTH Authentication required.\n", 0],
    ["appendonly\nno\nextra\n", 0],
    ["appendonly\nno\n", 1],
    [`${"x".repeat(4096)}appendonly\nno\n`, 0],
  ])("refuses an unverified AOF response (%j, exit %i)", async (output, code) => {
    const restore = restoreWith(probe(output, code));
    await expect(restore.run()).rejects.toThrow(/Could not verify/);
    expect(restore.execStream).toHaveBeenCalledTimes(1);
    expect(restore.open).not.toHaveBeenCalled();
    expect(restore.pipeIntoCommand).not.toHaveBeenCalled();
  });

  it("refuses a probe whose output stream fails", async () => {
    const stdout = new PassThrough();
    const restore = restoreWith({ ...probe(""), stdout });
    const pending = expect(restore.run()).rejects.toThrow(/Could not verify/);
    stdout.destroy(new Error("connection lost"));
    await pending;
    expect(restore.open).not.toHaveBeenCalled();
    expect(restore.pipeIntoCommand).not.toHaveBeenCalled();
  });

  it("bounds the command exit as well as the output stream", async () => {
    vi.useFakeTimers();
    try {
      const restore = restoreWith({
        ...probe("appendonly\nno\n"),
        awaitExit: new Promise(() => {}),
      });
      const pending = expect(restore.run()).rejects.toThrow(/Could not verify/);
      await vi.advanceTimersByTimeAsync(30_001);
      await pending;
      expect(restore.open).not.toHaveBeenCalled();
      expect(restore.pipeIntoCommand).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["NOPERM", 0],
    ["", 0],
    ["OK\n", 1],
  ])(
    "refuses to write if disabling snapshots is unconfirmed (%j, exit %i)",
    async (output, code) => {
      const restore = restoreWith(
        probe("appendonly\nno\n"), probe("save\n3600 1\n"), probe(output, code), probe("OK\n"),
      );
      await expect(restore.run()).rejects.toThrow(/Could not disable/);
      expect(restore.open).not.toHaveBeenCalled();
      expect(restore.pipeIntoCommand).not.toHaveBeenCalled();
    },
  );

  it("writes the snapshot only after both persistence checks succeed", async () => {
    const restore = restoreWith(probe("appendonly\r\nno\r\n"), probe("save\r\n3600 1\r\n"), probe("OK\n"));
    await restore.run();
    expect(restore.execStream).toHaveBeenCalledTimes(3);
    expect(restore.open).toHaveBeenCalledTimes(1);
    expect(restore.pipeIntoCommand).toHaveBeenCalledTimes(1);
  });

  it.each(["", "NOPERM\n", "save\ninvalid\n", "save\n3600 1\nextra\n"])(
    "refuses unverified snapshot settings (%j) before disabling them",
    async (output) => {
      const restore = restoreWith(probe("appendonly\nno\n"), probe(output));
      await expect(restore.run()).rejects.toThrow(/Could not read/);
      expect(restore.execStream).toHaveBeenCalledTimes(2);
      expect(restore.open).not.toHaveBeenCalled();
    },
  );

  it("accepts an empty automatic snapshot schedule", async () => {
    const restore = restoreWith(probe("appendonly\nno\n"), probe("save\n\n"), probe("OK\n"));
    await restore.run();
    expect(restore.pipeIntoCommand).toHaveBeenCalledOnce();
  });

  it("reports when a failed artifact open also cannot restore snapshot settings", async () => {
    const restore = restoreWith(
      probe("appendonly\nno\n"), probe("save\n3600 1\n"), probe("OK\n"), probe("NOPERM\n"),
    );
    restore.open.mockRejectedValueOnce(new Error("backup is unavailable"));
    await expect(restore.run()).rejects.toThrow(/Reapply the service's save configuration/);
    expect(restore.pipeIntoCommand).not.toHaveBeenCalled();
  });

  it("keeps snapshots disabled after a possible partial write until the service restarts", async () => {
    const restore = restoreWith(probe("appendonly\nno\n"), probe("save\n3600 1\n"), probe("OK\n"));
    restore.pipeIntoCommand.mockRejectedValueOnce(new Error("write interrupted"));
    await expect(restore.run()).rejects.toThrow("write interrupted");
    expect(restore.execStream).toHaveBeenCalledTimes(3);
  });

  it.each(["artifact-open", "save-reply", "save-transport"])(
    "preserves automatic snapshots after a pre-write failure (%s)", async (failure) => {
      let save = "3600 1 300 100 60 10000";
      const initialSave = save;
      const transportError = new Error("Redis connection lost after applying CONFIG SET");
      const executor = {
        execStream: vi.fn(async (_service, command: string[]) => {
          const script = command[2]!;
          if (script.includes("CONFIG GET appendonly")) return probe("appendonly\nno\n");
          if (script.includes("CONFIG GET save")) return probe(`save\n${save}\n`);
          if (script.includes("CONFIG SET save")) {
            save = script.includes(initialSave) ? initialSave : "";
            if (!save && failure === "save-reply") return probe("");
            if (!save && failure === "save-transport") throw transportError;
            return probe("OK\n");
          }
          throw new Error("Unexpected Redis command");
        }),
        pipeIntoCommand: vi.fn(),
      };
      const openError = new Error("backup is unavailable");
      await expect(RedisRdbProducer.restore(service, executor as unknown as BackupExecutor, {
        metadata: { compression: "none" },
        open: async () => { throw openError; },
      } as unknown as ArtifactRef, {})).rejects.toThrow(
        failure === "artifact-open" ? openError : failure === "save-transport" ? transportError : /Could not disable/,
      );
      expect(save).toBe(initialSave);
      expect(executor.pipeIntoCommand).not.toHaveBeenCalled();
  });
});

describe("redis capture proves BGSAVE actually ran", () => {
  it("captures when LASTSAVE advances", async () => {
    const res = await runScript(await dumpScript(), {});
    expect(res.code).toBe(0);
    expect(res.stdout).toBe("RDBDATA");
  });

  it("is not fooled by redis-cli's own auth warning", async () => {
    // The warning arrives on stderr for EVERY call, so a `2>&1` capture reads
    // "Warning: …\n2000" as the timestamp — non-numeric, and every password-protected
    // Redis would fail to back up.
    const res = await runScript(await dumpScript(), { WARN: "1" });
    expect(res.code).toBe(0);
    // And the prelude's chatter stays out of the artifact.
    expect(res.stdout).toBe("RDBDATA");
  });

  it("refuses when LASTSAVE cannot be read at all", async () => {
    const res = await runScript(await dumpScript(), { AUTH_FAIL: "1" });
    expect(res.code).toBe(91);
    expect(res.stderr).toMatch(/could not read Redis LASTSAVE/);
    expect(res.stdout).toBe("");
  });

  it("refuses when Redis will not start a save", async () => {
    const res = await runScript(await dumpScript(), {
      NO_START: "1",
      BGSAVE_REPLY: "ERR DUMP payload version or checksum are wrong",
      BGSAVE_EXIT: "1",
    });
    expect(res.code).toBe(92);
    expect(res.stderr).toMatch(/would not start a background save/);
    expect(res.stdout).toBe("");
  });

  it("accepts a save that was already running", async () => {
    // That reply contains ERR but is not a failure — the running save advances
    // LASTSAVE, which is the only thing the capture actually needs.
    const res = await runScript(await dumpScript(), {
      BGSAVE_REPLY: "ERR Background save already in progress",
      BGSAVE_EXIT: "1",
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toBe("RDBDATA");
  });

  it("does not read Redis's OTHER 'in progress' error as a running save", async () => {
    // "Can't BGSAVE while AOF log rewriting is in progress" means no save was started.
    // A glob that matched the phrase alone waved it through, and the capture then spent
    // the whole window polling for a timestamp nothing was going to move.
    const res = await runScript(await dumpScript(), {
      NO_START: "1",
      BGSAVE_REPLY: "ERR Can't BGSAVE while AOF log rewriting is in progress",
      BGSAVE_EXIT: "1",
    });
    expect(res.code).toBe(92);
    expect(res.stdout).toBe("");
  });

  it("refuses as soon as Redis reports the save FAILED", async () => {
    const res = await runScript(await dumpScript(), {
      AFTER: "1000", // never advances
      INFO_OUT: "rdb_bgsave_in_progress:0\nrdb_last_bgsave_status:err",
    });
    expect(res.code).toBe(93);
    expect(res.stderr).toMatch(/background save FAILED/);
    expect(res.stdout).toBe("");
  });

  it("refuses when the save never lands inside the window", async () => {
    const script = await dumpScript();
    // The real window is 300s — pinned here, then shortened so the test does not sit
    // through it. Nothing else about the loop changes.
    expect(script).toContain('[ "$i" -lt 300 ]');
    const res = await runScript(script.replace("-lt 300 ]", "-lt 2 ]"), {
      AFTER: "1000",
    });
    expect(res.code).toBe(94);
    expect(res.stderr).toMatch(/did not finish within 300s/);
    expect(res.stdout).toBe("");
  });
});
