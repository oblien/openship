import { describe, expect, it } from "vitest";

import { parseLogEntry } from "./deploymentPhaseDetector";

describe("parseLogEntry", () => {
  it("clamps negative elapsed time to 00:00 for phase markers", () => {
    const startTime = Date.parse("2026-01-01T00:01:00Z");

    expect(parseLogEntry("---PHASE: build---", "2026-01-01T00:00:30Z", startTime)).toEqual({
      type: "info",
      text: "",
      time: "00:00",
    });
  });

  it("clamps negative elapsed time to 00:00 for regular log lines", () => {
    const startTime = Date.parse("2026-01-01T00:01:00Z");

    expect(parseLogEntry("Building application", "2026-01-01T00:00:30Z", startTime).time).toBe(
      "00:00",
    );
  });

  it("preserves normal elapsed-time formatting for in-order events", () => {
    const startTime = Date.parse("2026-01-01T00:01:00Z");

    expect(parseLogEntry("Deployment complete!", "2026-01-01T00:02:05Z", startTime)).toEqual({
      type: "success",
      text: "Deployment complete!",
      time: "01:05",
    });
  });
});
