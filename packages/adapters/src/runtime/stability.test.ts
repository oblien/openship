/**
 * The stabilization watch decides whether a deploy may call itself ready, so the
 * cases that matter are the two it must never confuse:
 *
 *   - a container that exits instantly and is restarted forever (docker shows it
 *     as "Up 1 second" at every glance) MUST fail, and
 *   - a container that restarts once or twice waiting on a slow peer, then holds,
 *     MUST pass — failing it would break every stack with a database.
 */
import { describe, expect, it } from "vitest";
import {
  classifyStability,
  watchContainerStability,
  type ContainerStabilitySample,
  type StabilityOptions,
} from "./stability";

const OPTS: StabilityOptions = { windowMs: 15_000, pollMs: 1_000, crashRestarts: 3 };

function sample(over: Partial<ContainerStabilitySample> = {}): ContainerStabilitySample {
  return {
    state: "running",
    exitCode: null,
    restartCount: 0,
    health: null,
    errorLine: null,
    oomKilled: false,
    restartPolicy: "always",
    ...over,
  };
}

const judge = (
  first: ContainerStabilitySample,
  latest: ContainerStabilitySample,
  windowElapsed = false,
) => classifyStability(first, latest, { ...OPTS, windowElapsed });

describe("classifyStability — while the window is still open", () => {
  it("holds off on a container that merely looks up (nothing proven yet)", () => {
    expect(judge(sample(), sample())).toBeNull();
  });

  it("fails a crash loop as soon as the restarts prove it", () => {
    const verdict = judge(sample(), sample({ restartCount: 3, exitCode: 1 }));
    expect(verdict).toMatchObject({ status: "crash_loop", ok: false, exitCode: 1, restarts: 3 });
    expect(verdict?.reason).toContain("restarted 3 times");
  });

  it("counts restarts from the baseline, not from zero", () => {
    // The container had already restarted twice while later services were being
    // created; two more while we watch is still under the threshold.
    expect(judge(sample({ restartCount: 2 }), sample({ restartCount: 4 }))).toBeNull();
    expect(judge(sample({ restartCount: 2 }), sample({ restartCount: 5 }))).toMatchObject({
      status: "crash_loop",
      restarts: 3,
    });
  });

  it("fails immediately when the exit is final (no restart policy)", () => {
    expect(
      judge(sample(), sample({ state: "exited", exitCode: 1, restartPolicy: "no" })),
    ).toMatchObject({ status: "exited", ok: false, exitCode: 1 });
  });

  it("passes a one-shot container that exited 0 and is meant to stay stopped", () => {
    expect(
      judge(sample(), sample({ state: "exited", exitCode: 0, restartPolicy: "no" })),
    ).toMatchObject({ status: "completed", ok: true });
    // on-failure leaves a zero exit alone too, so that is also "done", not "down".
    expect(
      judge(sample(), sample({ state: "exited", exitCode: 0, restartPolicy: "on-failure" })),
    ).toMatchObject({ status: "completed", ok: true });
  });

  it("waits out a single exit that the restart policy will undo", () => {
    expect(
      judge(sample(), sample({ state: "exited", exitCode: 1, restartPolicy: "always" })),
    ).toBeNull();
  });

  it("fails on the container's own unhealthy verdict", () => {
    expect(judge(sample(), sample({ health: "unhealthy" }))).toMatchObject({
      status: "unhealthy",
      ok: false,
    });
  });

  it("passes early — and only — when the healthcheck vouches for it", () => {
    expect(judge(sample(), sample({ health: "healthy" }))).toMatchObject({
      status: "stable",
      ok: true,
    });
    // Healthy but it has been bouncing: not something to shortcut on.
    expect(judge(sample(), sample({ health: "healthy", restartCount: 1 }))).toBeNull();
    expect(judge(sample(), sample({ health: "starting" }))).toBeNull();
  });

  it("fails a vanished or dead container", () => {
    expect(judge(sample(), sample({ state: "missing" }))).toMatchObject({ status: "missing" });
    expect(judge(sample(), sample({ state: "dead", errorLine: "OCI runtime error" }))).toMatchObject(
      { status: "dead", ok: false },
    );
  });
});

