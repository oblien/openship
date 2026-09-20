import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ quota: vi.fn(), get: vi.fn(), update: vi.fn() }));
vi.mock("@repo/platform/engine/lib/oblien-client", () => ({
  getOblienClient: () => ({ workspaces: { getQuota: h.quota }, namespaces: { get: h.get, update: h.update } }),
}));
import {
  cloudNamespaceLimits, initialCloudNamespaceLimits, syncCloudResourceLimits,
} from "@repo/platform/engine/lib/cloud-resource-limits";

beforeEach(() => {
  vi.resetAllMocks();
  h.quota.mockRejectedValue(new Error("Reseller capacity is not a customer allowance"));
  h.get.mockResolvedValue({ data: { id: "ns-a", slug: "tenant-a", resource_limits: null } });
  h.update.mockImplementation(async (_id, input) => ({ data: { id: "ns-a", slug: "tenant-a", ...input } }));
});

describe("customer namespace resource ceilings", () => {
  it("fits native builds and a shared Compose stack within each paid plan", () => {
    expect(cloudNamespaceLimits("free")).toEqual({ max_workspaces: 2, max_vcpus: 4, max_ram_mb: 8192, max_disk_gb: 32 });
    expect(cloudNamespaceLimits("starter")).toEqual({ max_workspaces: 5, max_vcpus: 4, max_ram_mb: 11264, max_disk_gb: 32 });
    expect(cloudNamespaceLimits("pro")).toEqual({ max_workspaces: 12, max_vcpus: 20, max_ram_mb: 28672, max_disk_gb: 32 });
    expect(cloudNamespaceLimits("team")).toEqual({ max_workspaces: 52, max_vcpus: 200, max_ram_mb: 417792, max_disk_gb: 64 });
  });
  it("supplies customer limits without fetching reseller capacity before onboarding", async () => {
    await expect(initialCloudNamespaceLimits()).resolves.toEqual({ max_workspaces: 2, max_vcpus: 4, max_ram_mb: 8192, max_disk_gb: 32 });
    expect(h.quota).not.toHaveBeenCalled();
  });
  it("updates only the current namespace's resource ceilings", async () => {
    await syncCloudResourceLimits("tenant-a", "starter");
    expect(h.get).toHaveBeenCalledWith("tenant-a");
    expect(h.update).toHaveBeenCalledWith("ns-a", { resource_limits: { max_workspaces: 5, max_vcpus: 4, max_ram_mb: 11264, max_disk_gb: 32 } });
    expect(h.quota).not.toHaveBeenCalled();
  });
  it("repeated synchronization does not rewrite already matching ceilings", async () => {
    h.get.mockResolvedValue({ data: { id: "ns-a", slug: "tenant-a", resource_limits: cloudNamespaceLimits("pro") } });
    await syncCloudResourceLimits("tenant-a", "pro");
    expect(h.update).not.toHaveBeenCalled();
  });
  it("clears previous plan ceilings when an enterprise entitlement is verified", async () => {
    h.get.mockResolvedValue({ data: { id: "ns-a", slug: "tenant-a", resource_limits: { max_workspaces: 5 } } });
    await syncCloudResourceLimits("tenant-a", "enterprise");
    expect(h.update).toHaveBeenCalledWith("ns-a", { resource_limits: { max_workspaces: null, max_vcpus: null, max_ram_mb: null, max_disk_gb: null } });
  });
  it("cannot change ceilings if the provider returns another namespace", async () => {
    h.get.mockResolvedValue({ data: { id: "ns-b", slug: "tenant-b" } });
    await expect(syncCloudResourceLimits("tenant-a", "pro")).rejects.toMatchObject({ code: "CLOUD_NAMESPACE_MISMATCH" });
    expect(h.update).not.toHaveBeenCalled();
  });
  it("refuses to authorize a deployment when the provider ignores the update", async () => {
    h.update.mockResolvedValue({ data: { id: "ns-a", slug: "tenant-a", resource_limits: null } });
    await expect(syncCloudResourceLimits("tenant-a", "pro")).rejects.toMatchObject({ code: "CLOUD_RESOURCE_LIMITS_UNCONFIRMED" });
  });
});
