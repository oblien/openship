import { describe, it, expect } from "vitest";
import { CATEGORIES, CATEGORY_GROUPS, findCategory } from "../../../src/lib/notification-categories";

describe("notification categories — Operator", () => {
  it("has no billing group or SaaS quota categories", () => {
    expect(CATEGORY_GROUPS.map((g) => g.id)).not.toContain("billing");
    expect(CATEGORIES.map((c) => c.id)).not.toContain("billing.alert");
    expect(CATEGORIES.map((c) => c.id)).not.toContain("quota.warning");
    expect(findCategory("billing.alert")).toBeUndefined();
    expect(findCategory("quota.warning")).toBeUndefined();
  });
});
