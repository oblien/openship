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
    stream.emitOutput("tar: can't create directory: Read-only file system\n");

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
