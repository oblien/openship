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

import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ServiceHandle } from "../src/backup/types";
import { drive, FakeAttachStream, harness } from "./helpers/docker-helper-harness";

/** Set by captureHarness before each executor call; read by the module mock below. */
const attachControl = vi.hoisted(() => ({
  stream: null as unknown,
  fails: null as Error | null,
  calls: 0,
}));

vi.mock("../src/runtime/docker-exec-stream", () => ({
  daemonConnectionFrom: () => ({ socketPath: "/var/run/docker.sock" }),
  startAttachStream: async () => {
    if (attachControl.fails) throw attachControl.fails;
    attachControl.calls += 1;
    return attachControl.stream;
  },
  startExecStream: async () => {
    if (attachControl.fails) throw attachControl.fails;
    return attachControl.stream;
  },
}));

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

/**
 * A helper whose attach hands back `stream`.
 *
 * Two stand-ins are gone. There is no `modem.demuxStream` fake — the executor demuxes
 * the frame protocol itself now, so the fake speaks it (`emitOutput`/`emitStderr`) and
 * the demuxer under test is the real one, backpressure included. And the attach is no
 * longer `helper.attach()`: `streamPath` opens the RAW socket via
 * `startAttachStream`, because dockerode's non-hijack attach yields an
 * `http.IncomingMessage` that Bun will not stop reading (see the executor). The module
 * is mocked the same way the restore suite already mocks it.
 */
