import { describe, expect, it } from "vitest";
import { canConfirmRestore, canRequestRestorePlan, restoreModeCopy } from "./restore-ui";
import type { RestorePlanUI } from "@/lib/api";

const plan = (mode: RestorePlanUI["mode"], rebuildServices: string[] = []): RestorePlanUI => ({
  mode,
  needsRepository: false,
  rebuildServices,
  untouchedServices: [],
  ...(mode === "ineligible" ? { code: "NO_SOURCE", reason: "No restorable source." } : {}),
});

describe("deployment restore UI", () => {
  it("asks the API about every settled successful inactive release", () => {
    expect(canRequestRestorePlan({ status: "success", isActive: false })).toBe(true);
    expect(canRequestRestorePlan({ status: "partial_failure", isActive: false })).toBe(true);
    expect(canRequestRestorePlan({ status: "success", isActive: true })).toBe(false);
    expect(canRequestRestorePlan({ status: "failed", isActive: false })).toBe(false);
  });

  it("gives registry reacquisition its own confirmation copy", () => {
    expect(restoreModeCopy(plan("reacquire-image"))).toBe("reacquire-image");
    expect(restoreModeCopy(plan("rebuild"))).toBe("rebuild");
    expect(restoreModeCopy(plan("redeploy-pinned", ["worker"]))).toBe("mixed");
  });

  it("never confirms a restore the API marked ineligible", () => {
    expect(canConfirmRestore(plan("ineligible"))).toBe(false);
    expect(canConfirmRestore(plan("reacquire-image"))).toBe(true);
    expect(canConfirmRestore(null)).toBe(true);
  });
});
