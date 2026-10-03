import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  exec: vi.fn(),
  inventory: vi.fn(),
  dispose: vi.fn(),
  allocation: vi.fn(),
  owner: vi.fn(),
  binding: vi.fn(),
  projects: vi.fn(),
  verifyLink: vi.fn(),
}));
vi.mock("@repo/platform/engine/config/env", async (original) => {
  const actual = await original<typeof import("@repo/platform/engine/config/env")>();
  return { ...actual, env: { ...actual.env, CLOUD_MODE: true } };
});
vi.mock("@repo/db", () => ({
  repos: {
    cloudWorkspace: { findByIdInOrganization: h.owner },
    cloudDockerWorkspace: { find: h.binding },
    project: { listByWorkspace: h.projects },
  },
}));
vi.mock("@repo/platform/engine/lib/cloud-capacity", () => ({
  readCloudWorkspaceAllocation: h.allocation,
}));
vi.mock("@repo/platform/engine/lib/cloud/server-link", () => ({
  requireLinkedCloudServer: h.verifyLink,
}));
vi.mock("@repo/platform/engine/lib/openship-cloud", () => ({
  getNamespaceClient: async () => ({ client: {}, namespace: "ns-test" }),
}));
vi.mock("@repo/adapters", async (original) => ({
  ...(await original<typeof import("@repo/adapters")>()),
  CloudWorkspaceExecutor: class { exec = h.exec; dispose = h.dispose; },
  CloudDockerRuntime: {
    forWorkspace: async () => ({
      executor: { exec: h.exec },
      docker: { df: h.inventory },
      dispose: h.dispose,
    }),
  },
}));
import {
  measureCloudWorkspace,
  sampleCloudWorkspaceResources,
  workspaceBuildResources,
  unavailableWorkspaceUsage,
} from "@repo/platform/engine/lib/cloud-workspace-host";

const capacity = { cpuCores: 4, memoryMb: 8192, diskMb: 102400 };
const sample = {
  cpu: 25,
  memUsed: 2048 * 1048576,
  memAvail: 6144 * 1048576,
  memTotal: 8192 * 1048576,
  diskUsed: 2048 * 1048576,
  diskAvail: 90 * 1024 * 1048576,
  diskTotal: 92 * 1024 * 1048576,
  uptime: "3600.00",
  load1: "0.25",
  load5: "0.20",
  load15: "0.10",
};
beforeEach(() => {
  vi.resetAllMocks();
  h.owner.mockResolvedValue({
    id: "cws-test",
    organizationId: "org-test",
    linkedProjects: [],
    namespace: "ns-test",
  });
  h.binding.mockResolvedValue({ workspaceId: "vm-test", namespace: "ns-test" });
  h.projects.mockResolvedValue([
    { id: "project-a", name: "API", slug: "api" },
    { id: "project-b", name: "Database", slug: "db" },
  ]);
  h.allocation.mockResolvedValue({ workspace: { status: "running" }, allocation: capacity });
  h.exec.mockImplementation(async (command) =>
    command.startsWith("for p in") ? "1024\n2048\n" : JSON.stringify(sample),
  );
  h.inventory.mockResolvedValue({
    Containers: [
      {
        Labels: { "openship.project": "project-a" },
        SizeRw: 1048576,
        Mounts: [{ Type: "volume", Name: "a-data" }],
      },
    ],
    Volumes: [
      {
        Name: "a-data",
        Labels: { "openship.project": "project-a" },
        UsageData: { Size: 2 * 1048576 },
      },
      {
        Name: "b-data",
        Labels: { "openship.project": "project-b" },
        UsageData: { Size: 3 * 1048576 },
      },
    ],
  });
});

