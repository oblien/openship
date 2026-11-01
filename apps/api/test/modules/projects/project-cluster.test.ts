import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionContext } from "@repo/platform";
import { AppError } from "@repo/core";

const h = vi.hoisted(() => ({
  find: vi.fn(),
  active: vi.fn(),
  latest: vi.fn(),
  lock: vi.fn(),
  fleet: vi.fn(),
  authorize: vi.fn(),
  ready: vi.fn(),
  supported: vi.fn(),
  bind: vi.fn(),
  trigger: vi.fn(),
  builds: vi.fn(),
  audit: vi.fn(),
  available: vi.fn(),
  services: vi.fn(async () => [] as Array<{ enabled: boolean }>),
  protection: vi.fn(),
  runtime: vi.fn(),
  serviceRows: vi.fn(),
  clusterRuntime: vi.fn(),
}));
vi.mock("@repo/db", () => ({
  repos: {
    routeProtection: { list: h.protection },
    project: { findById: h.find },
    deployment: { findLatestByProject: h.latest },
    clusterRuntime: { bindProject: h.bind, get: h.clusterRuntime },
    clusterDatabase: { list: vi.fn(async () => []) },
    service: { listByProject: h.services, listByDeployment: h.serviceRows },
  },
}));
vi.mock("@repo/platform/engine/lib/active-deployment", () => ({ findActiveDeployment: h.active }));
vi.mock("@repo/platform/engine/lib/project-runtime-lock", () => ({
  withProjectStateLock: async (_id: string, work: () => Promise<unknown>) => work(),
  withLiveProjectRuntimeMutation: h.lock,
}));
vi.mock("@repo/platform/engine/lib/cluster-deployment-target", () => ({
  requireClusterDeploymentTarget: h.ready,
  assertClusterWorkloadSupported: h.supported,
}));
vi.mock("@repo/platform/engine/lib/deployment-runtime", () => ({
  withDeploymentRuntime: h.runtime,
}));
vi.mock("@repo/platform/engine/modules/system/managed-network.operations", () => ({
  fleetAdmin: h.fleet,
}));
vi.mock("@repo/platform/engine/modules/system/server-cluster.operations", () => ({
  authorizeMember: h.authorize,
  assertClusterManagementAvailable: h.available,
}));
vi.mock("@repo/platform/engine/modules/deployments/build.service", () => ({
  triggerDeployment: h.trigger,
  checkNoActiveBuild: h.builds,
}));

import { createProjectClusterOperations } from "@repo/platform/engine/modules/projects/project-cluster.operations";
const ctx = { organizationId: "org", userId: "user" } as ExecutionContext;
const now = new Date("2026-09-21T09:00:00.000Z");
const project = () => ({
  id: "project",
  organizationId: "org",
  clusterId: "cluster",
  clusterConfig: { replicas: 2, imageRepository: "ghcr.io/team/api" },
  updatedAt: now,
  activeDeploymentId: "release",
  framework: "express",
  hasServer: true,
});
const operations = createProjectClusterOperations(h.audit);
beforeEach(() => {
  vi.resetAllMocks();
  h.find.mockResolvedValue(project());
  h.protection.mockResolvedValue([]);
  h.services.mockResolvedValue([]);
  h.clusterRuntime.mockResolvedValue({ provider: "k3s" });
  h.lock.mockImplementation(async (_id, work) => work(await h.find()));
  h.active.mockResolvedValue({ id: "release", meta: { clusterId: "cluster" } });
  h.ready.mockResolvedValue({
    runtime: { plan: { hosts: [{ serverId: "a" }, { serverId: "b" }] } },
  });
  h.trigger.mockResolvedValue({ deployment: { id: "scale-release" } });
});

