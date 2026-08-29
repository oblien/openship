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
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
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
import { drive, FakeAttachStream, harness } from "./helpers/docker-helper-harness";

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
    // And the helper did not survive.
    expect(h.removals).toEqual([{ force: true }]);
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
    expect(h.removals).toEqual([{ force: true }]);
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
    expect(h.removals).toEqual([{ force: true }]);
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
    expect(h.removals).toEqual([{ force: true }]);
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
    expect(h.removals).toEqual([{ force: true }]);
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

    const res = spawnSync("/bin/sh", ["-c", script], {
      input: Buffer.from("not-a-real-archive"),
      env: { PATH: bin, TARGET: target },
    });

    expect(res.status).not.toBe(0);
    expect((res.stderr ?? Buffer.alloc(0)).toString()).toMatch(/zstd is not available/);
    // The whole point: the data is still there.
    expect(readdirSync(target)).toEqual(["precious.txt"]);
  });

  it("puts the tool check BEFORE the destructive clear, in the script itself", async () => {
    // Ordering is the invariant, and it is invisible at runtime until the day the tool is
    // missing. A future edit that moves the clear earlier passes every other test.
    const script = await helperScript("zstd");
    expect(script.indexOf("command -v zstd")).toBeGreaterThan(-1);
    expect(script.indexOf("find /mnt -mindepth 1 -delete")).toBeGreaterThan(-1);
    expect(script.indexOf("command -v zstd")).toBeLessThan(
      script.indexOf("find /mnt -mindepth 1 -delete"),
    );
  });

  it("reports the decompressor's failure rather than tar's success", async () => {
    // `safeRestoreCommand`'s dual-status idiom, on the direction where masking DESTROYS
    // data instead of merely losing a restore point.
    const script = await helperScript("zstd");
    expect(script).toMatch(/the decompressor .* failed with status/);
  });
});
