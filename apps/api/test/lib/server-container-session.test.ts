import { describe, expect, it } from "vitest";

/**
 * The container-apply session store — the in-memory transport behind an edge/mail
 * image swap, and now also the source a FLEET view reads progress and outcomes from.
 *
 * These pin the enumerator: what it exposes (steps and outcome, never the subscriber
 * set or the log ring), and the settled window that exists because a finished apply
 * is the only place a "done" beat can come from — the drift row clears its update and
 * its in-progress mark in one write, so a reader watching rows only sees work vanish.
 */

import {
  advanceStep,
  createContainerApplySession,
  finishContainerApplySession,
  getActiveContainerApplySession,
  listContainerApplySessions,
} from "../../src/lib/server-container-session";

/** Unique per case: the store is module-global and shared across this file. */
let next = 0;
const serverId = () => `srv_${++next}`;

describe("listContainerApplySessions", () => {
  it("reports a running apply with its component and steps", () => {
    const id = serverId();
    const session = createContainerApplySession(id, "edge");

    const mine = listContainerApplySessions().filter((s) => s.serverId === id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ id: session.id, component: "edge", status: "running" });
    expect(mine[0]!.steps.map((s) => s.id)).toEqual(["pull", "recreate", "verify"]);
  });

  it("carries the live step model, so a reader can render progress", () => {
    const id = serverId();
    const session = createContainerApplySession(id, "edge");
    advanceStep(session.id, "Updating the edge to ghcr.io/oblien/openship-edge:0.5.0");

    const mine = listContainerApplySessions().find((s) => s.serverId === id)!;
    expect(mine.steps.find((s) => s.id === "pull")!.status).toBe("running");
  });

  it("hands out a copy — a reader can never mutate the live session's steps", () => {
    const id = serverId();
    const session = createContainerApplySession(id, "edge");

    const snap = listContainerApplySessions().find((s) => s.serverId === id)!;
    snap.steps[0]!.status = "error";

    expect(session.steps[0]!.status).toBe("pending");
    // And nothing about the transport leaks into the read shape.
    expect(snap).not.toHaveProperty("subscribers");
    expect(snap).not.toHaveProperty("logs");
    expect(snap).not.toHaveProperty("donePromise");
  });

  it("drops a finished apply unless a settled window asks for it", () => {
    const id = serverId();
    const session = createContainerApplySession(id, "mail");
    finishContainerApplySession(session.id, "completed", { updated: true, down: false });

    expect(listContainerApplySessions().find((s) => s.serverId === id)).toBeUndefined();

    const settled = listContainerApplySessions({ settledWithinMs: 60_000 }).find(
      (s) => s.serverId === id,
    );
    expect(settled).toMatchObject({ status: "completed", result: { updated: true, down: false } });
    // A completed run has no step left short of done — the beat is unambiguous.
    expect(settled!.steps.every((s) => s.status === "done")).toBe(true);
  });

  it("keeps the failure reason on a settled apply", () => {
    const id = serverId();
    const session = createContainerApplySession(id, "edge");
    finishContainerApplySession(session.id, "failed", undefined, "could not pull the image");

    const settled = listContainerApplySessions({ settledWithinMs: 60_000 }).find(
      (s) => s.serverId === id,
    );
    expect(settled).toMatchObject({ status: "failed", error: "could not pull the image" });
  });

  it("excludes a finish that is older than the window", () => {
    const id = serverId();
    const session = createContainerApplySession(id, "edge");
    finishContainerApplySession(session.id, "completed", { updated: true, down: false });
    // Backdate the finish rather than waiting for the window to lapse.
    session.finishedAt = Date.now() - 120_000;

    expect(
      listContainerApplySessions({ settledWithinMs: 60_000 }).find((s) => s.serverId === id),
    ).toBeUndefined();
  });

  it("agrees with the per-(server, component) lookup the stream uses", () => {
    const id = serverId();
    const session = createContainerApplySession(id, "edge");

    expect(getActiveContainerApplySession(id, "edge")?.id).toBe(session.id);
    expect(getActiveContainerApplySession(id, "mail")).toBeNull();

    finishContainerApplySession(session.id, "completed", { updated: true, down: false });
    expect(getActiveContainerApplySession(id, "edge")).toBeNull();
  });

  it("lists a fleet's runs oldest-first, so a queue reads in the order it was taken", () => {
    const a = serverId();
    const b = serverId();
    const first = createContainerApplySession(a, "edge");
    const second = createContainerApplySession(b, "edge");

    const ids = listContainerApplySessions()
      .filter((s) => s.serverId === a || s.serverId === b)
      .map((s) => s.id);
    expect(ids).toEqual([first.id, second.id]);
  });
});