function captureHarness(
  script: Parameters<typeof harness>[0],
  stream: FakeAttachStream,
  opts: { attachFails?: Error } = {},
) {
  attachControl.stream = stream;
  attachControl.fails = opts.attachFails ?? null;
  attachControl.calls = 0;
  return harness(script, () => ({}));
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
    stream.emitStderr("tar: /mnt/x: Permission denied\n");

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

describe("the capture transport is the raw socket, not modem's http response", () => {
  it("reads the archive through startAttachStream, never through helper.attach()", async () => {
    // Same reason execStream pins its transport: dockerode's non-hijack attach yields
    // an `http.IncomingMessage`, and under Bun pausing one does not stop the daemon —
    // it buffers the archive internally instead, so the demuxer's backpressure would be
    // a no-op and a large volume would OOM the API exactly as #633 describes. A volume
    // tar is the other unbounded payload in this file.
    //
    // `attach` is deliberately NOT stubbed on the fake helper, so if streamPath ever
    // reaches for it again this fails loudly instead of regressing the transport.
    const h = captureHarness(
      { wait: "hang", inspect: [{ Running: false, Status: "exited", ExitCode: 0 }] },
      stream,
    );
    const exec = await h.executor();

    const { stdout, awaitExit } = await exec.streamPath(SERVICE, SOURCE_ID, {
      compression: "none",
    });
    collect(stdout);
    awaitExit.catch(() => {});
    stream.emitOutput("archive");
    stream.finish();
    await drive(awaitExit, 30_000);

    expect(attachControl.calls).toBe(1);
  });
});

describe("the archive is COMPLETE, not merely non-empty", () => {
  it("delivers every byte when the helper exits while the destination is behind", async () => {
    // The gap between the two things every other test in this area proves. Backpressure
    // is covered (docker-demux.test.ts, byte-count-agnostic by design) and
    // non-emptiness is covered (backup-empty-run). TRUNCATION sits precisely between
    // them: exit 0, a non-zero size, and a sha256 that matches the bytes that did
    // arrive — so even restore-time verification passes over an archive missing its
    // tail. On the DEFAULT producer.
    //
    // The shape that produces it: the helper exits as soon as the daemon accepts its
    // last bytes, which while we are paused are still in the socket rather than in
    // `stdout`. A backstop that then ends `stdout` on a flat timer strands them — after
    // `end()` Node emits no further `'drain'`, so the paused demuxer can never resume.
    // Deliberately no `finish()` here: this is the lost-`end` SSH case the backstop
    // exists for, so the backstop is doing its job AND must not truncate while doing it.
    const h = captureHarness(
      { wait: 0, inspect: [{ Running: false, Status: "exited", ExitCode: 0 }] },
      stream,
    );
    const exec = await h.executor();

    const { stdout, awaitExit } = await exec.streamPath(SERVICE, SOURCE_ID, {
      compression: "none",
    });
    awaitExit.catch(() => {});

    // A destination that accepts 64 KB at a time and acknowledges on a timer.
    //
    // The rate and the payload are chosen together so the backstop is REACHED
    // mid-transfer: 16 MB against a 4 MB in-flight ceiling leaves ~12 MB unread in the
    // source, and 50 ms per 64 KB makes the drain ~13 s — so the 3 s quiet check fires
    // several times while data is still pending, which is the only regime in which the
    // old flat `setTimeout(endSinks, 3000)` truncates. A faster consumer finishes before
    // the first check and the test proves nothing.
    let received = 0;
    let streamError: Error | null = null;
    stdout.on("error", (err: Error) => {
      streamError = err;
    });
    const ended = new Promise<void>((resolve) => stdout.on("end", resolve));
    stdout.pipe(
      new Writable({
        highWaterMark: 64 * 1024,
        write(chunk: Buffer, _enc, cb) {
          received += chunk.byteLength;
          setTimeout(cb, 50);
        },
      }),
    );

    // 16 MB of payload: four times the in-flight ceiling, so the demuxer must genuinely
    // pause and resume rather than absorbing the lot.
    const CHUNK = 64 * 1024;
    const CHUNKS = 256;
    for (let i = 0; i < CHUNKS; i++) stream.emitOutput("a".repeat(CHUNK));

    // Well past the helper's exit and many multiples of the backstop's quiet window.
    await drive(ended, 120_000, 250);

    expect(streamError).toBeNull();
    expect(received).toBe(CHUNK * CHUNKS);
  });
});

describe("quiesce — a point-in-time archive, or a loud refusal", () => {
  /** Harness whose fake daemon records pause/unpause against the helper lifecycle. */
  async function quiesceHarness(
    stream: FakeAttachStream,
    script: Parameters<typeof harness>[0] = {
      wait: 0,
      inspect: [{ Running: false, Status: "exited", ExitCode: 0 }],
    },
  ) {
    const calls: string[] = [];
    const h = captureHarness(script, stream);
    const exec = await h.executor();
    const runtime = (exec as unknown as { runtime: { docker: Record<string, unknown> } }).runtime;
    const created = h.created;
    // createContainer is already faked by the harness; wrap it so ORDER is observable.
    const origCreate = runtime.docker.createContainer as (o: unknown) => Promise<unknown>;
    runtime.docker.createContainer = (async (o: unknown) => {
      calls.push("create-helper");
      return origCreate(o);
    }) as never;
    runtime.docker.getContainer = ((id: string) => ({
      pause: async () => void calls.push(`pause:${id}`),
      unpause: async () => void calls.push(`unpause:${id}`),
      // A service WITH a container has its sources read from the live mounts, so the fake
      // has to report the volume under test or listSources finds nothing.
      inspect: async () => ({
        Mounts: [
          {
            Type: "volume",
            Name: SOURCE_ID,
            Source: SOURCE_ID,
            Destination: "/var/lib/postgresql/data",
          },
        ],
      }),
    })) as never;
    return { exec, calls, created };
  }

  const SERVICE_WITH_CONTAINER: ServiceHandle = { ...SERVICE, containerId: "ctr_app" };

  it("freezes BEFORE the copy starts and thaws only after it drains", async () => {
    // Ordering is the whole property. Freezing after the helper has begun reading, or
    // thawing when `streamPath` returns rather than when the archive has drained, both
    // leave the copy racing the application — which is the torn archive quiesce exists to
    // prevent, with the availability cost still paid.
    const h = await quiesceHarness(stream);

    const { stdout, awaitExit } = await h.exec.streamPath(SERVICE_WITH_CONTAINER, SOURCE_ID, {
      compression: "none",
      quiesce: true,
    });
    collect(stdout);
    awaitExit.catch(() => {});

    expect(h.calls).toEqual(["pause:ctr_app", "create-helper"]);

    stream.emitOutput("archive");
    stream.finish();
    await drive(awaitExit, 30_000);
    // Only now.
    expect(h.calls).toEqual(["pause:ctr_app", "create-helper", "unpause:ctr_app"]);
  });

  it("thaws even when the copy fails", async () => {
    // A container left frozen is an outage, so the thaw belongs in a finally — a failed
    // backup must not also take the service down. `wait: "hang"` so the copy really fails
    // (the idle watchdog fires) rather than completing.
    const h = await quiesceHarness(stream, { wait: "hang" });

    const { stdout, awaitExit } = await h.exec.streamPath(SERVICE_WITH_CONTAINER, SOURCE_ID, {
      compression: "none",
      quiesce: true,
      idleTimeoutMs: 5_000,
    });
    collect(stdout);

    await expect(drive(awaitExit, 30_000)).rejects.toThrow(/produced no data/);
    expect(h.calls).toContain("unpause:ctr_app");
  });

  it("touches nothing when quiesce was not asked for", async () => {
    const h = await quiesceHarness(stream);
    const { stdout, awaitExit } = await h.exec.streamPath(SERVICE_WITH_CONTAINER, SOURCE_ID, {
      compression: "none",
    });
    collect(stdout);
    awaitExit.catch(() => {});
    stream.emitOutput("archive");
    stream.finish();
    await drive(awaitExit, 30_000);

    expect(h.calls.filter((c) => c.startsWith("pause") || c.startsWith("unpause"))).toEqual([]);
  });

  it("refuses rather than silently producing a crash-consistent archive", async () => {
    // The caller asked for point-in-time. With no container to freeze we cannot give it,
    // and labelling a torn copy as quiesced is the silent-downgrade pattern this module
    // exists to remove — so it fails, and the message names both ways out.
    const h = await quiesceHarness(stream);

    await expect(
      h.exec.streamPath(SERVICE, SOURCE_ID, { compression: "none", quiesce: true }),
    ).rejects.toThrow(/no running container to freeze/);
    // And it did not start a copy it could not make consistent.
    expect(h.created).toEqual([]);
  });
});
