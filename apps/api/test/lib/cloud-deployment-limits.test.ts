import { beforeEach, describe, expect, it, vi } from "vitest";
import { planLimits, resolvePlan, type PlanTierId } from "@repo/core";
const h = vi.hoisted(() => ({ cloud: true, tier: "starter", workspaceId: "subscription-a" as string | null, count: vi.fn(), usage: vi.fn(), sync: vi.fn(), capacity: vi.fn() }));
vi.mock("@repo/platform/engine/config/env", () => ({ env: { get CLOUD_MODE() { return h.cloud; } } }));
vi.mock("@repo/db", () => ({ repos: {
  organization: { findById: async () => ({ oblienNamespace: "tenant-a", planTierId: h.tier, createdAt: new Date("2026-01-01") }) },
  project: { findByIdInOrganization: async (id: string) => ({ id, organizationId: "org-a", workspaceId: h.workspaceId }) },
  cloudWorkspace: {
    listByOrganization: async () => [{ id: h.workspaceId, organizationId: "org-a", namespace: "shared-tenant", planTierId: h.tier }],
    findByIdInOrganization: async (id: string) => ({ id, organizationId: "org-a", namespace: "shared-tenant", planTierId: h.tier }),
  },
  service: { countRunningForOrg: h.count }, deployment: { sumBuildMillisForOrg: h.usage },
} }));
vi.mock("@repo/platform/engine/modules/billing/billing-oblien-quota", () => ({ syncOblienEntitlement: h.sync }));
vi.mock("@repo/platform/engine/lib/cloud-capacity", () => ({ assertCloudWorkspaceCapacity: h.capacity }));
import { assertCloudDeploymentLimits, assertRunningServiceQuota, assertBuildMinutesAvailable,
  assertPlanAllowsResourceTier, assertCloudRuntimeLimits } from "@repo/platform/engine/lib/plan-guard";
