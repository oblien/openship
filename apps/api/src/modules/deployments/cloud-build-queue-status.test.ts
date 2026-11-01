import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCloudBuildQueueStatus } from "@repo/platform/engine/modules/deployments/cloud-build-queue-status";

const mocks = vi.hoisted(() => ({
  cloud: true,
  limit: vi.fn(),
  active: vi.fn(),
  waiting: vi.fn(),
  reservations: vi.fn(),
  position: vi.fn(),
}));
vi.mock("@repo/platform/engine/config/env", () => ({
  env: {
    get CLOUD_MODE() {
      return mocks.cloud;
    },
  },
}));
vi.mock("@repo/platform/engine/lib/plan-guard", () => ({ planBuildConcurrency: mocks.limit }));
vi.mock("@repo/db", () => ({
  repos: {
    deployment: {
      countActiveCloudBuilds: mocks.active,
      listRequestedCloudBuilds: mocks.waiting,
      getCloudBuildQueuePosition: mocks.position,
    },
    cloudBuildActivity: { listReservations: mocks.reservations },
  },
}));
const project = { id: "p", organizationId: "org", workspaceId: "ws" } as any;
const dep = {
  id: "dep",
  projectId: "p",
  organizationId: "org",
  status: "queued",
  meta: { cloudBuildRequested: true },
} as any;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.cloud = true;
  mocks.reservations.mockResolvedValue([]);
  mocks.position.mockResolvedValue(2);
  mocks.limit.mockResolvedValue(2);
  mocks.active.mockResolvedValue(2);
  mocks.waiting.mockResolvedValue([{ id: "earlier", organizationId: "org" }, dep]);
});
describe("Cloud queue status", () => {
  it("reports workspace order and the plan allowance", async () => {
    expect(await getCloudBuildQueueStatus(project, dep)).toEqual({
      position: 2,
      reason: "concurrency",
      simultaneousBuilds: 2,
      activeBuilds: 2,
      workspaceId: "ws",
    });
    expect(mocks.active).toHaveBeenCalledWith("ws", "org");
    expect(mocks.limit).toHaveBeenCalledWith("org", "ws");
    expect(mocks.reservations).toHaveBeenCalledWith("ws", "org");
    expect(mocks.position).toHaveBeenCalledWith("dep", "org");
    expect(mocks.waiting).not.toHaveBeenCalled();
  });
  it("adds resource reservations to legacy leases, excluding lifecycle-only activity", async () => {
    mocks.active.mockResolvedValue(1);
    mocks.reservations.mockResolvedValue([
      { resources: { cpuCores: 1, memoryMb: 1024 } },
      { resources: null },
      { resources: { cpuCores: 2, memoryMb: 2048 } },
    ]);
    mocks.limit.mockResolvedValue(3);
    expect(await getCloudBuildQueueStatus(project, dep)).toMatchObject({
      activeBuilds: 3,
      reason: "concurrency",
    });
  });
  it("does not consume concurrency for activities without resources", async () => {
    mocks.active.mockResolvedValue(0);
    mocks.reservations.mockResolvedValue([{ resources: null }, { resources: null }]);
    expect(await getCloudBuildQueueStatus(project, dep)).toMatchObject({
      activeBuilds: 0,
      reason: "server",
    });
  });
  it("does not scan queue pages when the position lookup returns null", async () => {
    mocks.position.mockResolvedValue(null);
    expect((await getCloudBuildQueueStatus(project, dep))?.position).toBeNull();
    expect(mocks.waiting).not.toHaveBeenCalled();
  });
  it.each(["resources", "server"])(
    "projects a persisted %s wait without inventing a plan cap",
    async (reason) => {
      mocks.limit.mockResolvedValue(null);
      expect(
        await getCloudBuildQueueStatus(project, {
          ...dep,
          meta: { ...dep.meta, cloudBuildQueueReason: reason },
        }),
      ).toMatchObject({ reason, simultaneousBuilds: null });
    },
  );
  it("preserves the queue's FIFO concurrency reason even below the cap", async () => {
    mocks.active.mockResolvedValue(0);
    expect(
      await getCloudBuildQueueStatus(project, {
        ...dep,
        meta: { ...dep.meta, cloudBuildQueueReason: "concurrency" },
      }),
    ).toMatchObject({ activeBuilds: 0, reason: "concurrency" });
  });
  it("leaves a raced position unknown", async () => {
    mocks.position.mockResolvedValue(null);
    mocks.active.mockResolvedValue(0);
    expect(await getCloudBuildQueueStatus(project, dep)).toMatchObject({
      position: null,
      reason: "server",
    });
  });
  it("does no queue or billing reads in selfhost", async () => {
    mocks.cloud = false;
    expect(await getCloudBuildQueueStatus(project, dep)).toBeNull();
    expect(mocks.limit).not.toHaveBeenCalled();
    expect(mocks.waiting).not.toHaveBeenCalled();
    expect(mocks.reservations).not.toHaveBeenCalled();
    expect(mocks.position).not.toHaveBeenCalled();
  });
  it.each([
    { ...dep, status: "building" },
    { ...dep, meta: {} },
    { ...dep, organizationId: "foreign" },
  ])("omits nonwaiting or foreign deployments", async (candidate) => {
    expect(await getCloudBuildQueueStatus(project, candidate)).toBeNull();
    expect(mocks.active).not.toHaveBeenCalled();
  });
});
