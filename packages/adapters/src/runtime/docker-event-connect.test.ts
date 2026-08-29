/**
 * Opening the `/events` stream, and the one bound it must have.
 *
 * The subscription itself is deliberately unbounded — docker-modem applies its
 * `timeout` as an inactivity deadline to streams too, so a quiet box would have its
 * event stream destroyed on a schedule, and `timeout: 0` is the only way out. What
 * that also removes is the bound on the REQUEST that opens the stream, and a
 * half-open SSH bridge answers it never rather than refusing it. That failure has no
 * symptom: the accelerator is best-effort, so a connect that hangs forever looks
 * exactly like a box that happens to be quiet.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  /** Signals handed to `getEvents`, so the abort can be shown to be a real one. */
  signals: [] as (AbortSignal | undefined)[],
}));

vi.mock("dockerode", () => {
  /** A daemon that accepts `GET /events` and answers nothing at all. */
  class WedgedDockerode {
    modem: Record<string, unknown>;
    constructor(opts: Record<string, unknown> = {}) {
      this.modem = opts;
    }
    async getEvents(opts?: { abortSignal?: AbortSignal }): Promise<unknown> {
      h.signals.push(opts?.abortSignal);
      return new Promise((_resolve, reject) => {
        // Exactly what the underlying request does when the signal fires.
        opts?.abortSignal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
        });
      });
    }
  }
  return { default: WedgedDockerode };
});

const NOOP = { onEvent: () => {}, onClose: () => {} };

beforeEach(() => {
  h.signals.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("watchContainerEvents — opening the stream", () => {
  it("gives up on a daemon that accepts the request and never answers", async () => {
    const { DockerRuntime } = await import("./docker");
    const runtime = await DockerRuntime.create({ dockerSocketPath: "/tmp/wedged.sock" });

    vi.useFakeTimers();
    const opening = runtime.watchContainerEvents!(NOOP);
    // Assert before advancing, or an unhandled rejection escapes the microtask turn.
    const settled = expect(opening).rejects.toThrow(/no answer from the docker event stream/);
    await vi.advanceTimersByTimeAsync(20_001);
    await settled;

    // A real cancel, not a promise we walked away from: the request is aborted, so
    // the socket is released rather than held for the life of the process.
    expect(h.signals).toHaveLength(1);
    expect(h.signals[0]?.aborted).toBe(true);
  });

  it("reports the deadline in seconds, so the reason names itself", async () => {
    const { DockerRuntime } = await import("./docker");
    const runtime = await DockerRuntime.create({ dockerSocketPath: "/tmp/wedged.sock" });

    vi.useFakeTimers();
    const opening = runtime.watchContainerEvents!(NOOP);
    const settled = expect(opening).rejects.toThrow("within 20s");
    await vi.advanceTimersByTimeAsync(20_001);
    await settled;
  });

  it("passes the connect deadline as an abortSignal docker-modem will honor", async () => {
    // `abortSignal` is absent from @types/dockerode's GetEventsOptions and reaches the
    // request through a cast, so a typo here would be invisible: the option would be
    // serialized into the query string (modem.js deletes it precisely to avoid that)
    // and the connect would go back to being unbounded.
    const { DockerRuntime } = await import("./docker");
    const runtime = await DockerRuntime.create({ dockerSocketPath: "/tmp/wedged.sock" });

    vi.useFakeTimers();
    const opening = runtime.watchContainerEvents!(NOOP);
    const settled = expect(opening).rejects.toThrow(Error);
    expect(h.signals[0]).toBeInstanceOf(AbortSignal);
    expect(h.signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(20_001);
    await settled;
  });
});
