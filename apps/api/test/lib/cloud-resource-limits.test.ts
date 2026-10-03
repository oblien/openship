import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ quota: vi.fn(), get: vi.fn(), update: vi.fn() }));
vi.mock("@repo/platform/engine/lib/oblien-client", () => ({
  getOblienClient: () => ({ workspaces: { getQuota: h.quota }, namespaces: { get: h.get, update: h.update } }),
}));
import { cloudNamespaceLimits, initialCloudNamespaceLimits, readCloudCapacity, readCloudCapacityPool, syncCloudResourceLimits } from "@repo/platform/engine/lib/cloud-resource-limits";

beforeEach(() => {
  vi.resetAllMocks();
  h.quota.mockImplementation(() => { throw new Error("Openship must not calculate provider capacity"); });
  h.get.mockResolvedValue({ data: { id: "ns-a", slug: "tenant-a", resource_limits: null } });
  h.update.mockImplementation(async (_id, input) => ({ data: { id: "ns-a", slug: "tenant-a", ...input,
    effective_resource_limits: { max_workspaces: 52, max_vcpus: 32, max_ram_mb: 65536, max_disk_gb: 1024 },
  } }));
});

describe("Oblien-owned namespace capacity", () => {
  it("displays provider allocations in their real units without using credit balances or owner limits", async () => {
    h.get.mockResolvedValue({ success: true, data: { slug: "tenant-a",
      effective_resource_limits: cloudNamespaceLimits("pro"),
      allocated_resource_usage: { workspaces: 3, vcpus: 2.5, ram_mb: 4096, disk_gb: 48.5, pending_updates: 1 },
    } });
    expect(await readCloudCapacity("tenant-a")).toEqual({ workspaces: { used: 3, max: 1 }, vcpus: { used: 2.5, max: 4 },
      ramMb: { used: 4096, max: 16384 }, diskGb: { used: 48.5, max: 128 } });
    expect(h.quota).not.toHaveBeenCalled(); expect(h.update).not.toHaveBeenCalled();
  });
  it("does not return another namespace's capacity", async () => {
    h.get.mockResolvedValue({ success: true, data: { slug: "tenant-b" } });
    await expect(readCloudCapacity("tenant-a")).rejects.toMatchObject({ code: "CLOUD_NAMESPACE_MISMATCH" });
  });
  it("leaves capacity unavailable when the provider has no verified allocation", async () => {
    h.get.mockResolvedValue({ success: true, data: { slug: "tenant-a" } });
    expect(await readCloudCapacity("tenant-a")).toEqual({});
    await expect(readCloudCapacityPool("tenant-a")).rejects.toMatchObject({ code: "CLOUD_CAPACITY_UNAVAILABLE" });
  });
  it("converts disk to MB for admission without confusing zero and unlimited", async () => {
    h.get.mockResolvedValue({ success: true, data: { slug: "tenant-a",
      effective_resource_limits: { max_workspaces: null, max_total_vcpus: 0, max_total_ram_mb: 8192, max_total_disk_gb: 16 },
      allocated_resource_usage: { workspaces: 0, vcpus: 0, ram_mb: 0, disk_gb: 1.25, pending_updates: 0 },
    } });
    expect(await readCloudCapacityPool("tenant-a")).toEqual({ workspaces: { used: 0, max: null }, cpuCores: { used: 0, max: 0 },
      memoryMb: { used: 0, max: 8192 }, diskMb: { used: 1280, max: 16384 } });
  });
  it("does not turn malformed provider measurements into free capacity", async () => {
    h.get.mockResolvedValue({ success: true, data: { slug: "tenant-a",
      allocated_resource_usage: { vcpus: -2 },
    } });
    await expect(readCloudCapacityPool("tenant-a")).rejects.toMatchObject({ statusCode: 503, code: "CLOUD_CAPACITY_UNAVAILABLE" });
  });
  it("declares finite retail VM and aggregate caps without reading enterprise owner capacity", async () => {
    expect(cloudNamespaceLimits("team")).toEqual({ max_workspaces: 1, max_vcpus: 8, max_ram_mb: 32768, max_disk_gb: 256, max_total_vcpus: 8, max_total_ram_mb: 32768, max_total_disk_gb: 256 });
    await expect(initialCloudNamespaceLimits()).resolves.toEqual({ max_workspaces: 0, max_vcpus: 1, max_ram_mb: 1024, max_disk_gb: 8, max_total_vcpus: 0, max_total_ram_mb: 0, max_total_disk_gb: 0 });
    await syncCloudResourceLimits("tenant-a", "team");
    expect(h.update).toHaveBeenCalledWith("ns-a", { resource_limits: cloudNamespaceLimits("team") });
    expect(h.quota).not.toHaveBeenCalled();
  });
  it("sends an older saved offer unchanged and accepts Oblien's lower effective ceiling", async () => {
    const saved = Object.freeze({ max_workspaces: 52, max_vcpus: 200, max_ram_mb: 417792, max_disk_gb: 64, max_total_vcpus: 8, max_total_ram_mb: 16384, max_total_disk_gb: 256 });
    await syncCloudResourceLimits("tenant-a", "team", saved);
    expect(h.update).toHaveBeenCalledWith("ns-a", { resource_limits: saved });
    expect(saved.max_vcpus).toBe(200);
    expect(h.quota).not.toHaveBeenCalled();
  });
  it("preserves explicit customer restrictions even when the owner's capacity is unlimited", async () => {
    const saved = Object.freeze({ max_workspaces: 7, max_vcpus: 2, max_ram_mb: 4096, max_disk_gb: 12, max_total_vcpus: 3, max_total_ram_mb: 6144, max_total_disk_gb: 24 });
    await syncCloudResourceLimits("tenant-a", "team", saved);
    expect(h.update).toHaveBeenCalledWith("ns-a", { resource_limits: saved });
    expect(h.quota).not.toHaveBeenCalled();
  });
  it("does not rewrite declared policy when effective capacity differs", async () => {
    const declared = { max_workspaces: 52, max_vcpus: 200, max_ram_mb: 417792, max_disk_gb: 64, max_total_vcpus: 8, max_total_ram_mb: 16384, max_total_disk_gb: 256 };
    h.get.mockResolvedValue({ data: { id: "ns-a", slug: "tenant-a", resource_limits: declared,
      effective_resource_limits: { ...declared, max_vcpus: 32, max_ram_mb: 65536 },
    } });
    await syncCloudResourceLimits("tenant-a", "team", declared);
    expect(h.update).not.toHaveBeenCalled();
    expect(h.quota).not.toHaveBeenCalled();
  });
  it("clears old declared caps only after a verified enterprise entitlement", async () => {
    h.get.mockResolvedValue({ data: { id: "ns-a", slug: "tenant-a", resource_limits: { max_workspaces: 5 } } });
    await syncCloudResourceLimits("tenant-a", "enterprise");
    expect(h.update).toHaveBeenCalledWith("ns-a", { resource_limits: { max_workspaces: null, max_vcpus: null, max_ram_mb: null, max_disk_gb: null, max_total_vcpus: null, max_total_ram_mb: null, max_total_disk_gb: null } });
  });
  it("cannot change policy when the provider returns another namespace", async () => {
    h.get.mockResolvedValue({ data: { id: "ns-b", slug: "tenant-b" } });
    await expect(syncCloudResourceLimits("tenant-a", "pro")).rejects.toMatchObject({ code: "CLOUD_NAMESPACE_MISMATCH" });
    expect(h.update).not.toHaveBeenCalled();
  });
  it.each([
    { id: "ns-a", slug: "tenant-a", resource_limits: null },
    { id: "ns-b", slug: "tenant-b", resource_limits: cloudNamespaceLimits("pro") },
  ])("refuses deployment if the declared policy update is not confirmed", async data => {
    h.update.mockResolvedValue({ data });
    await expect(syncCloudResourceLimits("tenant-a", "pro")).rejects.toMatchObject({ code: "CLOUD_RESOURCE_LIMITS_UNCONFIRMED" });
  });
});
