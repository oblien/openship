import { describe, expect, it } from "vitest";
import { shouldRetryLiveStream } from "./live-stream-policy";

/**
 * Retry matrix for #667 live service logs: an unexpected drop retries a
 * bounded number of times while the tab is watching; container exit, our own
 * teardown, and a hidden tab never retry.
 */
const base = { attempts: 0, maxAttempts: 5 };

describe("shouldRetryLiveStream", () => {
  it("retries an unexpected drop on the visible tab", () => {
    expect(shouldRetryLiveStream({ ...base, exited: false, stopping: false, active: true })).toBe(
      true,
    );
  });

  it("stops at the attempt cap", () => {
    expect(
      shouldRetryLiveStream({ ...base, attempts: 5, exited: false, stopping: false, active: true }),
    ).toBe(false);
    expect(
      shouldRetryLiveStream({ ...base, attempts: 4, exited: false, stopping: false, active: true }),
    ).toBe(true);
  });

  it("never retries after the container stream ended", () => {
    expect(shouldRetryLiveStream({ ...base, exited: true, stopping: false, active: true })).toBe(
      false,
    );
  });

  it("never retries a teardown we initiated ourselves", () => {
    expect(shouldRetryLiveStream({ ...base, stopping: true, exited: false, active: true })).toBe(
      false,
    );
  });

  it("never retries for a tab that is no longer visible", () => {
    expect(shouldRetryLiveStream({ ...base, exited: false, stopping: false, active: false })).toBe(
      false,
    );
  });
});
