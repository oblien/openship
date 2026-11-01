import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  cloud: true,
  find: vi.fn(),
  update: vi.fn(),
  target: vi.fn(),
  capacity: vi.fn(),
}));
vi.mock("@repo/db", () => ({ repos: { project: { findById: h.find, update: h.update } } }));
vi.mock("@repo/platform/engine/config/env", () => ({
  env: {
    get CLOUD_MODE() {
      return h.cloud;
    },
  },
}));
vi.mock("@repo/platform/engine/modules/deployments/build.service", () => ({
  resolveSnapshotTarget: h.target,
}));
vi.mock("@repo/platform/engine/lib/host-capacity", () => ({ getHostCapacity: h.capacity }));
import {
  getResources,
  updateResources,
} from "@repo/platform/engine/modules/projects/project-resources.service";

const runtime = { cpuCores: 0.25, memoryMb: 256, diskMb: 16384 };
const cap = { cpuCores: 0.5, memoryMb: 512, diskMb: 8192 };

beforeEach(() => {
  vi.resetAllMocks();
  h.cloud = true;
  const row = {
    id: "project",
    organizationId: "customer",
    resources: { ...runtime },
    buildResources: null,
    sleepMode: "always_on",
    port: 8080,
  };
  h.find.mockImplementation(async () => ({ ...row }));
  h.update.mockImplementation(async (_id: string, changes: Record<string, unknown>) =>
    Object.assign(row, changes),
  );
  h.target.mockResolvedValue({ deployTarget: "cloud" });
  h.capacity.mockResolvedValue({ cpuCores: null, memoryMb: null, diskMb: null });
});

describe("Cloud build caps in project settings", () => {
  it("reports automatic sizing without inventing a fixed build CPU or memory allocation", async () => {
    expect(await getResources("project", "customer")).toMatchObject({
      buildMode: "automatic",
      build: { cpuCores: 0, memoryMb: 0 },
      production: runtime,
    });
  });

  it("saves and clears only the build cap, preserving runtime settings and disk", async () => {
    expect(await updateResources("project", { build: cap }, "customer")).toMatchObject({
      buildMode: "custom",
      build: cap,
      production: runtime,
      port: 8080,
      sleepMode: "always_on",
    });
    expect(h.update).toHaveBeenLastCalledWith("project", { buildResources: cap });
    expect(await updateResources("project", { build: null }, "customer")).toMatchObject({
      buildMode: "automatic",
      build: { cpuCores: 0, memoryMb: 0 },
      production: runtime,
      port: 8080,
      sleepMode: "always_on",
    });
    expect(h.update).toHaveBeenLastCalledWith("project", { buildResources: null });
    expect(h.capacity).not.toHaveBeenCalled();
  });

  it("does not clear a saved cap when an unrelated setting changes", async () => {
    await updateResources("project", { build: cap }, "customer");
    expect(await updateResources("project", { port: 9000 }, "customer")).toMatchObject({
      buildMode: "custom",
      build: cap,
      port: 9000,
    });
    expect(h.update).toHaveBeenLastCalledWith("project", { port: 9000 });
  });

  it("rejects invalid Cloud caps without changing saved settings", async () => {
    await expect(
      updateResources("project", { build: { ...cap, cpuCores: -1 } }, "customer"),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(h.update).not.toHaveBeenCalled();
  });

  it("rejects a different tenant before reading capacity or changing settings", async () => {
    await expect(updateResources("project", { build: null }, "another-customer")).rejects.toThrow();
    expect(h.target).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });

  it("keeps self-hosted builds unlimited by default", async () => {
    h.cloud = false;
    h.target.mockResolvedValue({ deployTarget: "docker" });
    const result = await getResources("project", "customer");
    expect(result).not.toHaveProperty("buildMode");
    expect(result.build).toEqual({ cpuCores: 0, memoryMb: 0, diskMb: 0 });
  });
});