describe("project cluster lifecycle admission", () => {
  it("refuses an unsupported target before changing a private site's destination", async () => {
    h.find.mockResolvedValue({ ...project(), clusterId: null });
    h.protection.mockResolvedValue([{ enabled: true }]);
    await expect(
      operations.setClusterTarget(ctx, "project", {
        clusterId: "cluster",
        config: { replicas: 2, imageRepository: "ghcr.io/team/api" },
        expectedUpdatedAt: now.toISOString(),
        stateless: true,
      }),
    ).rejects.toMatchObject({ code: "ROUTE_PROTECTION_UNSUPPORTED" });
    expect(h.bind).not.toHaveBeenCalled();
    expect(h.ready).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, true],
    [{ mode: "url", artifactKind: "archive" }, true],
    [{ mode: "url", artifactKind: "image" }, false],
  ])(
    "reports image delivery requirements and the saved destination for %j",
    async (releaseSource, requiresImageRepository) => {
      h.find.mockResolvedValue({
        ...project(),
        clusterId: null,
        serverId: "server-a",
        releaseSource,
      });
      expect(await operations.getClusterWorkload(ctx, "project")).toMatchObject({
        clusterId: null,
        serverId: "server-a",
        activeClusterId: "cluster",
        requiresImageRepository,
      });
      expect(h.bind).not.toHaveBeenCalled();
      expect(h.trigger).not.toHaveBeenCalled();
    },
  );
  it("reports unsupported service environments without mutating their destination", async () => {
    h.services.mockResolvedValue([{ enabled: true }]);
    const result = await operations.getClusterWorkload(ctx, "project");
    expect(result.unavailableReason).toContain("Per-service replication");
    expect(h.bind).not.toHaveBeenCalled();
    expect(h.trigger).not.toHaveBeenCalled();
  });
  it("keeps existing Swarm service scaling available while Kubernetes service scaling remains blocked", async () => {
    h.services.mockResolvedValue([{ enabled: true }]);
    h.clusterRuntime.mockResolvedValue({ provider: "swarm" });
    expect((await operations.getClusterWorkload(ctx, "project")).unavailableReason).toBeNull();
    h.clusterRuntime.mockResolvedValue({ provider: "k3s" });
    expect((await operations.getClusterWorkload(ctx, "project")).unavailableReason).toContain(
      "Per-service replication",
    );
    expect(h.bind).not.toHaveBeenCalled();
    expect(h.trigger).not.toHaveBeenCalled();
  });
  it("recognizes database images in generic Docker projects before offering replicas", async () => {
    h.find.mockResolvedValue({
      ...project(),
      framework: "docker",
      releaseSource: { mode: "url", artifactKind: "image", imageTemplate: "redis:7" },
    });
    expect((await operations.getClusterWorkload(ctx, "project")).unavailableReason).toContain(
      "Database replication",
    );
    expect(h.bind).not.toHaveBeenCalled();
  });
  it("aggregates a Compose release without treating total tasks as the per-service replica setting", async () => {
    h.active.mockResolvedValue({
      id: "release",
      containerId: "compose",
      meta: { clusterId: "cluster", clusterConfig: { replicas: 2 } },
    });
    h.serviceRows.mockResolvedValue([
      { containerId: "web-release", serviceName: "web" },
      { containerId: "db-release", serviceName: "db" },
    ]);
    const status = vi.fn(async (ref: string) => ({
      desired: ref === "web-release" ? 2 : 1,
      ready: 1,
      available: 1,
      updated: 1,
      generation: 1,
      observedGeneration: 1,
      message: ref === "web-release" ? "starting" : null,
      pods: [],
    }));
    h.runtime.mockImplementation(async (_deployment, work) =>
      work({ supports: () => true, status }),
    );
    expect(await operations.getClusterWorkload(ctx, "project")).toMatchObject({
      activeReplicas: 2,
      error: null,
      status: { desired: 3, ready: 2, available: 2, updated: 2, message: "web: starting" },
    });
    expect(status.mock.calls.map(([ref]) => ref)).toEqual(["web-release", "db-release"]);
    status.mockRejectedValueOnce(new Error("manager unreachable"));
    expect(await operations.getClusterWorkload(ctx, "project")).toMatchObject({
      status: null,
      error: "manager unreachable",
    });
  });
  it("scales through a configuration release, using the existing deployment lifecycle", async () => {
    expect(
      await operations.scaleClusterWorkload(ctx, "project", {
        replicas: 4,
        expectedDeploymentId: "release",
        expectedUpdatedAt: now.toISOString(),
      }),
    ).toEqual({ deploymentId: "scale-release" });
    expect(h.bind).toHaveBeenCalledWith(
      "org",
      "project",
      "cluster",
      { replicas: 4, imageRepository: "ghcr.io/team/api" },
      now.toISOString(),
    );
    expect(h.trigger).toHaveBeenCalledOnce();
    expect(h.trigger).toHaveBeenCalledWith(ctx, {
      projectId: "project",
      refresh: true,
      forceAll: true,
    });
  });
  it.each([
    { expectedDeploymentId: "old", expectedUpdatedAt: now.toISOString() },
    { expectedDeploymentId: "release", expectedUpdatedAt: "old" },
  ])("refuses stale controls before changing desired replicas", async (input) => {
    await expect(
      operations.scaleClusterWorkload(ctx, "project", { replicas: 4, ...input }),
    ).rejects.toMatchObject({ code: "CLUSTER_WORKLOAD_CONFLICT" });
    expect(h.bind).not.toHaveBeenCalled();
    expect(h.trigger).not.toHaveBeenCalled();
  });
  it("refuses a busy deployment and leaves desired replicas unchanged", async () => {
    h.builds.mockRejectedValue(new AppError("Deployment already running", 409));
    await expect(
      operations.scaleClusterWorkload(ctx, "project", {
        replicas: 4,
        expectedDeploymentId: "release",
        expectedUpdatedAt: now.toISOString(),
      }),
    ).rejects.toThrow("already running");
    expect(h.bind).not.toHaveBeenCalled();
  });
  it("never automatically retries a failed deployment admission", async () => {
    h.trigger.mockRejectedValue(new AppError("Registry unavailable", 502));
    await expect(
      operations.scaleClusterWorkload(ctx, "project", {
        replicas: 4,
        expectedDeploymentId: "release",
        expectedUpdatedAt: now.toISOString(),
      }),
    ).rejects.toThrow("Registry unavailable");
    expect(h.trigger).toHaveBeenCalledOnce();
  });
  it("requires fleet access and checks every host before binding a target", async () => {
    h.find.mockResolvedValue({ ...project(), clusterId: null });
    await operations.setClusterTarget(ctx, "project", {
      clusterId: "cluster",
      config: { replicas: 2, imageRepository: "ghcr.io/team/api" },
      expectedUpdatedAt: now.toISOString(),
      stateless: true,
    });
    expect(h.fleet).toHaveBeenCalledWith(ctx);
    expect(h.authorize.mock.calls).toEqual([
      [ctx, "a"],
      [ctx, "b"],
    ]);
    expect(h.supported).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project",
        framework: "express",
        imageRepository: "ghcr.io/team/api",
      }),
    );
  });
  it("cannot mutate another organization's project", async () => {
    h.find.mockResolvedValue({ ...project(), organizationId: "other" });
    await expect(
      operations.scaleClusterWorkload(ctx, "project", {
        replicas: 4,
        expectedDeploymentId: "release",
        expectedUpdatedAt: now.toISOString(),
      }),
    ).rejects.toThrow();
    expect(h.bind).not.toHaveBeenCalled();
    expect(h.trigger).not.toHaveBeenCalled();
  });
});