describe("measured subscription workspace resources", () => {
  it("checks the pinned Cloud connection before serving a cached linked-server measurement", async () => {
    await measureCloudWorkspace("org-test", "cws-test", true);
    h.owner.mockResolvedValue({ id: "cws-test", organizationId: "org-test", remote: { userId: "old-owner" }, linkedProjects: [] });
    h.verifyLink.mockRejectedValue(new Error("Cloud connection changed"));
    await expect(measureCloudWorkspace("org-test", "cws-test")).rejects.toThrow("Cloud connection changed");
    expect(h.verifyLink).toHaveBeenCalledExactlyOnceWith("org-test", "cws-test");
    expect(h.inventory).toHaveBeenCalledOnce();
  });

  it("shows host bytes separately from reserved disk and attributes data without counting shared images twice", async () => {
    const usage = await measureCloudWorkspace("org-test", "cws-test", true);
    expect(usage).toMatchObject({
      available: true,
      cpuPercent: 25,
      memoryUsedMb: 2048,
      diskUsedMb: 2048,
      diskTotalMb: 92 * 1024,
      sharedDiskMb: 2039,
      projects: [
        { id: "project-a", diskMb: 4 },
        { id: "project-b", diskMb: 5 },
      ],
    });
    expect(usage.diskUsedMb).not.toBe(capacity.diskMb);
    expect(h.dispose).toHaveBeenCalledOnce();
  });
  it("keeps failed storage attribution unknown while retaining independently measured host totals", async () => {
    h.inventory.mockRejectedValue(new Error("Docker inventory unavailable"));
    const usage = await measureCloudWorkspace("org-test", "cws-test", true);
    expect(usage).toMatchObject({ available: true, diskUsedMb: 2048, sharedDiskMb: null });
    expect(usage.projects.every((project) => project.diskMb === null)).toBe(true);
    h.exec.mockImplementation(async (command) =>
      command.startsWith("for p in") ? "permission denied" : JSON.stringify(sample),
    );
    expect(
      (await measureCloudWorkspace("org-test", "cws-test", true)).projects.every(
        (project) => project.diskMb === null,
      ),
    ).toBe(true);
  });
  it("refuses a stopped host or incomplete measurements instead of manufacturing usage", async () => {
    h.allocation.mockResolvedValue({ workspace: { status: "stopped" }, allocation: capacity });
    await expect(sampleCloudWorkspaceResources("org-test", "cws-test")).rejects.toMatchObject({
      code: "CLOUD_WORKSPACE_NOT_RUNNING",
    });
    expect(h.exec).not.toHaveBeenCalled();
    h.allocation.mockResolvedValue({ workspace: { status: "running" }, allocation: capacity });
    h.exec.mockResolvedValue(JSON.stringify({ ...sample, memAvail: null }));
    await expect(sampleCloudWorkspaceResources("org-test", "cws-test")).rejects.toThrow(
      "incomplete resource measurements",
    );
    expect(h.dispose).toHaveBeenCalledOnce();
  });
  it("uses a cheap host sample for build admission without scanning filesystem data", async () => {
    const result = await sampleCloudWorkspaceResources("org-test", "cws-test");
    expect(result.capacity).toEqual(capacity);
    expect(h.inventory).not.toHaveBeenCalled();
    expect(h.projects).not.toHaveBeenCalled();
    expect(workspaceBuildResources(result.capacity, result.usage)).toEqual({
      cpuCores: 3,
      memoryMb: 5734,
      diskMb: 102400,
    });
  });
});

describe("builds inside the subscribed host", () => {
  const usage = {
    ...unavailableWorkspaceUsage(""),
    available: true,
    memoryAvailableMb: 6144,
    cpuPercent: 25,
  };
  it("honors a smaller explicit build cap and bounds stale available memory to the host", () => {
    expect(workspaceBuildResources(capacity, usage, { cpuCores: 0.25, memoryMb: 256 })).toEqual({
      cpuCores: 0.25,
      memoryMb: 256,
      diskMb: capacity.diskMb,
    });
    expect(
      workspaceBuildResources(capacity, { ...usage, memoryAvailableMb: 99999 }, { memoryMb: 99999 })
        .memoryMb,
    ).toBe(7782);
  });
  it("blocks unknown or insufficient free memory before starting a build", () => {
    expect(() => workspaceBuildResources(capacity, { ...usage, available: false })).toThrow(
      "Couldn't measure",
    );
    expect(() => workspaceBuildResources(capacity, { ...usage, memoryAvailableMb: 500 })).toThrow(
      "too little free memory",
    );
  });
});
