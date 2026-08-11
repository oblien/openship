import { describe, it, expect } from "vitest";
import { bisectDone, bisectMidpoint, bisectStep } from "../../src/lib/bisect";

describe("bisectMidpoint / bisectDone", () => {
  it("has no midpoint left once only the good/bad boundary pair remains", () => {
    expect(bisectMidpoint([1, 2])).toBe(-1);
    expect(bisectDone([1, 2])).toBe(true);
  });

  it("picks the middle index for a larger range", () => {
    expect(bisectMidpoint([1, 2, 3])).toBe(1);
    expect(bisectMidpoint([1, 2, 3, 4, 5])).toBe(2);
    expect(bisectDone([1, 2, 3])).toBe(false);
  });
});

describe("bisectStep", () => {
  const range = [1, 2, 3, 4, 5];

  it("good moves the good boundary up to the candidate", () => {
    expect(bisectStep(range, 2, "good")).toEqual([3, 4, 5]);
  });

  it("bad moves the bad boundary down to the candidate", () => {
    expect(bisectStep(range, 2, "bad")).toEqual([1, 2, 3]);
  });

  it("skip drops the candidate and keeps both boundaries", () => {
    expect(bisectStep(range, 2, "skip")).toEqual([1, 2, 4, 5]);
  });
});

describe("full binary search converges to the first bad element", () => {
  it("finds the boundary between good and bad in a monotonic history", () => {
    // element index 6 (value 6) is the first "bad" one — everything before is good.
    const history = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const firstBadIndex = 6;
    let range = history;
    let steps = 0;
    while (!bisectDone(range)) {
      const mid = bisectMidpoint(range);
      range = bisectStep(range, mid, range[mid] >= firstBadIndex ? "bad" : "good");
      steps++;
      expect(steps).toBeLessThan(10); // sanity: must converge, never loop forever
    }
    expect(range).toEqual([firstBadIndex - 1, firstBadIndex]);
  });

  it("skip drops the untestable candidate and still converges, without ever mislabeling the boundary", () => {
    // A skipped candidate is never determined good or bad, so the final
    // bracket may be wider than the minimal pair — but it must still be
    // correct: range[0] genuinely good, range[last] genuinely bad.
    const history = [0, 1, 2, 3, 4, 5];
    const firstBadIndex = 4;
    let range = history;
    let skippedOnce = false;
    let steps = 0;
    while (!bisectDone(range)) {
      const mid = bisectMidpoint(range);
      if (!skippedOnce) {
        range = bisectStep(range, mid, "skip");
        skippedOnce = true;
      } else {
        range = bisectStep(range, mid, range[mid] >= firstBadIndex ? "bad" : "good");
      }
      steps++;
      expect(steps).toBeLessThan(10);
    }
    expect(range).toHaveLength(2);
    expect(range[0]).toBeLessThan(firstBadIndex);
    expect(range[1]).toBeGreaterThanOrEqual(firstBadIndex);
  });
});
