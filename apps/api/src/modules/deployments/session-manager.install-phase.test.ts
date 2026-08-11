import { describe, expect, it } from "vitest";
import {
  createSession,
  getSession,
  subscribe,
  broadcastInstallPhase,
  updateStatus,
  type SseWriter,
} from "./session-manager";

/**
 * The install stepper's source of truth is a DEDICATED session channel, parallel
 * to the log/step/progress model. These pin the two invariants the dashboard
 * relies on: broadcast stores latest-per-id (so a reconnect replays it), and the
 * terminal `updateStatus` never leaks onto the phase channel.
 */

/** Collect (event, parsedData) pairs a subscriber would receive. */
function recordingWriter(): { writer: SseWriter; events: Array<{ event: string; data: any }> } {
  const events: Array<{ event: string; data: any }> = [];
  const writer: SseWriter = (event, data) => {
    events.push({ event, data: JSON.parse(data) });
    return true;
  };
  return { writer, events };
}

describe("session-manager install-phase channel", () => {
  it("broadcastInstallPhase stores the latest state and emits an install-phase event", () => {
    const dep = "dep_ip_broadcast";
    createSession(dep, "proj_1");
    const { writer, events } = recordingWriter();
    subscribe(dep, writer);
    events.length = 0; // ignore replay of an empty session

    broadcastInstallPhase(dep, { id: "images", status: "active" });

    const phaseEvents = events.filter((e) => e.event === "install-phase");
    expect(phaseEvents).toHaveLength(1);
    expect(phaseEvents[0].data).toMatchObject({ type: "install-phase", id: "images", status: "active" });
    expect(getSession(dep)?.installPhases.get("images")).toEqual({ id: "images", status: "active" });
  });

  it("a late subscriber replays the stored phases (latest-per-id) on connect", () => {
    const dep = "dep_ip_replay";
    createSession(dep, "proj_1");

    // No subscribers yet — these are only stored.
    broadcastInstallPhase(dep, { id: "images", status: "active" });
    broadcastInstallPhase(dep, { id: "images", status: "done" });
    broadcastInstallPhase(dep, { id: "services", status: "active" });

    const { writer, events } = recordingWriter();
    subscribe(dep, writer);

    const replayed = events.filter((e) => e.event === "install-phase").map((e) => e.data);
    expect(replayed).toEqual([
      { type: "install-phase", id: "images", status: "done" },
      { type: "install-phase", id: "services", status: "active" },
    ]);
  });

  it("updateStatus emits only complete/end — never onto the phase channel", () => {
    const dep = "dep_ip_terminal";
    createSession(dep, "proj_1");
    const { writer, events } = recordingWriter();
    subscribe(dep, writer);
    events.length = 0;

    updateStatus(dep, "ready");

    const kinds = events.map((e) => e.event);
    expect(kinds).toEqual(["complete", "end"]);
    expect(kinds).not.toContain("install-phase");
  });
});
