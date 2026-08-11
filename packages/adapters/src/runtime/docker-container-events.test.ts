/**
 * The `/events` line parser. It runs on every container transition on the box —
 * including from images we don't own — so the contract is: return a normalized
 * event, or return null. It must never throw, because the only thing above it is a
 * stream `data` handler whose failure kills the subscription (and with it the
 * accelerated detection the whole feature exists for).
 *
 * The daemon's payload shape is also not stable across versions, hence the two
 * field-fallback cases below.
 */
import { describe, expect, it } from "vitest";
import { parseContainerEventLine } from "./docker";

const line = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    Type: "container",
    Action: "die",
    Actor: { ID: "abc123def456", Attributes: { name: "openship-app-1" } },
    time: 1_770_000_000,
    timeNano: 1_770_000_000_123_456_789,
    ...over,
  });

describe("parseContainerEventLine", () => {
  it("normalizes a lifecycle event", () => {
    expect(parseContainerEventLine(line())).toEqual({
      containerId: "abc123def456",
      action: "die",
      atSeconds: 1_770_000_000,
    });
  });

  it("maps both settled halves of health_status", () => {
    expect(parseContainerEventLine(line({ Action: "health_status: unhealthy" }))?.action).toBe(
      "unhealthy",
    );
    // The recovery edge is load-bearing, not noise: a container whose healthcheck
    // passes again never stopped, so this is the ONLY event that reports it. Drop it
    // and an unhealthy incident is detected in seconds but stays open until the next
    // 60s poll.
    expect(parseContainerEventLine(line({ Action: "health_status: healthy" }))?.action).toBe(
      "healthy",
    );
    // `starting` is the grace period the healthcheck author asked for — no verdict
    // either way, so nothing to read state for.
    expect(parseContainerEventLine(line({ Action: "health_status: starting" }))).toBeNull();
  });

  it("ignores actions we did not ask for", () => {
    // The filter is server-side, but a daemon that ignores it must not produce a
    // sweep for `exec_start` on every dashboard terminal keystroke.
    for (const action of ["exec_start", "attach", "top", "create", "rename"]) {
      expect(parseContainerEventLine(line({ Action: action }))).toBeNull();
    }
  });

  it("falls back to the pre-1.22 field names", () => {
    const legacy = JSON.stringify({ status: "oom", id: "legacy1234567", time: 1_770_000_001 });
    expect(parseContainerEventLine(legacy)).toEqual({
      containerId: "legacy1234567",
      action: "oom",
      atSeconds: 1_770_000_001,
    });
  });

  it("derives the timestamp from timeNano when `time` is absent", () => {
    const parsed = parseContainerEventLine(line({ time: undefined }));
    expect(parsed?.atSeconds).toBe(1_770_000_000);
  });

  it("returns null instead of throwing on anything malformed", () => {
    const junk = [
      "",
      "   ",
      "not json at all",
      "{", // a chunk boundary that split mid-object
      "[]",
      "null",
      JSON.stringify({ Action: "die" }), // no id
      JSON.stringify({ Actor: { ID: "abc" } }), // no action
      JSON.stringify({ Action: "", Actor: { ID: "abc" } }),
      JSON.stringify({ Action: "die", Actor: { ID: 42 } }),
    ];
    for (const bad of junk) {
      expect(() => parseContainerEventLine(bad)).not.toThrow();
      expect(parseContainerEventLine(bad)).toBeNull();
    }
  });

  it("reassembles a payload delivered across chunk boundaries", () => {
    // What the caller does with a partial line: hold the trailing fragment, parse
    // whole lines only. Asserted here because the parser is only correct in
    // combination with that buffering.
    const whole = line();
    const chunks = [`${whole.slice(0, 20)}`, `${whole.slice(20)}\n${line({ Action: "start" })}\n`];

    let buffer = "";
    const parsed = [];
    for (const chunk of chunks) {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const one of lines) {
        if (!one.trim()) continue;
        const event = parseContainerEventLine(one);
        if (event) parsed.push(event);
      }
    }

    expect(parsed.map((e) => e.action)).toEqual(["die", "start"]);
    expect(buffer).toBe("");
  });
});
