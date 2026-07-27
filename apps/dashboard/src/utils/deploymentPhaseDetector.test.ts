import { describe, expect, it } from "vitest";

import { aggregatePhaseInfo, detectPhase, parseLogEntry } from "./deploymentPhaseDetector";

describe("detectPhase", () => {
  describe("explicit ---PHASE: xxx--- markers", () => {
    it("recognizes every documented phase alias", () => {
      expect(detectPhase("---PHASE: clone---")).toEqual({
        phase: "cloning",
        progress: 5,
        stepIndex: 0,
      });
      expect(detectPhase("---PHASE: cloning---")).toEqual({
        phase: "cloning",
        progress: 5,
        stepIndex: 0,
      });
      expect(detectPhase("---PHASE: install---")).toEqual({
        phase: "installing",
        progress: 25,
        stepIndex: 1,
      });
      expect(detectPhase("---PHASE: dependencies---")).toEqual({
        phase: "installing",
        progress: 25,
        stepIndex: 1,
      });
      expect(detectPhase("---PHASE: build---")).toEqual({
        phase: "building",
        progress: 50,
        stepIndex: 2,
      });
      expect(detectPhase("---PHASE: deploy---")).toEqual({
        phase: "deploying",
        progress: 75,
        stepIndex: 3,
      });
      expect(detectPhase("---PHASE: upload---")).toEqual({
        phase: "deploying",
        progress: 75,
        stepIndex: 3,
      });
      expect(detectPhase("---PHASE: ready---")).toEqual({
        phase: "ready",
        progress: 100,
        stepIndex: 4,
      });
      expect(detectPhase("---PHASE: done---")).toEqual({
        phase: "ready",
        progress: 100,
        stepIndex: 4,
      });
      expect(detectPhase("---PHASE: complete---")).toEqual({
        phase: "ready",
        progress: 100,
        stepIndex: 4,
      });
    });

    it("is case-insensitive on both the PHASE keyword and the phase name", () => {
      expect(detectPhase("---phase: BUILD---")).toEqual({
        phase: "building",
        progress: 50,
        stepIndex: 2,
      });
      expect(detectPhase("---Phase: Ready---")).toEqual({
        phase: "ready",
        progress: 100,
        stepIndex: 4,
      });
    });

    it("falls back to cloning/0 progress for an unrecognized phase name, discarding any real progress in the rest of the line", () => {
      // Garbage marker names aren't in the lookup table, so the code takes the
      // `|| { phase: "cloning", stepIndex: 0, progress: 0 }` fallback. Note this
      // returns progress 0 even though the surrounding text screams "100% success" -
      // once a marker is present the rest of the text is ignored entirely.
      expect(detectPhase("---PHASE: xyz123--- 100% success")).toEqual({
        phase: "cloning",
        progress: 0,
        stepIndex: 0,
      });
    });

    it("gives the marker priority over keyword patterns even when both are present", () => {
      // Marker parsing happens before the pattern-matching block and returns
      // immediately, so a "cloning" marker wins even though the message body
      // is unmistakably about a finished, successful build.
      expect(detectPhase("---PHASE: cloning--- Deployment complete! 🎉")).toEqual({
        phase: "cloning",
        progress: 5,
        stepIndex: 0,
      });
    });

    it("does not match a marker missing its closing dashes, and falls through to keyword detection instead", () => {
      // Only two trailing dashes instead of three - the marker regex requires
      // an exact "---" close, so this is not treated as a marker at all.
      expect(detectPhase("---PHASE: build--")).toEqual({
        phase: "building",
        progress: 50,
        stepIndex: 2,
      });
    });

    it("does not match a marker whose phase name contains a hyphen", () => {
      // "\w+" stops at the hyphen in "pre-build", so "---PHASE: pre-build---"
      // never satisfies the full marker regex and silently falls back to
      // ordinary keyword matching on the raw text (which still contains "build").
      expect(detectPhase("---PHASE: pre-build---")).toEqual({
        phase: "building",
        progress: 50,
        stepIndex: 2,
      });
    });
  });

  describe("keyword pattern precedence", () => {
    it("prefers the furthest-along phase when a line matches more than one pattern", () => {
      // "installing dependencies for build" matches both the installing
      // pattern (/dependencies/i) and the building pattern (/build(ing)?/i).
      // The if/else chain checks ready > deploying > building > installing >
      // cloning in that order, so the later stage in the pipeline wins.
      expect(detectPhase("installing dependencies for build").phase).toBe("building");
    });

    it("prefers building over cloning when a line mentions both", () => {
      expect(detectPhase("cloning then building the app").phase).toBe("building");
    });

    it("prefers ready over every other stage, even mid-deploy language", () => {
      expect(detectPhase("deployment complete, now live and running").phase).toBe("ready");
    });

    it("matches the bare /dependencies/i pattern even without the word 'install'", () => {
      expect(detectPhase("this package has peer dependencies").phase).toBe("installing");
    });

    it("treats any substring 'done' as a ready signal, including inside unrelated words", () => {
      // /done/i is unanchored, so it also fires on "condone" - a false positive
      // baked into the current pattern list, not something this test invents.
      expect(detectPhase("we condone this approach").phase).toBe("ready");
    });
  });

  describe("progress calculation", () => {
    it("scales an explicit percentage within the current phase's 25-point band", () => {
      // building baseValue is 50; 45% scales to 50 + (45/100)*25 = 61.25.
      expect(detectPhase("Building 45%").progress).toBe(61.25);
    });

    it("bumps progress by 20 (capped at 100) on completion words when no percent is present", () => {
      expect(detectPhase("Building complete").progress).toBe(70);
    });

    it("caps the completion bump at 100 instead of overshooting", () => {
      expect(detectPhase("deployment complete, success ✓").progress).toBe(100);
    });

    it("defaults to the phase's base progress when there is no percent or completion signal", () => {
      expect(detectPhase("Uploading files to edge network").progress).toBe(75);
    });
  });

  describe("empty and degenerate input", () => {
    it("returns the cloning default for an empty string", () => {
      expect(detectPhase("")).toEqual({ phase: "cloning", progress: 0, stepIndex: 0 });
    });

    it("returns the cloning default for whitespace-only input", () => {
      expect(detectPhase("   \n\t  ")).toEqual({ phase: "cloning", progress: 0, stepIndex: 0 });
    });

    it("returns the cloning default for input that matches no pattern at all", () => {
      expect(detectPhase("asdkjfh qweoiruqwoeiru")).toEqual({
        phase: "cloning",
        progress: 0,
        stepIndex: 0,
      });
    });

    it("still finds a late match inside a very long line", () => {
      const longPrefix = "x".repeat(50_000);
      const result = detectPhase(`${longPrefix} deployment ready`);
      expect(result.phase).toBe("ready");
      expect(result.progress).toBe(100);
    });
  });
});

