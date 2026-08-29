import { describe, it, expect } from "vitest";
import type { ContainerStabilitySample } from "@repo/adapters";
import { classifySteadyState, CRASH_RESTART_DELTA } from "./steady-state";

/**
 * These cases ARE the noise policy. Every `kind: null` below is a state that
 * looks like a failure and isn't — and each one, if it flipped to an incident,
 * would produce an alert the operator would eventually mute the channel over.
 */

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

const UP = { prevRestartCount: 0, expectRunning: true };

describe("classifySteadyState — failures it must catch", () => {
  it("calls `restarting` a crash loop", () => {
    const v = classifySteadyState(sample({ state: "restarting", exitCode: 1 }), UP);
    expect(v.kind).toBe("crash_loop");
    expect(v.reason).toContain("restarting");
  });

  it("calls a restart-count jump a crash loop even while it reads as running", () => {
    const v = classifySteadyState(
      sample({ state: "running", restartCount: CRASH_RESTART_DELTA, exitCode: 1 }),
      UP,
    );
    // The point of the delta rule: every point-in-time read says "Up 1 second".
    expect(v.kind).toBe("crash_loop");
  });

  it("does NOT call a single restart between ticks a loop", () => {
    expect(classifySteadyState(sample({ restartCount: 1 }), UP).kind).toBeNull();
  });

  it("ignores a large ABSOLUTE restart count when the delta is zero", () => {
    // Restarted 400 times last month, stable now. An absolute-count rule would
    // page about ancient history on every single tick.
    const v = classifySteadyState(sample({ restartCount: 400 }), {
      prevRestartCount: 400,
      expectRunning: true,
    });
    expect(v.kind).toBeNull();
  });

  it("calls an exited container with a restart policy down", () => {
    const v = classifySteadyState(
      sample({ state: "exited", exitCode: 1, restartPolicy: "always" }),
      UP,
    );
    expect(v.kind).toBe("down");
    expect(v.reason).toContain("has not come back");
  });

  it("surfaces OOM-kills explicitly", () => {
    const v = classifySteadyState(
      sample({ state: "exited", exitCode: 137, oomKilled: true }),
      UP,
    );
    expect(v.kind).toBe("down");
    expect(v.reason).toContain("OOM-killed");
  });

  it("calls docker's dead state down", () => {
    expect(classifySteadyState(sample({ state: "dead", exitCode: 255 }), UP).kind).toBe("down");
  });

  it("calls a failing healthcheck unhealthy", () => {
    const v = classifySteadyState(sample({ state: "running", health: "unhealthy" }), UP);
    expect(v.kind).toBe("unhealthy");
  });

  it("calls a container stuck in `created` down on the second tick", () => {
    const s = sample({ state: "created" });
    expect(classifySteadyState(s, { ...UP, createdTicks: 0 }).kind).toBeNull();
    expect(classifySteadyState(s, { ...UP, createdTicks: 1 }).kind).toBe("down");
  });

  it("still reports the loop for a service stopped mid-crash-loop", () => {
    // Loop rules run BEFORE the intent gate: "I stopped it because it was
    // broken" must not erase the reason it was broken.
    const v = classifySteadyState(sample({ state: "restarting", exitCode: 1 }), {
      prevRestartCount: 0,
      expectRunning: false,
    });
    expect(v.kind).toBe("crash_loop");
  });
});

describe("classifySteadyState — things that are NOT incidents", () => {
  it("an intentional stop", () => {
    const v = classifySteadyState(
      sample({ state: "exited", exitCode: 137, restartPolicy: "always" }),
      { prevRestartCount: 0, expectRunning: false },
    );
    expect(v.kind).toBeNull();
  });

  it("a one-shot job that exited 0 with no restart policy", () => {
    for (const policy of ["no", "", null]) {
      const v = classifySteadyState(
        sample({ state: "exited", exitCode: 0, restartPolicy: policy }),
        UP,
      );
      expect(v.kind, `policy=${policy}`).toBeNull();
    }
  });

  it("a non-zero exit that nothing will restart, when it wasn't expected up", () => {
    const v = classifySteadyState(
      sample({ state: "exited", exitCode: 2, restartPolicy: "no" }),
      { prevRestartCount: 0, expectRunning: false },
    );
    expect(v.kind).toBeNull();
  });

  it("a paused container", () => {
    expect(classifySteadyState(sample({ state: "paused" }), UP).kind).toBeNull();
  });

  it("a healthcheck still in its grace period", () => {
    expect(classifySteadyState(sample({ health: "starting" }), UP).kind).toBeNull();
  });

  it("a healthy container", () => {
    expect(classifySteadyState(sample({ health: "healthy" }), UP).kind).toBeNull();
  });

  it("a missing container — only the sweep knows if a deploy is recreating it", () => {
    expect(classifySteadyState(sample({ state: "missing" }), UP).kind).toBeNull();
  });

  it("the first tick after a restart, with no baseline to diff against", () => {
    const v = classifySteadyState(sample({ restartCount: 99 }), {
      prevRestartCount: null,
      expectRunning: true,
    });
    expect(v.kind).toBeNull();
  });
});

