import { describe, expect, it } from "vitest";
import { isComposeDuration, parseComposeDurationNs } from "./duration";

const S = 1_000_000_000;

describe("compose durations", () => {
  it("reads compose/Go durations and bare seconds", () => {
    expect(parseComposeDurationNs("90s")).toBe(90 * S);
    expect(parseComposeDurationNs("1m30s")).toBe(90 * S);
    expect(parseComposeDurationNs("1h2m3s")).toBe(3723 * S);
    expect(parseComposeDurationNs("500ms")).toBe(S / 2);
    expect(parseComposeDurationNs("1.5s")).toBe(1.5 * S);
    expect(parseComposeDurationNs("30")).toBe(30 * S);
    expect(parseComposeDurationNs(30)).toBe(30 * S);
    expect(parseComposeDurationNs(" 90s ")).toBe(90 * S);
    expect(parseComposeDurationNs("0s")).toBe(0);
  });

  it("preserves valid Compose signs, decimal forms and extended units", () => {
    for (const [value, expected] of [
      ["+90s", 90 * S],
      ["+1m30s", 90 * S],
      [".5s", S / 2],
      ["+.5s", S / 2],
      ["1.s", S],
      ["1m.5s", 60.5 * S],
      ["1.5h", 5400 * S],
      ["1d2h", 93600 * S],
      ["1w", 604800 * S],
      ["1μs", 1000],
      ["+30", 30 * S],
      [".5", S / 2],
    ] as const) {
      expect(parseComposeDurationNs(value), value).toBe(expected);
      expect(isComposeDuration(value), value).toBe(true);
    }
  });

  // The bug this exists for: a scan for unit groups read these as SOME duration,
  // shorter than or unrelated to what was written, and applied it silently.
  it("reads a partial match as no duration at all, never as part of one", () => {
    for (const value of [
      "1m30",
      "abc5s",
      "5s junk",
      "10 m",
      "1m 30s",
      "30S",
      "-5s",
      "+",
      ".s",
      "1s+2s",
      "1..5s",
    ]) {
      expect(parseComposeDurationNs(value), value).toBeUndefined();
    }
  });

  it("rejects overflow before a duration reaches Docker", () => {
    for (const value of ["9".repeat(400) + "s", "9223372036854775808ns", "99999999999999999999h"]) {
      expect(parseComposeDurationNs(value), value).toBeUndefined();
      expect(isComposeDuration(value), value).toBe(false);
    }
  });

  it("keeps strict config whitespace while tolerating it at runtime", () => {
    expect(isComposeDuration(" 90s ")).toBe(false);
    expect(parseComposeDurationNs(" 90s ")).toBe(90 * S);
  });

  it("treats absent and blank as unset", () => {
    expect(parseComposeDurationNs(undefined)).toBeUndefined();
    expect(parseComposeDurationNs(null)).toBeUndefined();
    expect(parseComposeDurationNs("")).toBeUndefined();
    expect(parseComposeDurationNs("   ")).toBeUndefined();
  });

  it("validates exactly what it parses", () => {
    for (const value of ["90s", "1m30s", "500ms", "30", "1m30", "soon", "abc5s"]) {
      expect(isComposeDuration(value), value).toBe(parseComposeDurationNs(value) !== undefined);
    }
  });
});
