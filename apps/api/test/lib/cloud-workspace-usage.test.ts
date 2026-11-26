import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  exec: vi.fn(),
  inventory: vi.fn(),
  info: vi.fn(),
  dispose: vi.fn(),
  allocation: vi.fn(),
  owner: vi.fn(),
  binding: vi.fn(),
  runtimeStatus: vi.fn(),
  projects: vi.fn(),
  project: vi.fn(),
  service: vi.fn(),
  deployment: vi.fn(),
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
    project: { listByWorkspace: h.projects, findByIdInOrganization: h.project },
    service: { findById: h.service },
    deployment: { findById: h.deployment },
  },
}));
vi.mock("@repo/platform/engine/lib/cloud-capacity", () => ({
  readCloudWorkspaceAllocation: h.allocation,
}));
vi.mock("@repo/platform/engine/lib/cloud/server-link", () => ({
  requireLinkedCloudServer: h.verifyLink,
}));
vi.mock("@repo/platform/engine/lib/openship-cloud", () => ({
  getNamespaceClient: async () => ({
    client: { vm: () => ({ apiAccess: { status: h.runtimeStatus } }) },
    namespace: "ns-test",
  }),
}));
vi.mock("@repo/adapters", async (original) => ({
  ...(await original<typeof import("@repo/adapters")>()),
  CloudWorkspaceExecutor: class { exec = h.exec; dispose = h.dispose; },
  CloudDockerRuntime: {
    forWorkspace: async () => ({
      executor: { exec: h.exec },
      docker: { df: h.inventory, info: h.info },
      dispose: h.dispose,
    }),
  },
}));
import {
  cloudServiceTerminalHasExited,
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
  h.info.mockResolvedValue({ Driver: "overlay2" });
  h.owner.mockResolvedValue({
    id: "cws-test",
    organizationId: "org-test",
    linkedProjects: [],
    namespace: "ns-test",
  });
  h.binding.mockResolvedValue({ workspaceId: "vm-test", namespace: "ns-test", state: "ready" });
  h.runtimeStatus.mockResolvedValue({ enabled: true });
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
  it("keeps monitoring on fuse-overlayfs independent of expensive Docker layer scans", async () => {
    h.info.mockResolvedValue({ Driver: "fuse-overlayfs" });
    const usage = await measureCloudWorkspace("org-test", "cws-test", true);
    expect(usage).toMatchObject({
      available: true,
      memoryUsedMb: 2048,
      memoryAvailableMb: 6144,
      diskUsedMb: 2048,
      sharedDiskMb: null,
    });
    expect(usage.projects.map((p) => p.diskMb)).toEqual([null, null]);
    expect(h.inventory).not.toHaveBeenCalled();
    expect(h.exec).toHaveBeenCalledOnce();
    expect(h.dispose).toHaveBeenCalledOnce();
  });
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
  it("reads verified allocation without sampling usage for an uncapped build", async () => {
    const result = await sampleCloudWorkspaceResources("org-test", "cws-test", false);
    expect(result.capacity).toEqual(capacity);
    expect(h.exec).not.toHaveBeenCalled();
    expect(h.dispose).not.toHaveBeenCalled();
    expect(workspaceBuildResources(result.capacity, result.usage)).toMatchObject({ cpuCores: 0, memoryMb: 0 });
  });
  it("rejects build admission while a Cloud runtime still needs owner initialization", async () => {
    h.runtimeStatus.mockResolvedValue({ enabled: false });
    await expect(sampleCloudWorkspaceResources("org-test", "cws-test", false)).rejects.toMatchObject({
      code: "CLOUD_RUNTIME_OWNER_INITIALIZATION_REQUIRED",
    });
    expect(h.exec).not.toHaveBeenCalled();
  });
  it("uses a cheap host sample for build admission without scanning filesystem data", async () => {
    const result = await sampleCloudWorkspaceResources("org-test", "cws-test");
    expect(result.capacity).toEqual(capacity);
    expect(h.inventory).not.toHaveBeenCalled();
    expect(h.projects).not.toHaveBeenCalled();
    expect(workspaceBuildResources(result.capacity, result.usage)).toEqual({
      cpuCores: 0,
      memoryMb: 0,
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
  it("preserves explicit build allocations and refuses those that cannot fit", () => {
    expect(workspaceBuildResources(capacity, usage, { cpuCores: 0.25, memoryMb: 256 })).toEqual({
      cpuCores: 0.25,
      memoryMb: 256,
      diskMb: capacity.diskMb,
    });
    expect(() => workspaceBuildResources(capacity, { ...usage, memoryAvailableMb: 99999 }, { memoryMb: 99999 }))
      .toThrow("requested build allocation cannot fit");
    expect(workspaceBuildResources(capacity, { ...usage, memoryAvailableMb: 99999 }).memoryMb).toBe(0);
    expect(() => workspaceBuildResources(capacity, { ...usage, cpuPercent: 99 }, { cpuCores: 2, memoryMb: 1024 }))
      .toThrow("requested build allocation cannot fit");
  });
  it("blocks unknown or insufficient free memory before starting a build", () => {
    expect(() => workspaceBuildResources(capacity, { ...usage, available: false }, { cpuCores: 1, memoryMb: 128 })).toThrow(
      "Couldn't measure",
    );
    expect(() => workspaceBuildResources(capacity, { ...usage, memoryAvailableMb: 500 }, { cpuCores: 1, memoryMb: 128 })).toThrow(
      "too little free memory",
    );
  });
});

describe("Cloud service terminal exit confirmation", () => {
  beforeEach(() => {
    h.service.mockResolvedValue({ id: "svc-a", projectId: "project-a" });
    h.project.mockResolvedValue({
      id: "project-a", organizationId: "org-test", workspaceId: "cws-test", activeDeploymentId: "dep-a",
    });
    h.deployment.mockResolvedValue({
      id: "dep-a", projectId: "project-a", organizationId: "org-test",
      meta: {
        managedWorkspaceId: "cws-test",
        managedServer: { projectId: "project-a", ownerWorkspaceId: "cws-test", workspaceId: "vm-test" },
      },
    });
  });

  it.each([
    ["idle\nidle\n", true],
    ["idle\nbusy\n", false],
    ["", false],
  ])("requires a confirmed idle daemon for %j", async (output, idle) => {
    h.exec.mockResolvedValue(output);
    await expect(cloudServiceTerminalHasExited("org-test", "cws-test", "svc-a")).resolves.toBe(idle);
    expect(h.exec).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("--filter 'label=openship.project=project-a'"), { timeout: 10_000 },
    );
    expect(h.dispose).toHaveBeenCalledOnce();
  });

  it("does not inspect another VM when the active release's binding has changed", async () => {
    h.binding.mockResolvedValue({ workspaceId: "vm-replacement", namespace: "ns-test", state: "ready" });
    await expect(cloudServiceTerminalHasExited("org-test", "cws-test", "svc-a")).resolves.toBe(false);
    expect(h.exec).not.toHaveBeenCalled();
  });
});
