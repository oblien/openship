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
import { mkdtemp, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { RedisRdbProducer } from "./redis";
import type { BackupExecutor, ServiceHandle } from "../types";

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
async function dumpScript(): Promise<string> {
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
  const it = RedisRdbProducer.produce(service, executor, {})[Symbol.asyncIterator]();
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
): Promise<{ code: number; stdout: string; stderr: string }> {
  const dir = await mkdtemp(join(tmpdir(), "openship-redis-stub-"));
  const cli = join(dir, "redis-cli");
  await writeFile(
    cli,
    [
      "#!/bin/sh",
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

  return await new Promise((resolve) => {
    execFile(
      "/bin/sh",
      ["-c", script],
      {
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
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
}

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
    const res = await runScript(script.replace('-lt 300 ]', '-lt 2 ]'), {
      AFTER: "1000",
    });
    expect(res.code).toBe(94);
    expect(res.stderr).toMatch(/did not finish within 300s/);
    expect(res.stdout).toBe("");
  });
});
