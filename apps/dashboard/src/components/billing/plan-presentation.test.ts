import { describe, expect, it } from "vitest";
import { resolvePlan, type PlanTierId } from "@repo/core";
import { planCapacity, serverPlanChoices } from "./plan-presentation";
import type { ApiPlan } from "./PricingCards";

function plan(id: PlanTierId = "pro", locale: "en" | "ar" = "en"): ApiPlan {
  const source = resolvePlan(id, locale);
  return {
    ...source,
    features: [...source.features],
    resourceLimits: source.oblienLimits,
    listPrice: { monthly: source.price.monthly },
    effectivePrice: { monthly: source.price.monthly },
    campaign: null,
  };
}

describe("plan presentation", () => {
  it("does not infer capacity when the offer has no explicit numeric pool", () => {
    const offer = { ...plan(), resourceLimits: undefined };
    expect(planCapacity(offer)).toBeNull();
    expect(
      planCapacity({
        ...plan(),
        resourceLimits: { ...plan().resourceLimits!, max_total_vcpus: null },
      }),
    ).toBeNull();
  });
});

describe("server subscription choices", () => {
  const plans = ["hobby", "starter", "pro", "team"].map(id => plan(id as PlanTierId));
  const choices = (currentOffer?: ApiPlan, allocatedDiskGb?: number) => serverPlanChoices({ plans, currentOffer, allocatedDiskGb, interval: "monthly" });

  it("includes the entry plan and retains larger offers relative to an existing purchase", () => {
    expect(choices().available.map(plan => plan.id)).toEqual(["hobby", "starter", "pro", "team"]);
    const result = choices(plan("starter"));
    expect(result.current).toBe("starter");
    expect(result.upgrades.map(plan => plan.id)).toEqual(["pro", "team"]);
    expect(result.other.map(plan => plan.id)).toEqual(["hobby"]);
    expect(choices(plan("hobby")).upgrades.map(plan => plan.id)).toEqual(["starter", "pro", "team"]);
  });

  it("excludes offers retired by the catalog", () => {
    const retired = plans.map(plan => ({ ...plan, availableForPurchase: plan.id !== "hobby" }));
    expect(serverPlanChoices({ plans: retired, interval: "monthly" }).available.map(plan => plan.id))
      .toEqual(["starter", "pro", "team"]);
  });

  it("does not advertise a smaller disk for an inactive or subscribed server", () => {
    expect(choices(undefined, 128).available.map(plan => plan.id)).toEqual(["starter", "pro", "team"]);
    expect(choices(plan("team"), 256).available.map(plan => plan.id)).toEqual(["team"]);
    expect(choices(plan("team"), 256).upgrades).toEqual([]);
  });

  it("does not label changed catalog prices or capacity as the saved current plan", () => {
    const previous = plan("starter");
    expect(choices({ ...previous, price: { ...previous.price, monthly: 1700 } }).current).toBeNull();
    const smaller = { ...previous, resourceLimits: { ...previous.resourceLimits!, max_total_ram_mb: 6144 } };
    expect(choices(smaller).current).toBeNull();
    const cheaperSmaller = { ...smaller, price: { ...previous.price, monthly: 1700 } };
    expect(choices(cheaperSmaller).upgrades.map(plan => plan.id)).toContain("starter");
    expect(choices({ ...previous, monthlyCredits: 1000 }).current).toBeNull();
  });

  it("uses custom resources rather than its underlying tier to select larger offers", () => {
    const custom = { ...plan("starter"), configuration: "custom" as const,
      resourceLimits: { ...plan("pro").resourceLimits!, max_total_vcpus: 6 }, price: { monthly: 6000, annual: null } };
    const result = choices(custom, 64);
    expect(result.current).toBeNull();
    expect(result.upgrades.map(plan => plan.id)).toEqual(["team"]);
  });

  it("does not call a CPU increase an upgrade when it reduces purchased RAM", () => {
    const current = { ...plan("hobby"), resourceLimits: { ...plan("hobby").resourceLimits!, max_total_ram_mb: 16384 } };
    expect(choices(current).upgrades.map(plan => plan.id)).toEqual(["pro", "team"]);
  });

  it("does not guess current capacity from inherited or missing provider limits", () => {
    const current = { ...plan("starter"), resourceLimits: undefined };
    expect(choices(current).current).toBeNull();
    expect(choices(current).upgrades).toEqual([]);
  });

  it("compares annual offers using their annual saved price", () => {
    const annualPlans = plans.map(plan => ({ ...plan, price: { ...plan.price, annual: plan.price.monthly! * 10 } }));
    const currentOffer = { ...annualPlans[1]!, price: { monthly: null, annual: annualPlans[1]!.price.annual } };
    const result = serverPlanChoices({ plans: annualPlans, currentOffer, interval: "annual" });
    expect(result.current).toBe("starter");
    expect(result.upgrades.map(plan => plan.id)).toEqual(["pro", "team"]);
  });
});
