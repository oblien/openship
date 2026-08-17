import { describe, expect, it } from "vitest";
import { terminalMessages } from "./terminal-messages";

/**
 * The status read's terminal prose. This gate used to be `effectiveStatus ===
 * "failed"` alone, which discarded the reason on every CANCELLED row — and a
 * cancel is not always a user's Stop. With nothing to show, the app-install wizard
 * fell through to its own generic "Install failed" string and printed it under the
 * heading "Install cancelled".
 */
describe("terminalMessages", () => {
  const warn = "Some services failed to deploy.";

  it("carries a failed deployment's reason", () => {
    expect(
      terminalMessages({
        effectiveStatus: "failed",
        rowStatus: "failed",
        errorMessage: "clickhouse exited 1",
        warning: null,
      }),
    ).toEqual({ failureMessage: "clickhouse exited 1", warningMessage: "" });
  });

  // The boot sweep: cancelled after an API restart, with its own reason on the row.
  it("carries a cancelled deployment's reason instead of discarding it", () => {
    const reason = "Interrupted by a server restart — redeploy to try again.";
    expect(
      terminalMessages({
        effectiveStatus: "cancelled",
        rowStatus: "cancelled",
        errorMessage: reason,
        warning: null,
      }).failureMessage,
    ).toBe(reason);
  });

  /**
   * The skew case, and the reason this reads the ROW and not just the SSE-facing
   * status: `supersedePendingDecisions` cancels the deployment row while its build
   * session has already finished `ready`, so `effectiveStatus` is "ready". Gating on
   * `effectiveStatus` alone blanks the one message that explains the outcome — and
   * the dashboard decides "this was a cancel" from the row, so it would show a
   * cancel with no reason and invent "You stopped this install."
   */
  it("carries the reason when the row is cancelled but the session settled ready", () => {
    const reason = "Superseded by a newer deployment while awaiting a keep/reject decision.";
    const out = terminalMessages({
      effectiveStatus: "ready",
      rowStatus: "cancelled",
      errorMessage: reason,
      warning: warn,
    });
    expect(out.failureMessage).toBe(reason);
    // Both are true here and both are kept: the supersede reason and the partial
    // outcome are different facts about the same row.
    expect(out.warningMessage).toBe(warn);
  });

  // A user's Stop writes no errorMessage at all — there is genuinely nothing to
  // say, and the view supplies its own cancel copy rather than a borrowed failure.
  it("returns an empty reason for a plain user cancel, never a stand-in", () => {
    expect(
      terminalMessages({
        effectiveStatus: "cancelled",
        rowStatus: "cancelled",
        errorMessage: null,
        warning: null,
      }),
    ).toEqual({ failureMessage: "", warningMessage: "" });
  });

  it("never dresses a healthy deployment's message as a failure", () => {
    expect(
      terminalMessages({
        effectiveStatus: "ready",
        rowStatus: "ready",
        errorMessage: "a stale message from an earlier attempt",
        warning: warn,
      }),
    ).toEqual({ failureMessage: "", warningMessage: warn });
  });

  // partial_failure is settled-but-not-failed: the warning is how the operator
  // learns which services didn't come up.
  it("keeps the partial-deploy warning on a settled non-failure", () => {
    expect(
      terminalMessages({
        effectiveStatus: "ready",
        rowStatus: "partial_failure",
        errorMessage: null,
        warning: warn,
      }),
    ).toEqual({ failureMessage: "", warningMessage: warn });
  });

  it("suppresses the warning once the outcome is a failure", () => {
    expect(
      terminalMessages({
        effectiveStatus: "failed",
        rowStatus: "failed",
        errorMessage: "boom",
        warning: warn,
      }).warningMessage,
    ).toBe("");
  });
});
