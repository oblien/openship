/**
 * A scriptable stand-in for one of the executor's disposable helper containers.
 *
 * Shared by the capture and restore timeout suites because they are testing the
 * same primitive from both ends: `awaitHelperExit` races wait() against an exit
 * poll, an idle watchdog and a ceiling, and both directions must be able to
 * script "wait() never answers" and "the daemon says it exited" independently.
 */

import { Readable } from "node:stream";
import { vi } from "vitest";
import { DockerRuntime } from "../../src/runtime/docker";
import { DockerBackupExecutor } from "../../src/backup/executors/docker";

/**
 * A duplex-ish stand-in for the hijacked attach socket, used from both ends:
 * on restore, writes to it are the helper's stdin (recorded, so "did the archive
 * reach the helper" is observable); on capture, `emitOutput` is the helper
 * writing the archive back out.
 */
export class FakeAttachStream extends Readable {
  written: Buffer[] = [];
  destroyed_ = false;
  ended = false;
  override _read() {}
  write(chunk: Buffer) {
    this.written.push(Buffer.from(chunk));
    return true;
  }
  end() {
    this.ended = true;
  }
  override destroy() {
    this.destroyed_ = true;
    return this;
  }
  /** Simulate the helper writing to stdout/stderr. */
  emitOutput(text: string) {
    this.push(Buffer.from(text));
  }
  /** Simulate the daemon closing the attach once all output is demuxed. */
  finish() {
    this.push(null);
  }
}

export interface HelperScript {
  /** Resolve wait() with this code, or leave it pending forever (the hang). */
  wait?: number | "hang";
  /** Successive inspect() results. The last is repeated. */
  inspect?: Array<{ Running: boolean; Status?: string; ExitCode?: number } | "404">;
}

/** A real container does not exit in the same tick it starts, and the difference
 *  is load-bearing: an instant wait() would settle the race before the helper's
 *  own output had been read. */
export const WAIT_DELAY_MS = 500;

export interface HelperHarness {
  /** Every createContainer spec the executor asked for. */
  created: Array<Record<string, unknown>>;
  /** Every remove() the executor made — the leak assertion. */
  removals: Array<{ force?: boolean }>;
  started: () => boolean;
  inspectCalls: () => number;
  /** Extra members merged onto the fake container (attach, logs, modem…). */
  executor: () => Promise<DockerBackupExecutor>;
}

export function harness(
  script: HelperScript,
  extras: (h: { removals: Array<{ force?: boolean }> }) => Record<string, unknown> = () => ({}),
): HelperHarness {
  const created: Array<Record<string, unknown>> = [];
  const removals: Array<{ force?: boolean }> = [];
  let started = false;
  let inspectCalls = 0;

  const helper = {
    id: "helper_1",
    start: async () => {
      started = true;
    },
    wait: () => {
      const code = script.wait;
      if (code === "hang" || code === undefined) {
        return new Promise<{ StatusCode: number }>(() => {});
      }
      return new Promise<{ StatusCode: number }>((resolve) =>
        setTimeout(() => resolve({ StatusCode: code }), WAIT_DELAY_MS),
      );
    },
    inspect: async () => {
      const steps = script.inspect ?? [{ Running: true }];
      const step = steps[Math.min(inspectCalls++, steps.length - 1)];
      if (step === "404") {
        throw Object.assign(new Error("no such container"), { statusCode: 404 });
      }
      return { State: { Status: step.Running ? "running" : "exited", ...step } };
    },
    remove: async (opts?: { force?: boolean }) => {
      removals.push(opts ?? {});
    },
    ...extras({ removals }),
  };

  return {
    created,
    removals,
    started: () => started,
    inspectCalls: () => inspectCalls,
    async executor() {
      const runtime = await DockerRuntime.create();
      // ensureImage → runtime.pullImage; never touch a registry in a unit test.
      (runtime as unknown as { pullImage: () => Promise<void> }).pullImage = async () => {};
      runtime.docker.createContainer = (async (opts: Record<string, unknown>) => {
        created.push(opts);
        return helper;
      }) as never;
      return new DockerBackupExecutor(runtime);
    },
  };
}

/** Run `p` while advancing fake time in slices, so watchdogs and poll intervals
 *  fire without wall-clock waiting. Settles as soon as `p` does. */
export async function drive<T>(p: Promise<T>, totalMs: number, sliceMs = 250): Promise<T> {
  let settled = false;
  const tracked = p.then(
    (v) => {
      settled = true;
      return v;
    },
    (e) => {
      settled = true;
      throw e;
    },
  );
  tracked.catch(() => {});
  for (let elapsed = 0; elapsed < totalMs && !settled; elapsed += sliceMs) {
    await vi.advanceTimersByTimeAsync(sliceMs);
  }
  return tracked;
}