import { resolveInheritedResources } from "@repo/platform/engine/lib/resources";
beforeEach(() => {
  vi.resetAllMocks(); h.cloud = true; h.tier = "starter"; h.workspaceId = "subscription-a";
  h.sync.mockImplementation(async () => ({
    tier: h.tier,
    // An explicit purchased slot limit exercises the gate independently of today's unlimited catalog.
    limits: { ...planLimits(h.tier as PlanTierId), runningServices: h.tier === "free" ? 0 : 3 },
    resourceLimits: resolvePlan(h.tier as PlanTierId).oblienLimits,
  }));
  h.count.mockResolvedValue(0);
  h.usage.mockResolvedValue(0);
});
const base = { cpuCores: 1, memoryMb: 1024, diskMb: 8192 };
const services = () => [{ enabled: true }, { enabled: true }, { enabled: true }];
describe("Cloud deploy and update resource gates", () => {
  it.each([
    ["hobby", 1, 4096], ["starter", 2, 8192], ["pro", 4, 16384], ["team", 8, 32768],
  ] as const)("applies the new %s ceiling to resource edits, deployments and existing runtimes", async (tier, cpuCores, memoryMb) => {
    h.tier = tier;
    h.workspaceId = "shared-workspace";
    const resources = { cpuCores, memoryMb, diskMb: 8192 };
    const runtime = { supports: () => true, getContainerInfo: vi.fn().mockResolvedValue({ status: "stopped", resources }) };
    await expect(assertPlanAllowsResourceTier("org-a", { tier: "custom", ...resources })).resolves.toBeUndefined();
    await expect(assertCloudDeploymentLimits("org-a", { runsApplication: true, resources })).resolves.toBeUndefined();
    await expect(assertCloudDeploymentLimits("org-a", { projectId: "existing", dockerWorkspace: true,
      services: [{ image: "redis:8", advanced: { resources } }] })).resolves.toBeUndefined();
    await expect(assertCloudRuntimeLimits("org-a", runtime, [{ containerId: "saved-container" }])).resolves.toBeUndefined();
    for (const tooLarge of [{ ...resources, cpuCores: cpuCores + 0.25 }, { ...resources, memoryMb: memoryMb + 1 }]) {
      await expect(assertPlanAllowsResourceTier("org-a", { tier: "custom", ...tooLarge })).rejects.toMatchObject({ reason: "resource-tier" });
      await expect(assertCloudDeploymentLimits("org-a", { services: [{ image: "redis:8", advanced: { resources: tooLarge } }] }))
        .rejects.toMatchObject({ reason: "resource-tier" });
      runtime.getContainerInfo.mockResolvedValue({ status: "stopped", resources: tooLarge });
      await expect(assertCloudRuntimeLimits("org-a", runtime, [{ containerId: "saved-container" }])).rejects.toMatchObject({ reason: "resource-tier" });
    }
  });
  it("compares named presets on their CPU and RAM, not a separate preset rank", async () => {
    await expect(assertPlanAllowsResourceTier("org-a", { tier: "medium" })).resolves.toBeUndefined();
    await expect(assertPlanAllowsResourceTier("org-a", { tier: "high" })).resolves.toBeUndefined();
    await expect(assertPlanAllowsResourceTier("org-a", { tier: "xlarge" })).rejects.toMatchObject({ reason: "resource-tier" });
    h.sync.mockResolvedValue({ tier: "starter", limits: { ...planLimits("starter"), maxResourceTier: "low" },
      resourceLimits: resolvePlan("starter").oblienLimits });
    await expect(assertPlanAllowsResourceTier("org-a", { tier: "high" })).resolves.toBeUndefined();
  });
  it.each([
    { tier: "unknown" }, { tier: "__proto__" },
    { cpuCores: -1, memoryMb: 512 }, { cpuCores: NaN, memoryMb: 512 },
    { cpuCores: Infinity, memoryMb: 512 }, { cpuCores: 1, memoryMb: Infinity },
  ])("rejects unknown or invalid service sizes: %j", async requested => {
    await expect(assertPlanAllowsResourceTier("org-a", requested)).rejects.toMatchObject({ reason: "resource-tier" });
  });
  it("keeps the preset ceiling from an older subscription through edits, deployment and restart", async () => {
    h.sync.mockResolvedValue({ tier: "starter", limits: { ...planLimits("starter"), maxServiceResources: undefined, maxResourceTier: "medium" },
      resourceLimits: resolvePlan("starter").oblienLimits });
    const resources = { cpuCores: 1, memoryMb: 3072, diskMb: 8192 };
    await expect(assertPlanAllowsResourceTier("org-a", { tier: "medium" })).resolves.toBeUndefined();
    await expect(assertPlanAllowsResourceTier("org-a", { tier: "custom", ...resources }))
      .rejects.toThrow("1 vCPU and 1 GB RAM per service");
    await expect(assertCloudDeploymentLimits("org-a", { runsApplication: true, resources })).rejects.toMatchObject({ reason: "resource-tier" });
    await expect(assertCloudRuntimeLimits("org-a", {
      supports: () => true, getContainerInfo: vi.fn().mockResolvedValue({ status: "stopped", resources }),
    }, [{ containerId: "saved-container" }])).rejects.toMatchObject({ reason: "resource-tier" });
  });
  it("counts a not-yet-created app in addition to the organization's existing services", async () => {
    h.count.mockResolvedValue(2);
    await expect(
      assertCloudDeploymentLimits("org-a", {
        services: [{ image: "redis:8" }, { image: "redis:8" }],
      }),
    ).rejects.toMatchObject({ reason: "running-services" });
  });
  it("redeploys an existing stack at its allowance without charging service slots twice", async () => {
    h.count.mockResolvedValue(3);
    await expect(
      assertCloudDeploymentLimits("org-a", {
        projectId: "existing",
        resources: base,
        services: services(),
      }),
    ).resolves.toBeUndefined();
  });
  it("checks saved project sizes even when no resource picker value is sent", async () => {
    h.count.mockResolvedValue(0);
    await expect(assertCloudDeploymentLimits("org-a", { runsApplication: true, resources: { ...base, cpuCores: 4 } }))
      .rejects.toMatchObject({ reason: "resource-tier" });
  });
  it("checks individual Compose limits instead of only checking their project default", async () => {
    await expect(assertCloudDeploymentLimits("org-a", { resources: base, services: [{ advanced: { resources: { memoryMb: 9216 } } }] }))
      .rejects.toMatchObject({ reason: "resource-tier" });
  });
  it("inherits partial service settings field by field", async () => {
    expect(resolveInheritedResources({ memoryMb: 512 }, base)).toEqual({ ...base, memoryMb: 512 });
    await expect(assertCloudDeploymentLimits("org-a", { resources: { ...base, cpuCores: 4 }, services: [{ advanced: { resources: { memoryMb: 512 } } }] }))
      .rejects.toMatchObject({ reason: "resource-tier" });
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
    h.count.mockResolvedValue(3);
    await expect(
      assertCloudDeploymentLimits("org-a", {
        projectId: "native-a",
        runsApplication: true,
        resources: base,
      }),
    ).rejects.toMatchObject({ reason: "running-services" });
    expect(h.count).toHaveBeenCalledWith("org-a", [], "native-a", undefined, "subscription-a");
    h.count.mockResolvedValue(2);
    await expect(assertCloudDeploymentLimits("org-a", { projectId: "native-a", runsApplication: true, resources: base }))
      .resolves.toBeUndefined();
  });
  it("checks the new provider tier after a downgrade", async () => {
    h.tier = "free";
    await expect(assertCloudDeploymentLimits("org-a", { services: services() })).rejects.toMatchObject({ reason: "static-only" });
  });
  it("leaves optional build caps to the provider-headroom planner", async () => {
    await expect(assertCloudDeploymentLimits("org-a", { buildResources: { cpuCores: 16, memoryMb: 32768, diskMb: 32768 } }))
      .resolves.toBeUndefined();
  });
  it("validates the runtime without adding a second fixed build reservation", async () => {
    const resources = { cpuCores: 0.25, memoryMb: 256, diskMb: 8192 };
    const largeBuild = { cpuCores: 4, memoryMb: 8192, diskMb: 8192 };
    const input = { projectId: "existing", resources, buildResources: largeBuild,
      services: [{ name: "app", build: "." }] };
    await expect(assertCloudDeploymentLimits("org-a", input)).resolves.toBeUndefined();
    const buildResources = { cpuCores: 0.25, memoryMb: 512, diskMb: 8192 };
    await expect(assertCloudDeploymentLimits("org-a", { ...input, buildResources })).resolves.toBeUndefined();
    expect(h.capacity).not.toHaveBeenCalled();
    expect(input.resources).toEqual(resources);
  });
  it("reports no builder for image-only app admission, even when an old build size is saved", async () => {
    await assertCloudDeploymentLimits("org-a", { projectId: "image", dockerWorkspace: true,
      resources: { cpuCores: 0.25, memoryMb: 256, diskMb: 8192 },
      services: [{ name: "redis", image: "redis:8" }],
      buildResources: { cpuCores: 4, memoryMb: 8192, diskMb: 32768 } });
    expect(h.capacity).not.toHaveBeenCalled();
  });
  it("does not reserve or reject an unused build size for an image-only deployment", async () => {
    const imageOnly = [{ enabled: true, image: "vaultwarden/server:latest" }];
    await expect(assertCloudDeploymentLimits("org-a", { services: imageOnly,
      buildResources: { cpuCores: 4, memoryMb: 8192, diskMb: 32768 } })).resolves.toBeUndefined();
  });
  it.each([{ services: [] }, { services: [{ enabled: true, image: "redis:8" }] }])("still validates native runtime limits with services $services", async ({ services }) => {
    h.count.mockResolvedValue(0);
    await expect(assertCloudDeploymentLimits("org-a", { mainApplication: true, runsApplication: true, services,
      resources: { cpuCores: 4, memoryMb: 8192, diskMb: 32768 } })).rejects.toMatchObject({ reason: "resource-tier" });
  });
  it("cannot turn an unavailable service count into additional capacity", async () => {
    h.count.mockRejectedValue(new Error("database unavailable"));
    await expect(assertCloudDeploymentLimits("org-a", { services: services() })).rejects.toThrow("database unavailable");
    await expect(assertRunningServiceQuota("org-a")).rejects.toThrow("database unavailable");
  });
  it("cannot turn an unavailable build meter into a new allowance", async () => {
    h.sync.mockResolvedValue({ tier: "starter", limits: { ...planLimits("starter"), buildMinutesPerMonth: 3000 },
      resourceLimits: resolvePlan("starter").oblienLimits });
    h.usage.mockRejectedValue(new Error("usage unavailable"));
    await expect(assertBuildMinutesAvailable("org-a")).rejects.toThrow("usage unavailable");
  });
  it("does not apply Cloud quotas to self-hosted workloads", async () => {
    h.cloud = false;
    await assertPlanAllowsResourceTier("org-a", { tier: "unlimited" });
    await assertCloudDeploymentLimits("org-a", { resources: { ...base, cpuCores: 128 }, services: services() });
    expect(h.count).not.toHaveBeenCalled(); expect(h.sync).not.toHaveBeenCalled();
  });
  it("allows full server capacity and preserves explicit Micro container limits", async () => {
    for (const requested of [{}, { tier: "unlimited" }, { cpuCores: 0, memoryMb: 0 }, { cpuCores: 0.25, memoryMb: 256 }])
      await expect(assertPlanAllowsResourceTier("org-a", requested)).resolves.toBeUndefined();
    expect(resolveInheritedResources({ cpuCores: 0, memoryMb: 0 }, base)).toEqual({ ...base, cpuCores: 0, memoryMb: 0 });
    expect(resolveInheritedResources({ cpuCores: 0.25, memoryMb: 256 }, base)).toEqual({ ...base, cpuCores: 0.25, memoryMb: 256 });
  });
  it("does not sum container ceilings into VM reservations or limit new plans by project count", async () => {
    h.sync.mockResolvedValue({ tier: "team", limits: planLimits("team"), resourceLimits: resolvePlan("team").oblienLimits });
    const stack = Array.from({ length: 20 }, (_, index) => ({ name: `service-${index}`, image: "redis:8", advanced: { resources: { cpuCores: 1, memoryMb: 1024 } } }));
    await expect(assertCloudDeploymentLimits("org-a", { projectId: "existing", services: stack })).resolves.toBeUndefined();
    expect(h.count).not.toHaveBeenCalled();
    expect(h.capacity).not.toHaveBeenCalled();
  });
  it("rejects a conflicting billing owner instead of using another server's plan", async () => {
    await expect(assertCloudDeploymentLimits("org-a", { projectId: "existing", workspaceId: "another-server", services: services() })).rejects.toMatchObject({ code: "CLOUD_WORKSPACE_TARGET_CONFLICT" });
    expect(h.sync).not.toHaveBeenCalled();
  });
});
