/**
 * The capture direction of #434's fix.
 *
 * Restore got an idle watchdog, an exit poll and a 6h ceiling; capture kept a
 * flat 1h wall clock and no idle bound at all. That asymmetry is worse than
 * either bound alone: a volume large enough to need hours to restore could not
 * be backed up in the first place, and a wedged `tar -c` still burned the full
 * hour before anyone heard about it. Both directions now go through
 * `awaitHelperExit` with the same pair of defaults.
 *
 * These tests pin that: silence is bounded (at the caller's window, and at the
 * same 10-minute default restore uses), traffic is not, the ceiling still
 * applies, and the helper is reaped whether the hand-off succeeds or throws.
 * That `idleTimeoutMs`/`timeoutMs` are passed here as plain `StreamPathOpts` is
 * itself the regression test for the `as ExecuteCommandOpts` cast that used to
 * read an undeclared option off that object.
 *
 * Fake timers throughout — the real defaults are 10 minutes and 6 hours.
 */

import type { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ServiceHandle } from "../src/backup/types";
import { drive, FakeAttachStream, harness } from "./helpers/docker-helper-harness";

const SERVICE: ServiceHandle = {
  id: "svc_1",
  projectId: "prj_1",
  name: "db",
  image: "postgres:16",
  env: {},
  volumes: ["pgdata:/var/lib/postgresql/data"],
  containerId: null,
  projectSlug: "shop",
  namespaceVolumes: false,
};
const SOURCE_ID = "pgdata-0";

/** A helper whose `attach()` hands back `stream`, plus the `modem.demuxStream`
 *  the executor demuxes it with. Framing is docker's job, not the code under
 *  test, so the fake forwards stdout verbatim and exposes the stderr sink for
 *  tests that need tar's complaints. */
function captureHarness(
  script: Parameters<typeof harness>[0],
  stream: FakeAttachStream,
  opts: { attachFails?: Error } = {},
) {
  let sinks: { out: Writable; err: Writable } | null = null;
  const h = harness(script, () => ({
    attach: async () => {
      if (opts.attachFails) throw opts.attachFails;
      return stream;
    },
    modem: {
      demuxStream: (src: FakeAttachStream, out: Writable, err: Writable) => {
        sinks = { out, err };
        src.on("data", (chunk: Buffer) => out.write(chunk));
      },
    },
  }));
  return { ...h, stderrSink: () => sinks?.err };
}

/** Consume stdout the way a producer does, and swallow its error event — the
 *  executor destroys stdout on failure so a caller piping the archive somewhere
 *  learns about it there too. */
function collect(stdout: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  stdout.on("data", (c: Buffer) => chunks.push(c));
  stdout.on("error", () => {});
  return () => Buffer.concat(chunks).toString("utf8");
}

let stream: FakeAttachStream;