describe("parseLogEntry", () => {
  it("formats a positive elapsed time as zero-padded mm:ss", () => {
    const entry = parseLogEntry("Cloning repository", "1970-01-01T00:01:05.000Z", 0);
    expect(entry.time).toBe("01:05");
    expect(entry.text).toBe("Cloning repository");
    expect(entry.type).toBe("info");
  });

  it("does not pad minutes past two digits", () => {
    // 3661s = 61 minutes, 1 second.
    const entry = parseLogEntry("still going", "1970-01-01T01:01:01.000Z", 0);
    expect(entry.time).toBe("61:01");
  });

  it("produces a malformed negative time string when the timestamp precedes startTime", () => {
    // This is a genuine quirk: if the timestamp is earlier than startTime (clock
    // skew, out-of-order events), the elapsed seconds go negative and
    // padStart never adds a sign-aware "0", so the minutes/seconds render as
    // e.g. "-2:-40" rather than being clamped to zero.
    const entry = parseLogEntry("late-arriving log", new Date(0).toISOString(), 100_000);
    expect(entry.time).toBe("-2:-40");
  });

  describe("type classification", () => {
    it("classifies a checkmark as success", () => {
      expect(parseLogEntry("Build finished ✓", "1970-01-01T00:00:00.000Z", 0).type).toBe("success");
    });

    it("classifies the party emoji as success", () => {
      expect(parseLogEntry("Deployed 🎉", "1970-01-01T00:00:00.000Z", 0).type).toBe("success");
    });

    it("classifies plain 'done' as success", () => {
      expect(parseLogEntry("Done.", "1970-01-01T00:00:00.000Z", 0).type).toBe("success");
    });

    it("classifies fail/error language as error", () => {
      expect(parseLogEntry("Build failed with errors", "1970-01-01T00:00:00.000Z", 0).type).toBe(
        "error",
      );
    });

    it("classifies the ✗ and ❌ markers as error", () => {
      expect(parseLogEntry("Step ✗ failed", "1970-01-01T00:00:00.000Z", 0).type).toBe("error");
      expect(parseLogEntry("Step ❌", "1970-01-01T00:00:00.000Z", 0).type).toBe("error");
    });

    it("prefers success over error when a line contains both keywords", () => {
      // The success check runs first in the if/else chain, so a line like
      // "Success: no errors found" is classified success, not error, even
      // though lowerText.includes("error") is also true.
      expect(parseLogEntry("Success: no errors found", "1970-01-01T00:00:00.000Z", 0).type).toBe(
        "success",
      );
    });

    it("defaults to info when no success or error keywords are present", () => {
      expect(parseLogEntry("Resolving packages", "1970-01-01T00:00:00.000Z", 0).type).toBe("info");
    });
  });

  describe("phase marker handling", () => {
    it("hides a phase marker line by returning empty text and type info", () => {
      const entry = parseLogEntry("---PHASE: build---", "1970-01-01T00:00:10.000Z", 0);
      expect(entry).toEqual({ type: "info", text: "", time: "00:10" });
    });

    it("hides a marker even when it is wrapped in extra whitespace", () => {
      const entry = parseLogEntry("  ---PHASE: deploy---  ", "1970-01-01T00:00:00.000Z", 0);
      expect(entry.text).toBe("");
      expect(entry.type).toBe("info");
    });
  });

  describe("malformed input", () => {
    it("trims surrounding whitespace from ordinary text", () => {
      const entry = parseLogEntry("   spaced out log line   ", "1970-01-01T00:00:00.000Z", 0);
      expect(entry.text).toBe("spaced out log line");
    });

    it("handles an empty string without throwing, producing empty trimmed text and type info", () => {
      const entry = parseLogEntry("", "1970-01-01T00:00:00.000Z", 0);
      expect(entry.text).toBe("");
      expect(entry.type).toBe("info");
    });

    it("handles an unparseable timestamp by propagating NaN into the time string rather than throwing", () => {
      // `new Date("not-a-date").getTime()` is NaN, so every downstream
      // arithmetic op (floor, %, padStart) stays NaN/"NaN" instead of
      // throwing - the function degrades silently rather than erroring.
      const entry = parseLogEntry("some log", "not-a-date", 0);
      expect(entry.time).toBe("NaN:NaN");
    });
  });
});

