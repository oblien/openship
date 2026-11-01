import { beforeEach, describe, expect, it, vi } from "vitest";
import { getBuildSessionStatus } from "@repo/platform/engine/modules/deployments/build-status.service";

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  session: vi.fn(),
  row: vi.fn(),
  live: vi.fn(),
  queue: vi.fn(),
}));

vi.mock("@repo/platform/engine/modules/deployments/cloud-build-queue-status", () => ({ getCloudBuildQueueStatus: mocks.queue }));

vi.mock("@repo/db", () => ({
  repos: {
    deployment: { findBuildSessionByDeploymentId: mocks.row, hasLiveBuildExecution: mocks.live },
    service: { listByDeployment: async () => [], listByProject: async () => [] },
  },
}));
vi.mock("@repo/platform/engine/modules/deployments/build.service", () => ({
  loadDeployment: mocks.load,
}));
vi.mock("@repo/platform/engine/modules/deployments/session-manager", () => ({
  getSession: mocks.session,
}));
vi.mock("@repo/platform/engine/modules/deployments/compose/index", () => ({
  isMultiServiceProject: () => false,
}));
vi.mock("@repo/platform/engine/lib/secret-env", () => ({
  maskServicesEnv: (value: unknown) => value,
}));
vi.mock("@repo/platform/engine/modules/domains/project-route.service", () => ({
  resolveProjectRouteState: async () => ({ publicEndpoints: [] }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.queue.mockResolvedValue(null);
  mocks.load.mockResolvedValue({
    dep: { id: "dep-1", organizationId: "org-1", status: "cancelled" },
    project: { id: "project-1" },
  });
  mocks.row.mockResolvedValue({
    status: "building",
    startedAt: new Date("2026-09-01T00:00:00Z"),
    durationMs: null,
    logs: [],
  });
  mocks.session.mockReturnValue({ status: "building", logs: [] });
  mocks.live.mockResolvedValue(true);
});

describe("build status uses the durable outcome (#919)", () => {
  it.each([
    ["cancelled", "cancelled"],
    ["ready", "ready"],
    ["failed", "failed"],
    ["action_required", "failed"],
    ["partial_failure", "ready"],
    ["reconciling", "ready"],
    ["no_changes", "ready"],
    ["rejected", "failed"],
  ])(
    "keeps terminal %s over an unfinished session and exposes %s to the build page",
    async (status, expected) => {
      mocks.load.mockResolvedValue({
        dep: { id: "dep-1", organizationId: "org-1", status },
        project: { id: "project-1" },
      });
      expect(await getBuildSessionStatus("dep-1")).toMatchObject({
        status: expected,
        deploymentStatus: status,
        is_active: false,
        completionPending: true,
        cancellationPending: status === "cancelled",
        buildDurationMs: null,
      });
      expect(mocks.live).toHaveBeenCalledExactlyOnceWith("dep-1", "project-1");
    },
  );

  it("still uses the live phase while the deployment is active", async () => {
    mocks.load.mockResolvedValue({
      dep: { id: "dep-1", organizationId: "org-1", status: "building" },
      project: { id: "project-1" },
    });
    mocks.session.mockReturnValue({ status: "deploying", logs: [] });
    expect(await getBuildSessionStatus("dep-1")).toMatchObject({
      status: "deploying",
      is_active: true,
      completionPending: false,
    });
    expect(mocks.live).not.toHaveBeenCalled();
  });

  it.each(["ready", "failed", "cancelled"])(
    "keeps %s cleanup pending when the lease cannot be read, then observes its release",
    async (status) => {
      mocks.load.mockResolvedValue({
        dep: { id: "dep-1", organizationId: "org-1", status },
        project: { id: "project-1" },
      });
      mocks.live.mockRejectedValueOnce(new Error("database unavailable")).mockResolvedValue(false);
      expect(await getBuildSessionStatus("dep-1")).toMatchObject({
        deploymentStatus: status, is_active: false, completionPending: true,
        cancellationPending: status === "cancelled",
      });
      expect(await getBuildSessionStatus("dep-1")).toMatchObject({
        deploymentStatus: status, is_active: false, completionPending: false, cancellationPending: false,
      });
      expect(mocks.live).toHaveBeenCalledTimes(2);
    },
  );

  it("observes cancellation committed between the deployment and session reads", async () => {
    mocks.load.mockResolvedValue({
      dep: { id: "dep-1", organizationId: "org-1", status: "building" },
      project: { id: "project-1" },
    });
    mocks.row.mockResolvedValue({ status: "cancelled", durationMs: 15_000, logs: [] });
    expect(await getBuildSessionStatus("dep-1")).toMatchObject({
      status: "cancelled",
      is_active: false,
      completionPending: true,
      cancellationPending: true,
      buildDurationMs: 15_000,
    });
  });

  it("uses the deployment's measured build result if the session finish write was lost", async () => {
    mocks.load.mockResolvedValue({
      dep: { id: "dep-1", organizationId: "org-1", status: "ready", buildDurationMs: 5000 },
      project: { id: "project-1" },
    });
    expect(await getBuildSessionStatus("dep-1")).toMatchObject({
      status: "ready",
      is_active: false,
      buildDurationMs: 5000,
    });
  });

  it("returns the stored duration after cancellation finishes instead of current elapsed time", async () => {
    mocks.row.mockResolvedValue({
      status: "cancelled",
      startedAt: new Date("2026-09-01T00:00:00Z"),
      durationMs: 3500,
      logs: [],
    });
    mocks.live.mockResolvedValue(false);
    expect(await getBuildSessionStatus("dep-1")).toMatchObject({
      status: "cancelled",
      is_active: false,
      completionPending: false,
      cancellationPending: false,
      buildDurationMs: 3500,
    });
  });
});


it("projects a queued Cloud build without an in-memory session as waiting", async () => {
  const queue = { position: 2, reason: "concurrency", simultaneousBuilds: 1, activeBuilds: 1, workspaceId: "ws" };
  mocks.load.mockResolvedValue({ dep: { id: "dep-1", organizationId: "org-1", status: "queued" }, project: { id: "project-1" } });
  mocks.row.mockResolvedValue({ status: "pending", startedAt: null, logs: [] });
  mocks.session.mockReturnValue(null);
  mocks.queue.mockResolvedValue(queue);
  expect(await getBuildSessionStatus("dep-1")).toMatchObject({ status: "queued", queue, is_active: false, buildStartedAt: null, progress: 0, completionPending: false });
});
