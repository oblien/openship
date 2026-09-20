import { describe, expect, it } from "vitest";
import {
  clearDecisionPending,
  createSession,
  subscribe,
  updateStatus,
  type SseWriter,
} from "@repo/platform/engine/modules/deployments/session-manager";

/**
 * A partial-failure compose deploy is HELD for an explicit keep/reject decision.
 * The compose pipeline announces it on its first SSE "ready" and finalization
 * repeats the same terminal state after persisting `partial_failure`. Session-manager
 * used to drop `meta.decisionPending` on the floor: the live `complete` event never
 * carried it and nothing was stored for replay. The dashboard's handler reads ONLY
 * the server's flag
 * (`decisionPending: !!data?.decisionPending`, pinned by decision-pending.test.ts),
 * so the keep/reject modal stayed hidden until a page refresh re-read it from the
 * REST snapshot (#664).
 */
function recordingWriter(): { writer: SseWriter; events: Array<{ event: string; data: any }> } {
  const events: Array<{ event: string; data: any }> = [];
  const writer: SseWriter = (event, data) => {
    events.push({ event, data: JSON.parse(data) });
    return true;
  };
  return { writer, events };
}

describe("session-manager carries decisionPending", () => {
  it("the live complete event carries the held decision", () => {
    const dep = "dep_dp_live";
    createSession(dep, "proj_1");
    const { writer, events } = recordingWriter();
    subscribe(dep, writer);
    events.length = 0;

    updateStatus(dep, "ready", { warningMessage: "Some services failed", decisionPending: true });

    const complete = events.find((e) => e.event === "complete");
    expect(complete?.data).toMatchObject({ success: true, decisionPending: true });
  });

  it("a reconnecting subscriber replays it after the stream closed", () => {
    const dep = "dep_dp_replay";
    createSession(dep, "proj_1");

    // Terminal write with no one watching — the refresh-before-reconnect case.
    updateStatus(dep, "ready", { warningMessage: "Some services failed", decisionPending: true });

    const { writer, events } = recordingWriter();
    subscribe(dep, writer);

    const complete = events.find((e) => e.event === "complete");
    expect(complete?.data).toMatchObject({ success: true, decisionPending: true });
  });

  it("an absent flag stays absent — a clean deploy must not open the modal", () => {
    const dep = "dep_dp_clean";
    createSession(dep, "proj_1");
    const { writer, events } = recordingWriter();
    subscribe(dep, writer);
    events.length = 0;

    updateStatus(dep, "ready", { warningMessage: "routed but have no HTTPS certificate yet" });

    const liveComplete = events.find((e) => e.event === "complete");
    expect(liveComplete?.data).not.toHaveProperty("decisionPending");

    const late = recordingWriter();
    subscribe(dep, late.writer);
    const replayed = late.events.find((e) => e.event === "complete");
    expect(replayed?.data).not.toHaveProperty("decisionPending");
  });

  it("stops replaying the decision after keep or reject resolves it", () => {
    const dep = "dep_dp_resolved";
    createSession(dep, "proj_1");
    updateStatus(dep, "ready", { warningMessage: "Some services failed", decisionPending: true });

    clearDecisionPending(dep);

    const { writer, events } = recordingWriter();
    subscribe(dep, writer);
    const complete = events.find((e) => e.event === "complete");
    expect(complete?.data).not.toHaveProperty("decisionPending");
  });
});