describe("classifySteadyState — why there is no fault", () => {
  /**
   * The three clears are not interchangeable: `healthy` is the only one the caller
   * may close an incident with an "is back up", `not_expected` closes it silently,
   * and `unknown` must leave it alone. They were once one bare `null`, which is how
   * a container nobody could inspect came to send recovery notifications.
   */
  it("only says `healthy` when it actually observed health", () => {
    expect(classifySteadyState(sample({ state: "running" }), UP).clear).toBe("healthy");
    expect(classifySteadyState(sample({ health: "healthy" }), UP).clear).toBe("healthy");
    expect(classifySteadyState(sample({ health: "starting" }), UP).clear).toBe("healthy");
    // A finished one-shot: a KNOWN clean exit that nothing will restart.
    expect(
      classifySteadyState(sample({ state: "exited", exitCode: 0, restartPolicy: "no" }), UP).clear,
    ).toBe("healthy");
  });

  it("says `unknown` for a container that is not running and cannot say why", () => {
    // What the container LIST yields when there was no inspect to spend: the state,
    // and nothing else. `exit ?? 0` used to read that as "finished successfully" —
    // so a genuinely dead container was reported healthy and its incident closed.
    const listViewOnly = sample({ state: "exited", exitCode: null, restartPolicy: null });
    const v = classifySteadyState(listViewOnly, UP);
    expect(v.kind).toBeNull();
    expect(v.clear).toBe("unknown");

    // Mid-removal, and a state string a future docker might add.
    expect(classifySteadyState(sample({ state: "removing" }), UP).clear).toBe("unknown");
    expect(classifySteadyState(sample({ state: "unknown" }), UP).clear).toBe("unknown");
    expect(classifySteadyState(sample({ state: "missing" }), UP).clear).toBe("unknown");
    // First tick in `created` — a race with a deploy, not yet a verdict either way.
    expect(classifySteadyState(sample({ state: "created" }), UP).clear).toBe("unknown");
  });

  it("says `not_expected` for everything that is down on purpose", () => {
    const DOWN = { prevRestartCount: 0, expectRunning: false };
    expect(classifySteadyState(sample({ state: "exited", exitCode: 137 }), DOWN).clear).toBe(
      "not_expected",
    );
    expect(classifySteadyState(sample({ state: "dead" }), DOWN).clear).toBe("not_expected");
    expect(classifySteadyState(sample({ state: "created" }), { ...DOWN, createdTicks: 1 }).clear).toBe(
      "not_expected",
    );
    // Pausing is only ever deliberate, whatever the service row says about intent.
    expect(classifySteadyState(sample({ state: "paused" }), UP).clear).toBe("not_expected");
  });

  it("still calls docker's `dead` state down without an exit code to explain it", () => {
    // The one non-running state that needs no inspect: dead is never benign, so the
    // `unknown` hold must not swallow it.
    const v = classifySteadyState(sample({ state: "dead", exitCode: null, restartPolicy: null }), UP);
    expect(v.kind).toBe("down");
  });
});

describe("classifySteadyState — a non-zero exit that will NOT be restarted", () => {
  it("is down when the workload was expected up", () => {
    const v = classifySteadyState(
      sample({ state: "exited", exitCode: 2, restartPolicy: "no" }),
      UP,
    );
    expect(v.kind).toBe("down");
    expect(v.reason).toContain("code 2");
    expect(v.reason).not.toContain("has not come back");
  });
});
