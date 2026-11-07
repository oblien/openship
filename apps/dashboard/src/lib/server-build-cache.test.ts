import { describe, expect, it } from "vitest";
import { budgetBytesToGib, parseBudgetGib } from "./server-build-cache";

const GIB = 1024 ** 3;

describe("build-cache budget input", () => {
  it("accepts whole GiB inside the API bounds and returns bytes", () => {
    expect(parseBudgetGib("24")).toBe(24 * GIB);
    expect(parseBudgetGib(" 1 ")).toBe(GIB);
    expect(parseBudgetGib("65536")).toBe(65536 * GIB);
    expect(parseBudgetGib("1.5")).toBe(1.5 * GIB);
    expect(parseBudgetGib("1,5")).toBe(1.5 * GIB);
  });

  it("rejects values the API would refuse instead of sending them", () => {
    for (const input of ["", "0", "0.5", "65537", "2.555", "1,2,3", "-4", "10GB", "1e3"]) {
      expect(parseBudgetGib(input)).toBeNull();
    }
  });

  it("shows a stored budget in GiB, keeping a fraction set through the API", () => {
    expect(budgetBytesToGib(24 * GIB)).toBe("24");
    expect(budgetBytesToGib(1.5 * GIB)).toBe("1.5");
    expect(parseBudgetGib(budgetBytesToGib(1.5 * GIB))).toBe(1.5 * GIB);
    expect(budgetBytesToGib(null)).toBe("");
    expect(budgetBytesToGib(undefined)).toBe("");
  });
});