describe("classifyStability — at the deadline", () => {
  it("passes a container that simply stayed up, with nothing to warn about", () => {
    const verdict = judge(sample(), sample(), true);
    expect(verdict).toMatchObject({ status: "stable", ok: true, restarts: 0 });
    expect(verdict?.warning).toBeUndefined();
  });

  it("passes — with a warning — a service that bounced then settled", () => {
    const verdict = judge(sample(), sample({ restartCount: 2 }), true);
    expect(verdict?.ok).toBe(true);
    expect(verdict?.warning).toContain("restarted 2 times");
  });

  it("notes a healthcheck that never went green without failing the deploy", () => {
    const verdict = judge(sample(), sample({ health: "starting" }), true);
    expect(verdict?.ok).toBe(true);
    expect(verdict?.warning).toContain("healthcheck");
  });

  it("fails a container still restarting when time runs out", () => {
    expect(judge(sample(), sample({ state: "restarting", exitCode: 1 }), true)).toMatchObject({
      status: "crash_loop",
      ok: false,
    });
  });

  it("fails a container that never started", () => {
    expect(judge(sample(), sample({ state: "created" }), true)).toMatchObject({
      status: "exited",
      ok: false,
    });
  });

  it("fails a still-down container whose restart policy hasn't saved it", () => {
    expect(
      judge(sample(), sample({ state: "exited", exitCode: 137, restartPolicy: "always" }), true),
    ).toMatchObject({ status: "exited", ok: false, exitCode: 137 });
  });
});

// ─── watchContainerStability ────────────────────────────────────────────────

/** Drives the watcher with a scripted sample series and a virtual clock. */
function harness(series: ContainerStabilitySample[], opts: Partial<StabilityOptions> = {}) {
  let clock = 0;
  let index = 0;
  const seen: number[] = [];
  return {
    run: () =>
      watchContainerStability(
        {
          sample: async () => {
            seen.push(clock);
            return series[Math.min(index++, series.length - 1)];
          },
          sleep: async (ms) => {
            clock += ms;
          },
          now: () => clock,
        },
        { ...OPTS, ...opts },
      ),
    /** Virtual ms the watch consumed — what a deploy pays in wall-clock. */
    elapsed: () => clock,
    samples: () => seen.length,
  };
}

describe("watchContainerStability", () => {
  it("catches the reported bug: create succeeded, container is in a restart loop", async () => {
    const h = harness([
      sample({ restartCount: 0 }),
      sample({ state: "restarting", restartCount: 1, exitCode: 1 }),
      sample({ state: "restarting", restartCount: 2, exitCode: 1 }),
      sample({ state: "running", restartCount: 3, exitCode: 1 }),
    ]);
    const verdict = await h.run();
    expect(verdict).toMatchObject({ status: "crash_loop", ok: false, exitCode: 1 });
    // Decided from the evidence, not by waiting out the window.
    expect(h.elapsed()).toBeLessThan(OPTS.windowMs);
  });

  it("waits the full window before blessing a container with no healthcheck", async () => {
    const h = harness([sample()]);
    await expect(h.run()).resolves.toMatchObject({ status: "stable", ok: true });
    expect(h.elapsed()).toBe(OPTS.windowMs);
  });

  it("credits uptime the caller already observed, so a stack pays one window", async () => {
    const h = harness([sample()], { alreadyRunningMs: 12_000 });
    await expect(h.run()).resolves.toMatchObject({ ok: true });
    expect(h.elapsed()).toBe(3_000);
  });

  it("skips waiting entirely for a container already up for the whole window", async () => {
    const h = harness([sample()], { alreadyRunningMs: 60_000 });
    await expect(h.run()).resolves.toMatchObject({ ok: true });
    expect(h.elapsed()).toBe(0);
    expect(h.samples()).toBe(1);
  });

  it("returns as soon as a healthcheck passes", async () => {
    const h = harness([sample({ health: "starting" }), sample({ health: "healthy" })]);
    await expect(h.run()).resolves.toMatchObject({ status: "stable", ok: true });
    expect(h.elapsed()).toBe(OPTS.pollMs);
  });

  it("propagates a sampling error instead of inventing a failure", async () => {
    await expect(
      watchContainerStability(
        {
          sample: async () => {
            throw new Error("channel open failure");
          },
        },
        OPTS,
      ),
    ).rejects.toThrow("channel open failure");
  });
});