beforeEach(() => {
  vi.useFakeTimers();
  stream = new FakeAttachStream();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("silence is bounded, traffic is not", () => {
  it("abandons a capture that produces nothing for the idle window", async () => {
    const h = captureHarness({ wait: "hang" }, stream);
    const exec = await h.executor();

    const { stdout, awaitExit } = await exec.streamPath(SERVICE, SOURCE_ID, {
      compression: "none",
      idleTimeoutMs: 5_000,
    });
    const read = collect(stdout);

    await expect(drive(awaitExit, 30_000)).rejects.toThrow(
      /produced no data for 5s.*archive is incomplete and was not kept/s,
    );
    expect(read()).toBe("");
    expect(h.removals).toEqual([{ force: true }]);
  });

  it("uses the same 10-minute idle default as restore when the caller sets none", async () => {
    // The asymmetry this whole change exists to remove: capture's only bound was
    // an hour of wall clock, so a stuck tar sat there for an hour and a healthy
    // one was killed at the same mark.
    const h = captureHarness({ wait: "hang" }, stream);
    const exec = await h.executor();

    const { stdout, awaitExit } = await exec.streamPath(SERVICE, SOURCE_ID, {
      compression: "none",
    });
    collect(stdout);

    await expect(drive(awaitExit, 11 * 60_000, 5_000)).rejects.toThrow(/no data for 600s/);
  });

  it("lets a slow but live capture run far past the idle window", async () => {
    // 40s of work against a 5s idle window: healthy, and a wall-clock bound of
    // any value tight enough to catch a hang would have killed it.
    const h = captureHarness(
      { wait: "hang", inspect: [{ Running: false, Status: "exited", ExitCode: 0 }] },
      stream,
    );
    const exec = await h.executor();

    const { stdout, awaitExit } = await exec.streamPath(SERVICE, SOURCE_ID, {
      compression: "none",
      idleTimeoutMs: 5_000,
    });
    const read = collect(stdout);
    awaitExit.catch(() => {});

    // Wait first, then emit, so the archive closes on a fresh byte: with a 5s
    // window the watchdog is only ~2 poll intervals wide, which the real 10min
    // default never is. Ending 4s into the window would race the exit poll.
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(4_000); // under the window, every time
      stream.emitOutput("tar-bytes.");
    }
    // Still mid-archive: reaping here would truncate the tar.
    expect(h.removals).toEqual([]);
    stream.finish();

    await expect(drive(awaitExit, 30_000)).resolves.toMatchObject({ code: 0 });
    expect(read()).toBe("tar-bytes.".repeat(10));
    expect(h.removals).toEqual([{ force: true }]);
  });

  it("enforces an absolute ceiling even while bytes keep flowing", async () => {
    const h = captureHarness({ wait: "hang" }, stream);
    const exec = await h.executor();

    const { stdout, awaitExit } = await exec.streamPath(SERVICE, SOURCE_ID, {
      compression: "none",
      idleTimeoutMs: 60_000,
      timeoutMs: 10_000,
    });
    collect(stdout);
    awaitExit.catch(() => {});

    for (let i = 0; i < 20; i++) {
      stream.emitOutput("trickle");
      await vi.advanceTimersByTimeAsync(1_000);
    }

    await expect(drive(awaitExit, 30_000)).rejects.toThrow(/exceeded its 10s ceiling/);
    expect(h.removals).toEqual([{ force: true }]);
  });
});

describe("streamPath no longer depends on wait() answering", () => {
  it("completes from the exit poll when wait() hangs forever", async () => {
    const h = captureHarness(
      {
        wait: "hang",
        inspect: [{ Running: true }, { Running: false, Status: "exited", ExitCode: 0 }],
      },
      stream,
    );
    const exec = await h.executor();

    const { stdout, awaitExit } = await exec.streamPath(SERVICE, SOURCE_ID, {
      compression: "none",
    });
    const read = collect(stdout);
    awaitExit.catch(() => {});
    stream.emitOutput("archive");
    stream.finish();

    await expect(drive(awaitExit, 30_000)).resolves.toMatchObject({ code: 0 });
    expect(read()).toBe("archive");
  });

  it("does not poll while the archive is still streaming", async () => {
    // A helper mid-`tar -c` is supposed to be running; a poll that answered here
    // would report a complete archive with bytes still buffered.
    const h = captureHarness(
      { wait: "hang", inspect: [{ Running: false, Status: "exited", ExitCode: 0 }] },
      stream,
    );
    const exec = await h.executor();

    const { stdout, awaitExit } = await exec.streamPath(SERVICE, SOURCE_ID, {
      compression: "none",
      idleTimeoutMs: 60_000,
    });
    collect(stdout);
    awaitExit.catch(() => {});

    for (let i = 0; i < 6; i++) {
      stream.emitOutput("chunk");
      await vi.advanceTimersByTimeAsync(5_000);
    }
    expect(h.inspectCalls()).toBe(0);

    stream.finish();
    await expect(drive(awaitExit, 30_000)).resolves.toMatchObject({ code: 0 });
    expect(h.inspectCalls()).toBeGreaterThan(0);
  });

  it("reports a helper that vanished instead of assuming the archive is whole", async () => {
    const h = captureHarness({ wait: "hang", inspect: ["404"] }, stream);
    const exec = await h.executor();

    const { stdout, awaitExit } = await exec.streamPath(SERVICE, SOURCE_ID, {
      compression: "none",
    });
    collect(stdout);
    awaitExit.catch(() => {});
    stream.emitOutput("partial");
    stream.finish();

    await expect(drive(awaitExit, 30_000)).rejects.toThrow(
      /disappeared before its exit status.*was not kept/s,
    );
  });

  it("surfaces tar's own stderr alongside a non-zero exit", async () => {
    const h = captureHarness({ wait: 2 }, stream);
    const exec = await h.executor();

    const { stdout, awaitExit } = await exec.streamPath(SERVICE, SOURCE_ID, {
      compression: "none",
    });
    collect(stdout);
    awaitExit.catch(() => {});
    h.stderrSink()?.write(Buffer.from("tar: /mnt/x: Permission denied\n"));

    // The producer, not the executor, decides a non-zero tar is fatal — so this
    // resolves with the evidence rather than throwing.
    await expect(drive(awaitExit, 10_000)).resolves.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("Permission denied"),
    });
  });
});

describe("the capture helper is always reaped", () => {
  it("removes it when the hand-off throws before anything owns it", async () => {
    // handOffHelper's whole reason to exist: between createContainer and the
    // return there is a window where the container exists and nothing
    // downstream knows it does. AutoRemove cannot cover it — it only fires for a
    // container that actually started.
    const h = captureHarness({ wait: 0 }, stream, {
      attachFails: new Error("cannot attach to a stopped container"),
    });
    const exec = await h.executor();

    await expect(
      exec.streamPath(SERVICE, SOURCE_ID, { compression: "none" }),
    ).rejects.toThrow(/cannot attach/);
    expect(h.removals).toEqual([{ force: true }]);
    expect(h.started()).toBe(false);
  });

  it("keeps the archive network-isolated when it needs no registry", async () => {
    // gzip/none are busybox built-ins; only zstd is apk-added at runtime.
    const h = captureHarness({ wait: 0 }, stream);
    const exec = await h.executor();

    const { stdout, awaitExit } = await exec.streamPath(SERVICE, SOURCE_ID, {
      compression: "none",
    });
    collect(stdout);
    awaitExit.catch(() => {});
    stream.finish();
    await drive(awaitExit, 10_000);

    expect(h.created[0]).toMatchObject({ NetworkDisabled: true });
    expect((h.created[0]!.HostConfig as { AutoRemove?: boolean }).AutoRemove).toBe(false);
  });
});