describe("aggregatePhaseInfo", () => {
  it("returns the cloning default for an empty log array", () => {
    expect(aggregatePhaseInfo([])).toEqual({ phase: "cloning", progress: 0, stepIndex: 0 });
  });

  it("matches detectPhase for a single log entry", () => {
    const logs = [{ type: "info" as const, text: "Building 40%", time: "00:05" }];
    expect(aggregatePhaseInfo(logs)).toEqual(detectPhase("Building 40%"));
  });

  it("picks the furthest-along phase among conflicting entries, not simply the last one", () => {
    // The lower-progress entry ("installing") is listed last, but
    // aggregatePhaseInfo must still find the max progress across the window
    // rather than just taking the final log in the array.
    const logs = [
      { type: "info" as const, text: "Deploying to edge network", time: "00:01" },
      { type: "info" as const, text: "Installing dependencies", time: "00:10" },
    ];
    const result = aggregatePhaseInfo(logs);
    expect(result.phase).toBe("deploying");
  });

  it("only considers the last 5 logs, ignoring an earlier high-progress entry outside that window", () => {
    // logs[0] reports a finished, 100%-progress deployment, but it falls
    // outside `logs.slice(-5)`. The remaining 5 "cloning" entries all report
    // progress 0, and because the loop only updates on strict `>` against an
    // initial maxProgress of 0, the result stays at the cloning default -
    // the ready phase from logs[0] is invisible to the aggregate.
    const logs = [
      { type: "success" as const, text: "Deployment complete! 🎉", time: "00:00" },
      { type: "info" as const, text: "Cloning repository", time: "01:00" },
      { type: "info" as const, text: "Cloning repository", time: "02:00" },
      { type: "info" as const, text: "Cloning repository", time: "03:00" },
      { type: "info" as const, text: "Cloning repository", time: "04:00" },
      { type: "info" as const, text: "Cloning repository", time: "05:00" },
    ];
    expect(aggregatePhaseInfo(logs)).toEqual({ phase: "cloning", progress: 0, stepIndex: 0 });
  });

  it("reflects a later phase overtaking an earlier one within the 5-log window", () => {
    const logs = [
      { type: "info" as const, text: "Cloning repository", time: "00:00" },
      { type: "info" as const, text: "Installing dependencies", time: "00:10" },
      { type: "info" as const, text: "Building application", time: "00:20" },
      { type: "info" as const, text: "Uploading to edge network", time: "00:30" },
      { type: "success" as const, text: "Deployment ready", time: "00:40" },
    ];
    expect(aggregatePhaseInfo(logs).phase).toBe("ready");
  });
});
