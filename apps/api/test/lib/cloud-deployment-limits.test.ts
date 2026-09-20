import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ cloud: true, tier: "starter", count: vi.fn(), usage: vi.fn(), sync: vi.fn() }));
vi.mock("@repo/platform/engine/config/env", () => ({ env: { get CLOUD_MODE() { return h.cloud; } } }));
vi.mock("@repo/db", () => ({ repos: {
  organization: { findById: async () => ({ oblienNamespace: "tenant-a", planTierId: h.tier, createdAt: new Date("2026-01-01") }) },
  service: { countRunningForOrg: h.count }, deployment: { sumBuildMillisForOrg: h.usage },
} }));
vi.mock("@repo/platform/engine/modules/billing/billing-oblien-quota", () => ({ syncOblienEntitlement: h.sync }));
import { assertCloudDeploymentLimits, assertRunningServiceQuota, assertBuildMinutesAvailable } from "@repo/platform/engine/lib/plan-guard";
import { resolveCloudServiceResources } from "@repo/platform/engine/lib/resources";
beforeEach(() => {
  vi.resetAllMocks(); h.cloud = true; h.tier = "starter";
  h.sync.mockImplementation(async () => ({ tier: h.tier })); h.count.mockResolvedValue(3); h.usage.mockResolvedValue(0);
});
const base = { cpuCores: 1, memoryMb: 1024, diskMb: 8192 };
const services = () => [{ enabled: true }, { enabled: true }, { enabled: true }];
describe("Cloud deploy and update resource gates", () => {
  it("redeploys an existing stack at its allowance without charging service slots twice", async () => {
    await expect(assertCloudDeploymentLimits("org-a", { resources: base, services: services() })).resolves.toBeUndefined();
  });
  it("checks saved project sizes even when no resource picker value is sent", async () => {
    h.count.mockResolvedValue(0);
    await expect(assertCloudDeploymentLimits("org-a", { runsApplication: true, resources: { ...base, cpuCores: 4 } }))
      .rejects.toMatchObject({ reason: "resource-tier" });
  });
  it("checks individual Compose limits instead of only checking their project default", async () => {
    await expect(assertCloudDeploymentLimits("org-a", { resources: base, services: [{ advanced: { resources: { memoryMb: 8192 } } }] }))
      .rejects.toMatchObject({ reason: "resource-tier" });
  });
  it("inherits partial service settings field by field", async () => {
    expect(resolveCloudServiceResources({ memoryMb: 512 }, base)).toEqual({ ...base, memoryMb: 512 });
    await expect(assertCloudDeploymentLimits("org-a", { resources: { ...base, cpuCores: 4 }, services: [{ advanced: { resources: { memoryMb: 512 } } }] }))
      .rejects.toMatchObject({ reason: "resource-tier" });
  });
  it("turns self-hosted unlimited settings into concrete Cloud limits", () => {
    const result = resolveCloudServiceResources({ cpuCores: 0, memoryMb: 0 }, base);
    expect(result.cpuCores).toBeGreaterThan(0); expect(result.memoryMb).toBeGreaterThan(0);
  });
  it("ignores disabled service definitions", async () => {
    await expect(assertCloudDeploymentLimits("org-a", { resources: base, services: [...services(), { enabled: false, advanced: { resources: { cpuCores: 100 } } }] }))
      .resolves.toBeUndefined();
  });
  it("rejects a large imported or frozen stack before its definitions are persisted", async () => {
    h.count.mockResolvedValue(0);
    await expect(assertCloudDeploymentLimits("org-a", { services: [...services(), { enabled: true }] }))
      .rejects.toMatchObject({ reason: "running-services" });
  });
  it("includes other projects when enforcing the customer's allowance", async () => {
    h.count.mockResolvedValue(4);
    await expect(assertCloudDeploymentLimits("org-a", { services: services() })).rejects.toMatchObject({ reason: "running-services" });
  });
  it("reserves a native application's slot alongside the organization's other services", async () => {
    await expect(assertCloudDeploymentLimits("org-a", { projectId: "native-a", runsApplication: true, resources: base }))
      .rejects.toMatchObject({ reason: "running-services" });
    expect(h.count).toHaveBeenCalledWith("org-a", [], "native-a");
    h.count.mockResolvedValue(2);
    await expect(assertCloudDeploymentLimits("org-a", { projectId: "native-a", runsApplication: true, resources: base }))
      .resolves.toBeUndefined();
  });
  it("checks the new provider tier after a downgrade", async () => {
    h.tier = "free";
    await expect(assertCloudDeploymentLimits("org-a", { services: services() })).rejects.toMatchObject({ reason: "static-only" });
  });
  it("rejects oversized build allocations", async () => {
    await expect(assertCloudDeploymentLimits("org-a", { buildResources: { cpuCores: 16, memoryMb: 32768, diskMb: 32768 } }))
      .rejects.toMatchObject({ reason: "resource-tier" });
  });
  it("cannot turn an unavailable service count into additional capacity", async () => {
    h.count.mockRejectedValue(new Error("database unavailable"));
    await expect(assertCloudDeploymentLimits("org-a", { services: services() })).rejects.toThrow("database unavailable");
    await expect(assertRunningServiceQuota("org-a")).rejects.toThrow("database unavailable");
  });
  it("cannot turn an unavailable build meter into a new allowance", async () => {
    h.usage.mockRejectedValue(new Error("usage unavailable"));
    await expect(assertBuildMinutesAvailable("org-a")).rejects.toThrow("usage unavailable");
  });
  it("does not apply Cloud quotas to self-hosted workloads", async () => {
    h.cloud = false;
    await assertCloudDeploymentLimits("org-a", { resources: { ...base, cpuCores: 128 }, services: services() });
    expect(h.count).not.toHaveBeenCalled(); expect(h.sync).not.toHaveBeenCalled();
  });
});
