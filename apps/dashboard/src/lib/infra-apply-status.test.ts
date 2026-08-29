import { describe, expect, it } from "vitest";

import {
  applyIntentOf,
  applyKey,
  applyPercent,
  applyPhase,
  summarizeSettled,
} from "./infra-apply-status";
import type { ContainerApplyActive, ContainerApplyStep } from "@/lib/api/system";

type StepStatus = ContainerApplyStep["status"];

/** The swap's fixed three-step model, with the statuses under test. */
function steps(pull: StepStatus, recreate: StepStatus, verify: StepStatus): ContainerApplyStep[] {
  return [
    { id: "pull", label: "Pull", status: pull },
    { id: "recreate", label: "Recreate", status: recreate },
    { id: "verify", label: "Verify", status: verify },
  ];
}

function target(over: Partial<ContainerApplyActive> = {}): ContainerApplyActive {
  return {
    serverId: "srv_1",
    serverName: "A",
    component: "edge",
    state: "running",
    intent: "update",
    sessionId: "capp_1",
    steps: steps("running", "pending", "pending"),
    ...over,
  };
}

describe("applyPhase", () => {
  it("reports a queued target as queued, session or not", () => {
    expect(applyPhase(target({ state: "queued", steps: undefined, sessionId: undefined }))).toBe("queued");
  });

  it("follows the running step", () => {
    expect(applyPhase(target())).toBe("pull");
    expect(applyPhase(target({ steps: steps("done", "running", "pending") }))).toBe("recreate");
    expect(applyPhase(target({ steps: steps("done", "done", "running") }))).toBe("verify");
  });

  it("falls forward to the first unfinished step when nothing is marked running", () => {
    expect(applyPhase(target({ steps: steps("done", "pending", "pending") }))).toBe("recreate");
  });

  it("stays on the last step once every step has settled", () => {
    expect(applyPhase(target({ steps: steps("done", "done", "done") }))).toBe("verify");
    expect(applyPhase(target({ steps: steps("error", "error", "error") }))).toBe("verify");
  });

  it("never narrates a pull for a repair — a restart has no image to fetch", () => {
    expect(applyPhase(target({ intent: "repair", steps: steps("pending", "pending", "pending") }))).toBe(
      "starting",
    );
  });

  it("assumes the first step when a session exists but has sent no steps yet", () => {
    expect(applyPhase(target({ steps: [] }))).toBe("pull");
  });
});

describe("applyPercent", () => {
  it("is zero with nothing in flight", () => {
    expect(applyPercent([])).toBe(0);
  });

  it("floors at 4% so a just-started run still reads as started", () => {
    expect(applyPercent([target({ state: "queued", steps: undefined })])).toBe(4);
    expect(applyPercent([target({ steps: steps("pending", "pending", "pending") })])).toBe(4);
  });

  it("counts a running step as half its weight", () => {
    // pull running = 0.5/3 → 17%
    expect(applyPercent([target()])).toBe(17);
    // pull done, recreate running = 1.5/3 → 50%
    expect(applyPercent([target({ steps: steps("done", "running", "pending") })])).toBe(50);
  });

  it("caps at 99 — finished work leaves the set instead of reading 100", () => {
    expect(applyPercent([target({ steps: steps("done", "done", "done") })])).toBe(99);
  });

  it("weighs every target equally, so a queue drags the total down honestly", () => {
    const percent = applyPercent([
      target({ steps: steps("done", "done", "done") }),
      target({ serverId: "srv_2", state: "queued", steps: undefined }),
    ]);
    expect(percent).toBe(50);
  });
});

describe("applyIntentOf", () => {
  it("reads as a restart only when every target is one", () => {
    expect(applyIntentOf([target({ intent: "repair" })])).toBe("repair");
    expect(applyIntentOf([target({ intent: "repair" }), target({ serverId: "srv_2" })])).toBe("update");
    // A run whose cached row is gone carries no intent — treat it as an update.
    expect(applyIntentOf([target({ intent: null })])).toBe("update");
  });
});

describe("summarizeSettled", () => {
  const settled = (serverId: string, ok: boolean, error?: string, at = "2026-08-14T00:00:00.000Z") => ({
    serverId,
    serverName: serverId,
    component: "edge" as const,
    ok,
    ...(error ? { error } : {}),
    finishedAt: at,
  });

  it("counts only the runs this client watched", () => {
    const watched = new Set([applyKey("srv_1", "edge")]);
    expect(summarizeSettled([settled("srv_1", true), settled("srv_2", true)], watched)).toEqual({
      done: 1,
      failed: 0,
    });
  });

  it("is null when nothing watched has settled", () => {
    expect(summarizeSettled([settled("srv_9", true)], new Set([applyKey("srv_1", "edge")]))).toBeNull();
    expect(summarizeSettled([], new Set([applyKey("srv_1", "edge")]))).toBeNull();
  });

  it("splits failures out and carries the first reason", () => {
    const watched = new Set([applyKey("srv_1", "edge"), applyKey("srv_2", "edge")]);
    expect(
      summarizeSettled([settled("srv_1", true), settled("srv_2", false, "pull failed")], watched),
    ).toEqual({ done: 1, failed: 1, error: "pull failed" });
  });

  it("counts one finish per component, however often it is reported", () => {
    const watched = new Set([applyKey("srv_1", "edge")]);
    expect(summarizeSettled([settled("srv_1", true), settled("srv_1", true)], watched)).toEqual({
      done: 1,
      failed: 0,
    });
  });

  it("reports the newest attempt when a component was applied twice in the window", () => {
    const watched = new Set([applyKey("srv_1", "edge")]);
    const older = settled("srv_1", false, "pull failed", "2026-08-14T00:00:00.000Z");
    const newer = settled("srv_1", true, undefined, "2026-08-14T00:02:00.000Z");
    expect(summarizeSettled([older, newer], watched)).toEqual({ done: 1, failed: 0 });
    // Order in the payload must not decide it.
    expect(summarizeSettled([newer, older], watched)).toEqual({ done: 1, failed: 0 });
  });
});
