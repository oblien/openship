/**
 * #434: "restore hangs forever in `applying`".
 *
 * The public diagnosis blamed `stopService`, which opens with
 * `if (!service.containerId) return;` and cannot hang. The real unbounded await
 * was `helper.wait()` in receiveStream — `/containers/{id}/wait` is a long-poll,
 * ReceiveStreamOpts was the only opts type in the family with no timeout, and the
 * socket transport sets no modem timeout. With `AutoRemove: true` the daemon could
 * also reap the helper before that call answered, which is the `404 no such
 * container` in the issue.
 *
 * These tests pin the four things that make the hang impossible: the daemon is
 * asked directly whether the helper exited, silence is bounded, TRAFFIC IS NOT
 * (a legitimate multi-hour extract must not be strangled), and the helper is
 * reaped on every exit path.
 *
 * Fake timers throughout — the real defaults are 10 minutes and 6 hours.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const attach = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("../src/runtime/docker-exec-stream", () => ({
  startAttachStream: async () => attach.current,
  startExecStream: async () => attach.current,
  daemonConnectionFrom: () => ({}),
}));

import { DockerRuntime } from "../src/runtime/docker";
import type { ServiceHandle } from "../src/backup/types";
import {
  dockerFrame,
  drive,
  FakeAttachStream,
  harness as helperHarness,
} from "./helpers/docker-helper-harness";

function harness(
  script: Parameters<typeof helperHarness>[0],
  extras: Parameters<typeof helperHarness>[1] = () => ({}),
) {
  return helperHarness(script, (context) => ({
    logs: async () => {
      const bytes = (attach.current as FakeAttachStream).written.reduce(
        (n, chunk) => n + chunk.length,
        0,
      );
      return Readable.from([dockerFrame(1, `openship-restore-bytes: ${bytes}\n`)]);
    },
    ...extras(context),
  }));
}

const SERVICE: ServiceHandle = {
  id: "svc_1",
  projectId: "prj_1",
  name: "db",
  image: "postgres:16",
  env: {},
  // No containerId, so listSources uses the DB-declared volumes — the shape a
  // restore of a stopped or deployment-managed service actually takes.
  volumes: ["pgdata:/var/lib/postgresql/data"],
  containerId: null,
  projectSlug: "shop",
  namespaceVolumes: false,
};
const SOURCE_ID = "pgdata-0";

beforeEach(() => {
  vi.useFakeTimers();
  attach.current = new FakeAttachStream();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("receiveStream no longer depends on wait() answering", () => {
  it("completes from the exit poll when wait() hangs forever", async () => {
    // The #434 shape exactly: the long-poll never returns, but the container has
    // exited and the daemon will say so if asked.
    const h = harness({
      wait: "hang",
      inspect: [{ Running: true }, { Running: false, Status: "exited", ExitCode: 0 }],
    });
    const exec = await h.executor();

    const result = await drive(
      exec.receiveStream(SERVICE, SOURCE_ID, Readable.from([Buffer.from("archive-bytes")]), {
        compression: "none",
      }),
      30_000,
    );

    expect(result.bytesWritten).toBe("archive-bytes".length);
    expect(h.started()).toBe(true);
    // Extraction is reaped before the staging volume.
    expect(h.removals).toEqual([{ force: true }, { force: true, v: true }]);
  });

  it("does not poll before the archive has finished being written", async () => {
    // A helper that hasn't received all its stdin yet is *supposed* to be
    // running; inspecting on a loop there would be pure noise.
    const body = new Readable({ read() {} });
    const h = harness({
      wait: "hang",
      inspect: [{ Running: false, Status: "exited", ExitCode: 0 }],
    });
    const exec = await h.executor();

    const p = exec.receiveStream(SERVICE, SOURCE_ID, body, {
      compression: "none",
      idleTimeoutMs: 60_000,
    });
    p.catch(() => {});
    // Keep it alive but never end the body. inspect() would report the container
    // as already exited, so a poll running here would resolve the restore before
    // the archive had been fully written — data loss dressed up as success.
    for (let i = 0; i < 6; i++) {
      body.push(Buffer.from("chunk"));
      await vi.advanceTimersByTimeAsync(5_000);
    }
    expect(h.inspectCalls()).toBe(0);

    body.push(null);
    const result = await drive(p, 30_000);
    expect(result.bytesWritten).toBe("chunk".length * 6);
    expect(h.inspectCalls()).toBeGreaterThan(0);
  });

  it("reports a helper that vanished instead of assuming it succeeded", async () => {
    const h = harness({ wait: "hang", inspect: ["404"] });
    const exec = await h.executor();

    await expect(
      drive(
        exec.receiveStream(SERVICE, SOURCE_ID, Readable.from([Buffer.from("x")]), {
          compression: "none",
        }),
        30_000,
      ),
    ).rejects.toThrow(/disappeared before its exit status|partial data/);
  });

  it("still surfaces tar's own stderr on a non-zero exit", async () => {
    const stream = attach.current as FakeAttachStream;
    const h = harness({ wait: 2 });
    const exec = await h.executor();

    const p = exec.receiveStream(SERVICE, SOURCE_ID, Readable.from([Buffer.from("x")]), {
      compression: "none",
    });
    p.catch(() => {});
    stream.emitStderr("tar: can't create directory: Read-only file system\n");

    await expect(drive(p, 10_000)).rejects.toThrow(/Read-only file system/);
    expect(h.removals).toEqual([{ force: true, v: true }]);
  });

  it("reads the helper's log when the attach stream closed before any stderr arrived (#1417)", async () => {
    const log = Buffer.concat([
      dockerFrame(2, "zstd: Read error (39): premature end\n"),
      dockerFrame(2, "tar: short read\n"),
    ]);
    const h = harness({ wait: 1 }, () => ({
      logs: async () => Readable.from([log.subarray(0, 5), log.subarray(5, 13), log.subarray(13)]),
    }));
    const exec = await h.executor();

    const p = exec.receiveStream(SERVICE, SOURCE_ID, Readable.from([Buffer.from("x")]), {
      compression: "none",
    });
    p.catch(() => {});

    await expect(drive(p, 10_000)).rejects.toThrow(/premature end[\s\S]*tar: short read/);
    expect(h.removals).toEqual([{ force: true, v: true }]);
  });

  it("falls back when attach delivered a frame header without its stderr payload", async () => {
    const h = harness({ wait: 1 }, () => ({
      logs: async () => Readable.from([dockerFrame(2, "tar: short read\n")]),
    }));
    const exec = await h.executor();
    const p = exec.receiveStream(SERVICE, SOURCE_ID, Readable.from([Buffer.from("x")]), {
      compression: "none",
    });
    p.catch(() => {});
    (attach.current as FakeAttachStream).push(dockerFrame(2, "missing stderr").subarray(0, 8));
    await expect(drive(p, 5_000)).rejects.toThrow(
      /Restore helper exited with code 1: tar: short read/,
    );
    expect(h.removals).toEqual([{ force: true, v: true }]);
  });

  it.each([
    "diagnostic timeout",
    "disabled ceiling",
    "restore ceiling",
    "restore idle",
    "cancellation",
  ])("reports the helper failure and cleans up when log retrieval reaches %s", async (stop) => {
    let requestSignal: AbortSignal | undefined;
    const logs = vi.fn((opts: { abortSignal?: AbortSignal }) => {
      requestSignal = opts.abortSignal;
      return new Promise<Readable>(() => {});
    });
    const h = harness({ wait: 1 }, () => ({ logs }));
    const exec = await h.executor();
    const controller = new AbortController();
    let failure: Error | undefined;
    // Upload-idle cancellation applies while the source is still open. Once
    // EOF arrives, the log request has its own bound and the overall deadline.
    const body = stop === "restore idle"
      ? new Readable({ read() {} })
      : Readable.from([Buffer.from("x")]);
    if (stop === "restore idle") body.push(Buffer.from("x"));
    const p = exec.receiveStream(SERVICE, SOURCE_ID, body, {
      compression: "none",
      idleTimeoutMs: stop === "restore idle" ? 1_000 : 60_000,
      timeoutMs: stop === "restore ceiling" ? 1_000 : stop === "disabled ceiling" ? 0 : 60_000,
      signal: controller.signal,
    });
    void p.catch((error) => {
      failure = error;
    });
    await vi.advanceTimersByTimeAsync(750);
    expect(logs).toHaveBeenCalledOnce();
    if (stop === "cancellation") controller.abort();
    await vi.advanceTimersByTimeAsync(
      stop === "diagnostic timeout" || stop === "disabled ceiling" ? 3_000 : 500,
    );
    expect(failure?.message).toMatch(/Restore helper exited with code 1/);
    expect(requestSignal?.aborted).toBe(true);
    expect(h.removals).toEqual([{ force: true, v: true }]);
    expect((attach.current as FakeAttachStream).destroyed_).toBe(true);
  });

  it("bounds and closes a log response whose headers arrive but whose body stalls", async () => {
    const output = new Readable({ read() {} });
    const h = harness({ wait: 1 }, () => ({ logs: async () => output }));
    const exec = await h.executor();
    await expect(
      drive(
        exec.receiveStream(SERVICE, SOURCE_ID, Readable.from([Buffer.from("x")]), {
          compression: "none",
        }),
        5_000,
      ),
    ).rejects.toThrow(/Restore helper exited with code 1/);
    expect(output.destroyed).toBe(true);
    expect(h.removals).toEqual([{ force: true, v: true }]);
  });

  it("closes a diagnostic stream that arrives after the request has timed out", async () => {
    let reply!: (stream: Readable) => void;
    const h = harness({ wait: 1 }, () => ({
      logs: () =>
        new Promise<Readable>((resolve) => {
          reply = resolve;
        }),
    }));
    const exec = await h.executor();
    let failure: Error | undefined;
    const p = exec.receiveStream(SERVICE, SOURCE_ID, Readable.from([Buffer.from("x")]), {
      compression: "none",
    });
    void p.catch((error) => {
      failure = error;
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(failure?.message).toMatch(/Restore helper exited with code 1/);
    const output = new Readable({ read() {} });
    reply(output);
    await vi.advanceTimersByTimeAsync(0);
    expect(output.destroyed).toBe(true);
    expect(h.removals).toEqual([{ force: true, v: true }]);
  });

  it("stops reading oversized diagnostics without buffering the entire response", async () => {
    let produced = 0;
    const output = Readable.from(
      (async function* () {
        while (produced < 10_000) {
          produced++;
          yield dockerFrame(2, "tar: " + "x".repeat(4_096) + "\n");
        }
      })(),
      { highWaterMark: 1 },
    );
    const logs = vi.fn(async () => output);
    const h = harness({ wait: 1 }, () => ({ logs }));
    const exec = await h.executor();
    await expect(
      drive(
        exec.receiveStream(SERVICE, SOURCE_ID, Readable.from([Buffer.from("x")]), {
          compression: "none",
        }),
        5_000,
      ),
    ).rejects.toThrow(/Restore helper exited with code 1: x/);
    expect(logs).toHaveBeenCalledWith(expect.objectContaining({ follow: true, tail: 40 }));
    expect(produced).toBeGreaterThan(0);
    expect(produced).toBeLessThan(100);
    expect(output.destroyed).toBe(true);
    expect(h.removals).toEqual([{ force: true, v: true }]);
  });

  it("preserves the exit code when the daemon cannot provide helper logs", async () => {
    const h = harness({ wait: 1 }, () => ({
      logs: async () => {
        throw new Error("logging driver cannot read logs");
      },
    }));
    const exec = await h.executor();
    await expect(
      drive(
        exec.receiveStream(SERVICE, SOURCE_ID, Readable.from([Buffer.from("x")]), {
          compression: "none",
        }),
        5_000,
      ),
    ).rejects.toThrow(/^Restore helper exited with code 1$/);
    expect(h.removals).toEqual([{ force: true, v: true }]);
  });
});

describe("silence is bounded, traffic is not", () => {
  it("abandons a transfer that moves nothing for the idle window", async () => {
    const body = new Readable({ read() {} }); // never pushes, never ends
    const h = harness({ wait: "hang" });
    const exec = await h.executor();

    await expect(
      drive(
        exec.receiveStream(SERVICE, SOURCE_ID, body, {
          compression: "none",
          idleTimeoutMs: 5_000,
        }),
        30_000,
      ),
    ).rejects.toThrow(/moved no data for 5s/);
    // Named so an operator knows which restore and which volume.
    expect(h.removals).toEqual([{ force: true, v: true }]);
  });

  it("lets a slow but live transfer run far past the idle window", async () => {
    // The whole reason the watchdog is idle-based: this transfer takes 10× the
    // idle window and is perfectly healthy. A wall-clock bound would kill it.
    const body = new Readable({ read() {} });
    const h = harness({
      wait: "hang",
      inspect: [{ Running: false, Status: "exited", ExitCode: 0 }],
    });
    const exec = await h.executor();

    const p = exec.receiveStream(SERVICE, SOURCE_ID, body, {
      compression: "none",
      idleTimeoutMs: 5_000,
    });
    p.catch(() => {});
    for (let i = 0; i < 10; i++) {
      body.push(Buffer.from("keep-alive"));
      await vi.advanceTimersByTimeAsync(4_000); // under the window, every time
    }
    body.push(null);

    const result = await drive(p, 30_000);
    expect(result.bytesWritten).toBe("keep-alive".length * 10);
  });

  it("counts the helper's own output as traffic", async () => {
    // A `tar -x` that is slowly logging is alive even if stdin is briefly quiet.
    const stream = attach.current as FakeAttachStream;
    const body = new Readable({ read() {} });
    const h = harness({
      wait: "hang",
      inspect: [{ Running: false, Status: "exited", ExitCode: 0 }],
    });
    const exec = await h.executor();

    const p = exec.receiveStream(SERVICE, SOURCE_ID, body, {
      compression: "none",
      idleTimeoutMs: 5_000,
    });
    p.catch(() => {});
    body.push(Buffer.from("head"));
    for (let i = 0; i < 6; i++) {
      stream.emitOutput(`extracting ${i}\n`);
      await vi.advanceTimersByTimeAsync(4_000);
    }
    body.push(null);

    await expect(drive(p, 30_000)).resolves.toMatchObject({ bytesWritten: 4 });
  });

  it("enforces an absolute ceiling even while bytes keep flowing", async () => {
    const body = new Readable({ read() {} });
    const h = harness({ wait: "hang" });
    const exec = await h.executor();

    const p = exec.receiveStream(SERVICE, SOURCE_ID, body, {
      compression: "none",
      idleTimeoutMs: 60_000,
      timeoutMs: 10_000,
    });
    p.catch(() => {});
    for (let i = 0; i < 20; i++) {
      body.push(Buffer.from("trickle"));
      await vi.advanceTimersByTimeAsync(1_000);
    }

    await expect(drive(p, 30_000)).rejects.toThrow(/exceeded its 10s ceiling/);
  });

  it.each(["validation", "extraction"])(
    "allows local %s to outlast the upload idle window",
    async (phase) => {
      let waits = 0;
      const h = harness({ inspect: [{ Running: true }] }, () => ({
        wait: () => {
          const validating = waits++ === 0;
          const delay = validating === (phase === "validation") ? 8_000 : 500;
          return new Promise((resolve) => setTimeout(() => resolve({ StatusCode: 0 }), delay));
        },
      }));
      const exec = await h.executor();
      await expect(
        drive(
          exec.receiveStream(SERVICE, SOURCE_ID, Readable.from([Buffer.from("archive")]), {
            compression: "none",
            idleTimeoutMs: 5_000,
            timeoutMs: 20_000,
          }),
          25_000,
        ),
      ).resolves.toEqual({ bytesWritten: 7 });
      expect(h.removals).toEqual([{ force: true }, { force: true, v: true }]);
    },
  );

  it.each(["ceiling", "cancellation"])(
    "still stops a stalled local extraction on %s",
    async (stop) => {
      let waits = 0;
      const h = harness({ inspect: [{ Running: true }] }, () => ({
        wait: () => waits++ === 0
          ? new Promise((resolve) => setTimeout(() => resolve({ StatusCode: 0 }), 500))
          : new Promise(() => {}),
      }));
      const exec = await h.executor();
      const controller = new AbortController();
      const restoring = exec.receiveStream(SERVICE, SOURCE_ID, Readable.from([Buffer.from("archive")]), {
        compression: "none",
        idleTimeoutMs: 5_000,
        timeoutMs: 10_000,
        signal: controller.signal,
      });
      if (stop === "cancellation") setTimeout(() => controller.abort(), 6_000);
      await expect(drive(restoring, 15_000)).rejects.toThrow(
        stop === "cancellation" ? /cancelled/ : /exceeded.*ceiling/,
      );
      expect(h.removals).toEqual([{ force: true }, { force: true, v: true }]);
    },
  );
});

describe("the helper is always reaped", () => {
  it("does not ask the daemon to auto-remove it", async () => {
    const h = harness({ wait: 0 });
    const exec = await h.executor();

    await drive(
      exec.receiveStream(SERVICE, SOURCE_ID, Readable.from([Buffer.from("x")]), {
        compression: "none",
      }),
      10_000,
    );

    // AutoRemove is what raced wait() and produced the issue's 404.
    expect((h.created[0]!.HostConfig as { AutoRemove?: boolean }).AutoRemove).toBe(false);
    expect(h.removals).toEqual([{ force: true }, { force: true, v: true }]);
  });

  it("removes it even when the container never starts", async () => {
    // The leak AutoRemove never covered: it only fires for a container that
    // actually ran, so a throw between create and start leaked one permanently.
    const h = harness({ wait: 0 });
    const exec = await h.executor();
    const runtime = (exec as unknown as { runtime: DockerRuntime }).runtime;
    const original = runtime.docker.createContainer;
    runtime.docker.createContainer = (async (opts: Record<string, unknown>) => {
      const c = await (original as (o: unknown) => Promise<Record<string, unknown>>)(opts);
      c.start = async () => {
        throw new Error("driver failed to mount volume");
      };
      return c;
    }) as never;

    await expect(
      drive(
        exec.receiveStream(SERVICE, SOURCE_ID, Readable.from([Buffer.from("x")]), {
          compression: "none",
        }),
        10_000,
      ),
    ).rejects.toThrow(/driver failed to mount volume/);
    expect(h.removals).toEqual([{ force: true, v: true }]);
  });

  it("drops the attach socket before removing the container", async () => {
    const stream = attach.current as FakeAttachStream;
    const h = harness({ wait: 0 });
    const exec = await h.executor();

    await drive(
      exec.receiveStream(SERVICE, SOURCE_ID, Readable.from([Buffer.from("x")]), {
        compression: "none",
      }),
      10_000,
    );

    // A force-remove against a still-open attach is how you get a truncated
    // stream and an unexplained exit code.
    expect(stream.destroyed_).toBe(true);
  });
});

describe("a volume restore never destroys the target before it can write", () => {
  /** The helper `Cmd` the executor asked the daemon to run. */
  async function helperScript(compression: "zstd" | "gzip" | "none") {
    const h = harness({ wait: 0, inspect: [{ Running: false, Status: "exited", ExitCode: 0 }] });
    const exec = await h.executor();
    const p = exec.receiveStream(SERVICE, SOURCE_ID, Readable.from([Buffer.from("x")]), {
      compression,
      clearTarget: true,
    });
    p.catch(() => {});
    await drive(p, 10_000).catch(() => {});
    const cmd = (h.created[0] as { Cmd: string[] }).Cmd;
    expect(cmd[0]).toBe("sh");
    return cmd[2];
  }

  it("refuses to clear the volume when the decompressor is missing", async () => {
    // The worst bug in the module, and it was pre-existing. The helper ran
    // `apk add zstd >/dev/null 2>&1; find /mnt -delete; zstd -d -c | tar -x` — `apk`
    // joined with `;` and silenced, the target cleared BEFORE anything checked the tool
    // existed, and a shell pipeline reporting tar's status, where `tar -x` on EOF exits 0.
    // On a host with no egress (required only for this codec) that emptied the volume,
    // extracted nothing, and returned success — and `bytesWritten` is counted off the
    // BODY, so the caller saw a healthy byte count too. Strictly worse than #611: that
    // failed to take a backup; this deletes your data and reports a green restore.
    //
    // Asserted by RUNNING the generated script with no zstd on PATH, against a real
    // directory holding a real file, because the property is "the bytes survive" and no
    // amount of reading the string proves that.
    const script = (await helperScript("zstd")).replace(/\/mnt/g, "$TARGET");
    const target = mkdtempSync(join(tmpdir(), "openship-restore-"));
    const bin = mkdtempSync(join(tmpdir(), "openship-restore-bin-"));
    writeFileSync(join(target, "precious.txt"), "PRECIOUS");

    const res = spawnSync("/bin/sh", ["-ec", script], {
      input: Buffer.from("not-a-real-archive"),
      env: { PATH: bin, TARGET: target },
    });

    expect(res.status).not.toBe(0);
    expect((res.stderr ?? Buffer.alloc(0)).toString()).toMatch(/zstd is not available/);
    // The whole point: the data is still there.
    expect(readdirSync(target)).toEqual(["precious.txt"]);
  });

  it("never mounts the target while receiving or validating the archive", async () => {
    const h = harness({ wait: 0 });
    const exec = await h.executor();
    await drive(
      exec.receiveStream(SERVICE, SOURCE_ID, Readable.from([Buffer.from("x")]), {
        compression: "none",
        clearTarget: true,
      }),
      10_000,
    );
    expect(h.created).toHaveLength(2);
    expect(h.created[0]!.HostConfig).not.toHaveProperty("Binds");
    expect(h.created[0]!.Volumes).toEqual({ "/restore": {} });
    expect(h.created[1]!.HostConfig).toMatchObject({
      Binds: ["pgdata:/mnt"],
      VolumesFrom: ["helper_1:ro"],
    });
  });

  it("rejects a failed staged archive read even if tar accepts its output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openship-restore-read-failure-"));
    try {
      const input = join(dir, "input");
      const stage = join(dir, "stage");
      const bin = join(dir, "bin");
      for (const path of [input, stage, bin]) mkdirSync(path);
      writeFileSync(join(input, "file"), "valid archive contents");
      const archive = spawnSync("tar", ["-cf", "-", "-C", input, "file"]);
      expect(archive.status).toBe(0);
      // Upload succeeds. Reading the staged file emits valid tar data, then
      // fails: tar's exit status alone cannot establish a successful read.
      writeFileSync(join(bin, "cat"), '#!/bin/sh\n/bin/cat "$@"\nif [ "$#" -gt 0 ]; then exit 23; fi\n', { mode: 0o755 });
      const script = (await helperScript("none")).replaceAll("/restore", stage);
      const result = spawnSync("/bin/sh", ["-ec", script], {
        input: archive.stdout,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      });
      expect(result.status).toBe(23);
      expect(result.stderr.toString()).toContain("staged archive read failed with status 23");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts valid tar padding larger than the validation pipe buffer", async () => {
    const stage = mkdtempSync(join(tmpdir(), "openship-restore-padding-"));
    try {
      const script = (await helperScript("none")).replaceAll("/restore", stage);
      const result = spawnSync("/bin/sh", ["-ec", script], {
        // An empty tar followed by zero padding remains a valid archive.
        input: Buffer.alloc(1024 * 1024),
      });
      expect(result.status, result.stderr.toString()).toBe(0);
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  });

  it("fails promptly on source failure without creating an extraction helper", async () => {
    const h = harness({ wait: "hang" });
    const exec = await h.executor();
    const body = Readable.from(
      (async function* () {
        yield Buffer.from("partial tar");
        throw new Error("source disconnected");
      })(),
    );
    await expect(
      drive(
        exec.receiveStream(SERVICE, SOURCE_ID, body, {
          compression: "none",
          clearTarget: true,
        }),
        5_000,
      ),
    ).rejects.toThrow("source disconnected");
    expect(h.created).toHaveLength(1);
    expect(h.created[0]!.HostConfig).not.toHaveProperty("Binds");
    expect(h.removals).toEqual([{ force: true, v: true }]);
  });

  it("refuses a successful tar receipt when the transport lost complete archive members", async () => {
    const h = harness({ wait: 0 }, () => ({
      logs: async () => Readable.from([dockerFrame(1, "openship-restore-bytes: 1024\n")]),
    }));
    const exec = await h.executor();
    await expect(
      drive(
        exec.receiveStream(SERVICE, SOURCE_ID, Readable.from([Buffer.alloc(2048)]), {
          compression: "none",
          clearTarget: true,
        }),
        10_000,
      ),
    ).rejects.toThrow("transfer was incomplete");
    expect(h.created).toHaveLength(1);
    expect(h.created[0]!.HostConfig).not.toHaveProperty("Binds");
  });

  it("also bounds preparation of a bind-file target when Docker wait does not answer", async () => {
    const h = harness({ wait: "hang", inspect: [{ Running: false, ExitCode: 0 }] });
    const exec = await h.executor();
    const service = { ...SERVICE, volumes: ["/tmp/openship-test-settings:/app/settings"] };
    vi.spyOn(exec, "listSources").mockResolvedValue([
      {
        id: "settings",
        type: "bind",
        source: "/tmp/openship-test-settings",
        target: "/app/settings",
        isDirectory: false,
      },
    ]);
    await expect(
      drive(
        exec.receiveStream(service, "settings", Readable.from([Buffer.from("x")]), {
          compression: "none",
          sourceIsFile: true,
        }),
        30_000,
      ),
    ).resolves.toMatchObject({ bytesWritten: 1 });
    expect(h.created).toHaveLength(3);
    expect(h.removals).toHaveLength(3);
  });

  it("reports the decompressor's failure rather than tar's success", async () => {
    // `safeRestoreCommand`'s dual-status idiom, on the direction where masking DESTROYS
    // data instead of merely losing a restore point.
    const script = await helperScript("zstd");
    expect(script).toMatch(/the decompressor .* failed with status/);
  });
});
