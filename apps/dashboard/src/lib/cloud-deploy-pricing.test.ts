import { describe, expect, it } from "vitest";
import { ApiError } from "./api/client";
import type { BillingState } from "./api/billing";
import { cloudDeployRecovery, cloudDeployRestriction, cloudCapacityRestriction, cloudDeployFailure, cloudDeployCapacityFailure } from "./cloud-deploy-pricing";
import { monthlyCompute } from "../../test/helpers/monthly-billing";

describe("Cloud deployment recovery", () => {
  it("restores managed build-capacity refusal while keeping payment recovery separate", () => {
    expect(cloudDeployCapacityFailure({ errorCode: "CLOUD_WORKSPACE_BUILD_CAPACITY", projectId: "project",
      errorDetails: { workspaceId: "space" } })?.body).toMatchObject({ code: "CLOUD_WORKSPACE_BUILD_CAPACITY", workspaceId: "space" });
    expect(cloudDeployCapacityFailure({ errorCode: "CLOUD_BILLING_BLOCKED", projectId: "project" })).toBeNull();
  });
  it.each(["CLOUD_BILLING_BLOCKED", "PLAN_UPGRADE_REQUIRED"])("restores persisted %s failures for app and project deployments", (errorCode) => {
    expect(cloudDeployRestriction(cloudDeployFailure({ errorCode, errorDetails: { reason: "resource-tier" } })))
      .toEqual({ code: errorCode, reason: "resource-tier" });
  });
  it("requires project identity for capacity recovery and excludes unrelated failures", () => {
    expect(cloudDeployFailure({ errorCode: "CLOUD_CAPACITY_REQUIRED" })).toBeNull();
    expect(cloudDeployFailure({ errorCode: "CLOUD_RUNTIME_PROXY_UNAVAILABLE", projectId: "project" })).toBeNull();
    expect(cloudCapacityRestriction(cloudDeployFailure({ errorCode: "CLOUD_CAPACITY_REQUIRED", errorDetails: { projectId: "project" } })))
      .toMatchObject({ projectId: "project" });
  });
  it("uses delta accounting only when admission verified a reusable workspace", () => {
    const requested = { cpuCores: 1, memoryMb: 2048, diskMb: 8192 };
    const refusal = (capacity: unknown) => new ApiError(409, "Conflict", { code: "CLOUD_CAPACITY_REQUIRED", projectId: "project", capacity });
    expect(cloudCapacityRestriction(refusal({ requested }))).toMatchObject({ requested, reusesWorkspace: false });
    expect(cloudCapacityRestriction(refusal({ requested, existing: requested }))).toMatchObject({ requested, reusesWorkspace: true });
    expect(cloudCapacityRestriction(refusal({ requested: { ...requested, cpuCores: NaN } }))?.requested).toBeUndefined();
    expect(cloudCapacityRestriction(new ApiError(409, "Conflict", { code: "OWNER_LIMIT_REACHED" }))).toBeNull();
  });
  it("restores build adjustment alongside a plan upgrade with the actual failure message", () => {
    const buildResources = { cpuCores: 1, memoryMb: 8192, diskMb: 32768 };
    const failure = cloudDeployFailure({
      errorCode: "PLAN_UPGRADE_REQUIRED", projectId: "project",
      errorMessage: "Build exceeds the workspace memory limit",
      errorDetails: { reason: "workspace-capacity", capacity: { buildResources } },
    });
    expect(cloudCapacityRestriction(failure)).toMatchObject({
      projectId: "project", buildResources, scope: "workspace", message: "Build exceeds the workspace memory limit",
    });
    expect(cloudDeployRestriction(failure)?.code).toBe("PLAN_UPGRADE_REQUIRED");
  });
  it("keeps source-build details for pool failures and distinguishes image-only requests", () => {
    const failure = (buildResources: unknown) => new ApiError(409, "Conflict", {
      code: "CLOUD_CAPACITY_REQUIRED", projectId: "project", capacity: { buildResources },
    });
    expect(cloudCapacityRestriction(failure(null))).toMatchObject({ buildResources: null, scope: "pool" });
    expect(cloudCapacityRestriction(failure({ cpuCores: 0.25, memoryMb: 512, diskMb: 8192 }))?.buildResources)
      .toEqual({ cpuCores: 0.25, memoryMb: 512, diskMb: 8192 });
    expect(cloudCapacityRestriction(failure({ cpuCores: 0, memoryMb: 512, diskMb: 8192 }))?.buildResources).toBeUndefined();
    expect(cloudCapacityRestriction(new ApiError(402, "Plan required", {
      code: "PLAN_UPGRADE_REQUIRED", projectId: "project", capacity: { buildResources: null },
    }))).toBeNull();
  });
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
  it.each(["active", "past_due", "canceled"])("uses confirmed monthly coverage despite a %s renewal record and old quota", status => {
    const covered = state({ status, overQuota: true, compute: monthlyCompute() });
    expect(cloudDeployRecovery(covered, blocked)).toBe("ready");
    expect(cloudDeployRecovery(covered, { code: "PLAN_UPGRADE_REQUIRED", reason: "free-subdomain-limit" })).toBe("upgrade");
  });
  it("keeps monthly suspension and expired coverage separate from compute-credit top-ups", () => {
    expect(cloudDeployRecovery(state({ status: "credit_exhausted", overQuota: true, compute: monthlyCompute() }), blocked)).toBe("paused");
    expect(cloudDeployRecovery(state({ compute: monthlyCompute({ covered: false, status: "expired" }) }), blocked)).toBe("payment");
  });
  it("never presents top-ups as the solution to an exhausted build or service limit", () => {
    expect(cloudDeployRecovery(state({ overQuota: true }), { code: "PLAN_UPGRADE_REQUIRED", reason: "build-minutes-exhausted" })).toBe("upgrade");
    expect(cloudDeployRecovery(state({ tier: "free", overQuota: true }), { code: "PLAN_UPGRADE_REQUIRED", reason: "free-subdomain-limit" })).toBe("upgrade");
  });
  it("does not block an existing paid plan just because purchases are disabled", () => {
    expect(cloudDeployRecovery(state({ billing: { enabled: false } }), blocked)).toBe("ready");
  });
});
