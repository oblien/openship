import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { PLANS } from "@repo/core";
import { BillingPlansSchema } from "../src/billing";

const limits = BillingPlansSchema.properties.plans.items.properties.limits;

describe("public Cloud build allowances", () => {
  it.each([0, 1, 4, 8, 20, null])(
    "accepts the published concurrency allowance %s",
    (concurrentBuilds) => {
      expect(Value.Check(limits, { ...PLANS.hobby.limits, concurrentBuilds })).toBe(true);
    },
  );
  it("accepts an older offer without inventing a concurrency cap", () => {
    const { concurrentBuilds: _omitted, ...old } = PLANS.hobby.limits;
    expect(Value.Check(limits, old)).toBe(true);
    expect(old).not.toHaveProperty("concurrentBuilds");
  });
  it.each([-1, 0.5, "4"])("rejects an invalid allowance %s", (concurrentBuilds) => {
    expect(Value.Check(limits, { ...PLANS.hobby.limits, concurrentBuilds })).toBe(false);
  });
});