describe("Swarm target admission", () => {
  const input = {
    clusterId: "swarm",
    config: { replicas: 2 },
    expectedUpdatedAt: now.toISOString(),
    acknowledgePlacement: true as const,
  };
  beforeEach(() => {
    h.find.mockResolvedValue({ ...project(), clusterId: null });
    h.active.mockResolvedValue(null);
    h.ready.mockResolvedValue({
      runtime: { provider: "swarm", plan: { hosts: [{ serverId: "manager" }] } },
    });
  });
  it("requires the correct placement acknowledgement, while retaining Kubernetes confirmation", async () => {
    await expect(
      operations.setClusterTarget(ctx, "project", {
        ...input,
        acknowledgePlacement: undefined,
        stateless: true,
      }),
    ).rejects.toMatchObject({ code: "CLUSTER_PLACEMENT_ACKNOWLEDGEMENT_REQUIRED" });
    expect(h.bind).not.toHaveBeenCalled();
    await operations.setClusterTarget(ctx, "project", input);
    expect(h.bind).toHaveBeenCalledWith(
      "org",
      "project",
      "swarm",
      { replicas: 2 },
      now.toISOString(),
    );
    h.bind.mockClear();
    h.ready.mockResolvedValue({
      runtime: { provider: "k3s", plan: { hosts: [{ serverId: "manager" }] } },
    });
    await expect(operations.setClusterTarget(ctx, "project", input)).rejects.toMatchObject({
      code: "CLUSTER_PLACEMENT_ACKNOWLEDGEMENT_REQUIRED",
    });
    expect(h.bind).not.toHaveBeenCalled();
  });
  it.each(["ready", "failed", "cancelled"])(
    "requires migration for a previously deployed project (%s), even without an active pointer",
    async (status) => {
      h.find.mockResolvedValue({ ...project(), clusterId: null, activeDeploymentId: null });
      h.latest.mockResolvedValue({ id: "existing", status, containerId: "docker-container" });
      await expect(operations.setClusterTarget(ctx, "project", input)).rejects.toMatchObject({
        code: "CLUSTER_MIGRATION_REQUIRED",
      });
      expect(h.bind).not.toHaveBeenCalled();
      expect(h.trigger).not.toHaveBeenCalled();
    },
  );
  it("keeps replica edits on the already-selected Swarm available", async () => {
    h.find.mockResolvedValue({ ...project(), clusterId: "swarm" });
    h.latest.mockResolvedValue({ id: "existing", status: "ready" });
    await operations.setClusterTarget(ctx, "project", { ...input, config: { replicas: 3 } });
    expect(h.latest).not.toHaveBeenCalled();
    expect(h.bind).toHaveBeenCalledWith(
      "org",
      "project",
      "swarm",
      { replicas: 3 },
      now.toISOString(),
    );
  });
});
