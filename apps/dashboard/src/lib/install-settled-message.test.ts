import { describe, expect, it } from "vitest";
import { installSettledMessage } from "./install-settled-message";

const FAILED = "Install failed";

describe("installSettledMessage", () => {
  // The shipped bug: a user Stop resolved with cancelled=true AND fell through the
  // message chain to the generic failure string, so the card read
  // "Install cancelled" / "Install failed".
  it("never hands a cancel the failure fallback", () => {
    expect(
      installSettledMessage({ isCancel: true, serverMessage: "", failedFallback: FAILED }),
    ).toBe("");
    expect(
      installSettledMessage({
        isCancel: true,
        serverMessage: null,
        streamMessage: "Build cancelled",
        failedFallback: FAILED,
      }),
    ).toBe("");
  });

  // The boot sweep and a superseded release write a real reason onto the row; that
  // is worth showing, and it is the only thing a cancel will show.
  it("shows a cancel's real server-side reason when there is one", () => {
    const reason = "Interrupted by a server restart — redeploy to try again.";
    expect(
      installSettledMessage({ isCancel: true, serverMessage: reason, failedFallback: FAILED }),
    ).toBe(reason);
  });

  it("keeps the full chain for a genuine failure", () => {
    expect(
      installSettledMessage({
        isCancel: false,
        serverMessage: "clickhouse exited 1",
        streamMessage: "Build failed",
        failedFallback: FAILED,
      }),
    ).toBe("clickhouse exited 1");
    expect(
      installSettledMessage({ isCancel: false, streamMessage: "Build failed", failedFallback: FAILED }),
    ).toBe("Build failed");
  });

  // A failure with nothing to say still needs a verdict — the fallback is all that
  // stands between the operator and a blank card.
  it("falls back to the localised failure string only for a failure", () => {
    expect(installSettledMessage({ isCancel: false, failedFallback: FAILED })).toBe(FAILED);
  });
});
