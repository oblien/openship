import { describe, expect, it } from "vitest";
import {
  canReportStreamEnd,
  reportLostStream,
  UNKNOWN_OUTCOME_MESSAGE,
} from "./prepare-stream-outcome";

/**
 * The reported bug: the verify modal streamed certbot's output, then replaced the
 * whole console with "The connection closed before the operation reported a result
 * — check the domain's status." Two separate faults met there — a result that had
 * already arrived could be overwritten by teardown, and a genuinely lost stream
 * gave up instead of reading the outcome back.
 */

describe("canReportStreamEnd", () => {
  it("lets a stream that never reported set the outcome", () => {
    expect(canReportStreamEnd(false)).toBe(true);
  });

  // The socket closing after `complete` is teardown, not a result. Treating it as
  // one is what turned a finished verify into a generic failure — and, because the
  // failure view replaced the console, took certbot's output with it.
  it("REFUSES to overwrite an outcome the server already reported", () => {
    expect(canReportStreamEnd(true)).toBe(false);
  });
});

describe("reportLostStream", () => {
  it("reports success when the server says the operation actually finished", () => {
    const report = reportLostStream({
      ok: true,
      message: "example.com is verified (SSL active) — the connection dropped after the run finished.",
    });
    expect(report.phase).toBe("completed");
    // Appended to the log rather than shown as an error: the run succeeded, this
    // only explains how we found out.
    expect(report.logLine).toContain("verified");
    expect(report.error).toBeUndefined();
  });

  it("surfaces the server's own reason for a failure, not a generic message", () => {
    const report = reportLostStream({
      ok: false,
      message: "DNS problem: NXDOMAIN looking up A for www.example.com",
    });
    expect(report.phase).toBe("failed");
    expect(report.error).toContain("NXDOMAIN");
    expect(report.error).not.toBe(UNKNOWN_OUTCOME_MESSAGE);
  });

  // Only when even the follow-up read can't answer. And it still points at the
  // log, which now stays on screen, instead of sending the operator elsewhere.
  it("admits it doesn't know only when the state couldn't be read at all", () => {
    const report = reportLostStream(null);
    expect(report.phase).toBe("failed");
    expect(report.error).toBe(UNKNOWN_OUTCOME_MESSAGE);
    expect(report.error).toContain("log above");
  });
});
