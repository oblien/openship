import { describe, expect, it } from "vitest";
import { ApiError } from "./api/client";
import type { BillingState } from "./api/billing";
import { cloudDeployRecovery, cloudDeployRestriction } from "./cloud-deploy-pricing";

describe("Cloud deployment recovery", () => {
  it.each(["CLOUD_BILLING_BLOCKED", "PLAN_UPGRADE_REQUIRED"])("recognizes the explicit %s refusal", (code) => {
    expect(cloudDeployRestriction(new ApiError(402, "Payment Required", { code, reason: "build-minutes-exhausted" })))
      .toEqual({ code, reason: "build-minutes-exhausted" });
  });

  it.each([
    new TypeError("Failed to fetch"),
    new ApiError(503, "Service Unavailable", { code: "OBLIEN_NAMESPACE_POLICY_REQUIRED" }),
    new ApiError(503, "Service Unavailable", { code: "OBLIEN_BILLING_UNAVAILABLE" }),
    new ApiError(403, "Forbidden", { code: "CLOUD_REQUIRED_DEPLOY_TARGET" }),
    new ApiError(402, "Payment Required", {}),
    new ApiError(500, "Internal Server Error", { code: "CLOUD_BILLING_BLOCKED" }),
  ])("keeps infrastructure and permission errors out of pricing: %s", (error) => {
    expect(cloudDeployRestriction(error)).toBeNull();
  });

  const state = (patch: Partial<BillingState>) => ({ tier: "starter", status: "active", overQuota: false, ...patch }) as BillingState;
  const blocked = { code: "CLOUD_BILLING_BLOCKED" } as const;
  it("offers a subscription to a free account, including one with zero-credit suspension", () => {
    expect(cloudDeployRecovery(state({ tier: "free", status: "credit_exhausted", overQuota: true }), blocked)).toBe("subscribe");
    expect(cloudDeployRecovery(state({ tier: "free", status: "credit_exhausted", overQuota: true }), { code: "PLAN_UPGRADE_REQUIRED", reason: "project-limit" })).toBe("subscribe");
  });
  it("separates credit exhaustion, payment failure and manual suspension", () => {
    expect(cloudDeployRecovery(state({ status: "credit_exhausted", overQuota: true }), blocked)).toBe("credits");
    expect(cloudDeployRecovery(state({ status: "past_due", overQuota: true }), blocked)).toBe("payment");
    expect(cloudDeployRecovery(state({ status: "credit_exhausted", overQuota: false }), blocked)).toBe("paused");
    expect(cloudDeployRecovery(state({ tier: "free", status: "credit_exhausted", overQuota: false }), blocked)).toBe("paused");
  });
  it("never presents top-ups as the solution to an exhausted build or service limit", () => {
    expect(cloudDeployRecovery(state({ overQuota: true }), { code: "PLAN_UPGRADE_REQUIRED", reason: "build-minutes-exhausted" })).toBe("upgrade");
    expect(cloudDeployRecovery(state({ tier: "free", overQuota: true }), { code: "PLAN_UPGRADE_REQUIRED", reason: "free-subdomain-limit" })).toBe("upgrade");
  });
  it("does not block an existing paid plan just because purchases are disabled", () => {
    expect(cloudDeployRecovery(state({ billing: { enabled: false } }), blocked)).toBe("ready");
  });
});
