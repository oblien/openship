import { describe, it, expect } from "vitest";
import { AppError } from "@repo/core";
import { assertBillingEnabled, assertTopupsEnabled } from "@repo/platform/engine/modules/billing/billing.service";

/**
 * The master billing switch (`BILLING_ENABLED`) and the top-ups sub-switch
 * (`BILLING_TOPUPS_ENABLED`) both default to OFF. These guards are the
 * server-side backstop for new purchases: every checkout path calls one of
 * them, so a stale client cannot start a purchase while billing is pre-launch.
 * Existing customer management remains available independently of these flags.
 *
 * The test env inherits the defaults (both flags off), so this pins the
 * shipped-today behavior: mutations fail closed with a typed 403.
 */
describe("billing feature gate (default = disabled)", () => {
  it("assertBillingEnabled throws BILLING_NOT_ENABLED (403) when the master switch is off", () => {
    let thrown: unknown;
    try {
      assertBillingEnabled();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppError);
    const e = thrown as AppError;
    expect(e.code).toBe("BILLING_NOT_ENABLED");
    expect(e.statusCode).toBe(403);
  });

  it("assertTopupsEnabled throws (403) while billing is disabled", () => {
    let thrown: unknown;
    try {
      assertTopupsEnabled();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppError);
    // Master switch is checked first, so a fully-off config surfaces the
    // master error rather than the sub-switch one.
    expect((thrown as AppError).code).toBe("BILLING_NOT_ENABLED");
    expect((thrown as AppError).statusCode).toBe(403);
  });
});
