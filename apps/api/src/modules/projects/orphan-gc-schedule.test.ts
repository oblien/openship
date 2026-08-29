import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  orphans: [] as Array<Record<string, unknown>>,
  listAll: vi.fn(),
  acquireGcLock: vi.fn(),
  releaseGcLock: vi.fn(async () => {}),
  findProject: vi.fn(async (): Promise<Record<string, unknown> | undefined> => undefined),
  findDomain: vi.fn(async (): Promise<Record<string, unknown> | undefined> => undefined),
  getServer: vi.fn(async (): Promise<Record<string, unknown> | undefined> => undefined),
  deleteOrphan: vi.fn(async () => {}),
  bumpAttempt: vi.fn(async () => {}),
  updatePayload: vi.fn(async () => {}),
  isReachable: vi.fn(async () => true),
  resolveDeploymentPlatform: vi.fn(),
  disposePlatform: vi.fn(),
  removeRoute: vi.fn(async () => {}),
  destroy: vi.fn(async (_ref: string) => {}),
  listProjectContainerIds: vi.fn(async (_projectId: string) => [] as string[]),
  inspectNamedVolumes: vi.fn(async (_containerId: string) => [] as string[]),
  removeVolume: vi.fn(async (_name: string) => {}),
  listProjectImages: vi.fn(
    async (_projectId: string) => [] as Array<{ id: string; repoTags: string[] }>,
  ),
  removeImage: vi.fn(async (_ref: string) => {}),
  removeNetwork: vi.fn(async (_slug: string) => {}),
  convergeClaims: vi.fn(async () => ({
    released: 0,
    retained: [] as Array<{ port: number }>,
  })),
  edgeProxyFor: vi.fn(),
  edgeProxy: { listLoopbackUpstreamPortsStrict: vi.fn() },
  executor: { exec: vi.fn() },
  releaseManagedHostnames: vi.fn(async () => ({ failures: [] as string[] })),
}));

vi.mock("@repo/db", () => ({
  tryAcquireAdvisoryLock: h.acquireGcLock,
  repos: {
    project: { findById: h.findProject },
    domain: { findByHostname: h.findDomain },
    server: { getInOrganization: h.getServer },
    orphanedResource: {
      listAll: h.listAll,
      delete: h.deleteOrphan,
      bumpAttempt: h.bumpAttempt,
      updatePayload: h.updatePayload,
    },
  },
}));

vi.mock("@repo/adapters", () => ({
  DockerRuntime: class DockerRuntime {
    readonly name = "docker";
    destroy = h.destroy;
    listProjectContainerIds = h.listProjectContainerIds;
    inspectNamedVolumes = h.inspectNamedVolumes;
    removeVolume = h.removeVolume;
    listProjectImages = h.listProjectImages;
    removeImage = h.removeImage;
    removeNetwork = h.removeNetwork;
  },
  edgeProxyFor: h.edgeProxyFor,
  isRuntimeNotFoundError: () => false,
  ownsBuiltImage: (ref: string) => ref.startsWith("openship/"),
}));

vi.mock("../../lib/server-reachability", () => ({
  createReachabilityProbe: () => ({ isReachable: h.isReachable }),
}));

vi.mock("../../lib/remote-state", () => ({ isConnectionLoss: () => false }));

vi.mock("../../lib/deployment-runtime", () => ({
  resolveDeploymentPlatform: h.resolveDeploymentPlatform,
  disposePlatform: h.disposePlatform,
}));

vi.mock("../deployments/pinned-host-ports", () => ({
  convergeTargetHostPortClaims: h.convergeClaims,
}));

vi.mock("../../lib/managed-edge-proxy", () => ({
  releaseManagedHostnames: h.releaseManagedHostnames,
}));

import { DockerRuntime } from "@repo/adapters";
import { runOrphanSweep } from "./orphan-gc-schedule";

const routeOrphan = (over: Record<string, unknown> = {}) => ({
  id: "orphan-route-1",
  organizationId: "org-1",
  serverId: "server-1",
  targetKey: `host:${"a".repeat(64)}`,
  resourceType: "route",
  ref: "app.example.com",
  projectId: "project-1",
  label: "project route",
  runtimeMode: "docker",
  payload: null,
  attempts: 0,
  lastAttemptAt: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  ...over,
});

const resolvedPlatform = (over: Record<string, unknown> = {}) => ({
  platform: {
    target: "selfhosted",
    runtime: { name: "docker", destroy: h.destroy },
    routing: { removeRoute: h.removeRoute },
    ssl: {},
    system: null,
    executor: h.executor,
    localHost: false,
  },
  effectiveTarget: "server",
  runtimeMode: "docker",
  usesManagedRouting: false,
  serverId: "server-1",
  hostPortTarget: {
    targetKey: `host:${"a".repeat(64)}`,
    legacyTargetKeys: ["server:server-1"],
    stable: true,
  },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.orphans = [];
  h.acquireGcLock.mockImplementation(async () => ({ release: h.releaseGcLock }));
  h.listAll.mockImplementation(async () => h.orphans);
  h.resolveDeploymentPlatform.mockResolvedValue(resolvedPlatform());
  h.findProject.mockResolvedValue(undefined);
  h.findDomain.mockResolvedValue(undefined);
  h.getServer.mockResolvedValue(undefined);
  h.convergeClaims.mockResolvedValue({ released: 0, retained: [] });
  h.edgeProxyFor.mockReturnValue(h.edgeProxy);
});

describe("runOrphanSweep route claim lifecycle", () => {
  it("removes the route, converges claims, releases managed routing, then deletes the row", async () => {
    h.orphans = [routeOrphan()];

    await expect(runOrphanSweep()).resolves.toEqual({ reclaimed: 1, deferred: 0 });

    expect(h.isReachable).toHaveBeenCalledWith("server-1");
    expect(h.resolveDeploymentPlatform).toHaveBeenCalledWith(
      { deployTarget: "server", runtimeMode: "docker", serverId: "server-1" },
      { organizationId: "org-1" },
    );
    expect(h.removeRoute).toHaveBeenCalledWith("app.example.com");
    expect(h.edgeProxyFor).toHaveBeenCalledWith(h.executor, "openresty", { ours: true });
    expect(h.convergeClaims).toHaveBeenCalledWith({
      target: {
        targetKey: `host:${"a".repeat(64)}`,
        legacyTargetKeys: ["server:server-1"],
        stable: true,
      },
      projectId: "project-1",
      desiredPublishes: [],
      edgeProxy: h.edgeProxy,
    });
    expect(h.releaseManagedHostnames).toHaveBeenCalledWith(["app.example.com"], {
      organizationId: "org-1",
    });
    expect(h.deleteOrphan).toHaveBeenCalledWith("orphan-route-1");
    expect(h.bumpAttempt).not.toHaveBeenCalled();

    expect(h.removeRoute.mock.invocationCallOrder[0]).toBeLessThan(
      h.convergeClaims.mock.invocationCallOrder[0]!,
    );
    expect(h.convergeClaims.mock.invocationCallOrder[0]).toBeLessThan(
      h.releaseManagedHostnames.mock.invocationCallOrder[0]!,
    );
    expect(h.releaseManagedHostnames.mock.invocationCallOrder[0]).toBeLessThan(
      h.deleteOrphan.mock.invocationCallOrder[0]!,
    );
  });

  it("converges a claim-only orphan without inventing or removing a hostname", async () => {
    h.orphans = [
      routeOrphan({
        id: "orphan-claims-1",
        resourceType: "host_port_claims",
        ref: "host:claim-target",
        label: "host-port claims on host:claim-target",
      }),
    ];

    await expect(runOrphanSweep()).resolves.toEqual({ reclaimed: 1, deferred: 0 });

    expect(h.removeRoute).not.toHaveBeenCalled();
    expect(h.convergeClaims).toHaveBeenCalledWith({
      target: resolvedPlatform().hostPortTarget,
      projectId: "project-1",
      desiredPublishes: [],
      edgeProxy: h.edgeProxy,
    });
    expect(h.releaseManagedHostnames).not.toHaveBeenCalled();
    expect(h.deleteOrphan).toHaveBeenCalledWith("orphan-claims-1");
  });

  it("defers the orphan and keeps its row when fresh claim convergence fails", async () => {
    h.orphans = [routeOrphan()];
    h.convergeClaims.mockRejectedValueOnce(new Error("strict edge scan failed"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(runOrphanSweep()).resolves.toEqual({ reclaimed: 0, deferred: 1 });

    expect(h.removeRoute).toHaveBeenCalledWith("app.example.com");
    expect(h.convergeClaims).toHaveBeenCalledOnce();
    expect(h.releaseManagedHostnames).not.toHaveBeenCalled();
    expect(h.bumpAttempt).toHaveBeenCalledWith("orphan-route-1");
    expect(h.deleteOrphan).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledWith(
      "[orphan-gc] route app.example.com failed:",
      "strict edge scan failed",
    );

    errorLog.mockRestore();
  });

  it("keeps the route orphan when its managed edge registration cannot be released", async () => {
    h.orphans = [routeOrphan({ ref: "app.opsh.io" })];
    h.releaseManagedHostnames.mockResolvedValueOnce({ failures: ["app.opsh.io"] });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(runOrphanSweep()).resolves.toEqual({ reclaimed: 0, deferred: 1 });

    expect(h.removeRoute).toHaveBeenCalledWith("app.opsh.io");
    expect(h.convergeClaims).toHaveBeenCalledOnce();
    expect(h.releaseManagedHostnames).toHaveBeenCalledWith(["app.opsh.io"], {
      organizationId: "org-1",
    });
    expect(h.bumpAttempt).toHaveBeenCalledWith("orphan-route-1");
    expect(h.deleteOrphan).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledWith(
      "[orphan-gc] route app.opsh.io failed:",
      expect.stringContaining("Cloud edge route not released"),
    );

    errorLog.mockRestore();
  });

  it("defers while the originating project row still exists", async () => {
    h.orphans = [routeOrphan()];
    h.findProject.mockResolvedValueOnce({ id: "project-1", deletionInProgress: true });

    await expect(runOrphanSweep()).resolves.toEqual({ reclaimed: 0, deferred: 1 });

    expect(h.bumpAttempt).toHaveBeenCalledWith("orphan-route-1");
    expect(h.resolveDeploymentPlatform).not.toHaveBeenCalled();
    expect(h.removeRoute).not.toHaveBeenCalled();
    expect(h.convergeClaims).not.toHaveBeenCalled();
    expect(h.deleteOrphan).not.toHaveBeenCalled();
  });

  it("never removes a deferred route after the hostname has a live owner", async () => {
    h.orphans = [routeOrphan()];
    h.findDomain.mockResolvedValueOnce({ id: "new-domain", projectId: "new-project" });

    await expect(runOrphanSweep()).resolves.toEqual({ reclaimed: 0, deferred: 1 });

    expect(h.bumpAttempt).toHaveBeenCalledWith("orphan-route-1");
    expect(h.resolveDeploymentPlatform).not.toHaveBeenCalled();
    expect(h.removeRoute).not.toHaveBeenCalled();
    expect(h.releaseManagedHostnames).not.toHaveBeenCalled();
    expect(h.deleteOrphan).not.toHaveBeenCalled();
  });

  it("keeps the route orphan while another vhost still protects a project claim", async () => {
    h.orphans = [routeOrphan()];
    h.convergeClaims.mockResolvedValueOnce({
      released: 0,
      retained: [{ port: 23_000 }],
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(runOrphanSweep()).resolves.toEqual({ reclaimed: 0, deferred: 1 });

    expect(h.bumpAttempt).toHaveBeenCalledWith("orphan-route-1");
    expect(h.deleteOrphan).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledWith(
      "[orphan-gc] route app.example.com failed:",
      expect.stringContaining("23000"),
    );

    errorLog.mockRestore();
  });

  it("defers claim convergence when target identity prerequisites are missing", async () => {
    h.orphans = [
      routeOrphan({
        id: "orphan-claims-missing-target",
        resourceType: "host_port_claims",
        ref: "unknown-target",
      }),
    ];
    h.resolveDeploymentPlatform.mockResolvedValueOnce(
      resolvedPlatform({
        hostPortTarget: null,
        platform: { ...resolvedPlatform().platform, executor: null },
      }),
    );
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(runOrphanSweep()).resolves.toEqual({ reclaimed: 0, deferred: 1 });

    expect(h.convergeClaims).not.toHaveBeenCalled();
    expect(h.deleteOrphan).not.toHaveBeenCalled();
    expect(h.bumpAttempt).toHaveBeenCalledWith("orphan-claims-missing-target");
    errorLog.mockRestore();
  });

  it("does not remove a route or release claims while a same-target workload cleanup failed", async () => {
    h.orphans = [
      routeOrphan({
        id: "orphan-container-1",
        resourceType: "container",
        ref: "container-1",
        label: "container 1",
      }),
      routeOrphan(),
    ];
    h.destroy.mockRejectedValueOnce(new Error("container destroy failed"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(runOrphanSweep()).resolves.toEqual({ reclaimed: 0, deferred: 2 });

    expect(h.bumpAttempt).toHaveBeenCalledWith("orphan-container-1");
    expect(h.bumpAttempt).toHaveBeenCalledWith("orphan-route-1");
    expect(h.removeRoute).not.toHaveBeenCalled();
    expect(h.convergeClaims).not.toHaveBeenCalled();
    expect(h.deleteOrphan).not.toHaveBeenCalled();

    errorLog.mockRestore();
  });

  it("groups a local self-server alias with the same physical local route target", async () => {
    h.orphans = [
      routeOrphan({
        id: "orphan-container-local-alias",
        serverId: "self-server-row",
        targetKey: "local",
        resourceType: "container",
        ref: "container-local",
      }),
      routeOrphan({
        id: "orphan-route-local",
        serverId: null,
        targetKey: "local",
      }),
    ];
    h.getServer.mockResolvedValueOnce({ id: "self-server-row", isLocal: true });
    h.destroy.mockRejectedValueOnce(new Error("container still owns the bind"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(runOrphanSweep()).resolves.toEqual({ reclaimed: 0, deferred: 2 });

    expect(h.removeRoute).not.toHaveBeenCalled();
    expect(h.convergeClaims).not.toHaveBeenCalled();
    expect(h.deleteOrphan).not.toHaveBeenCalled();
    errorLog.mockRestore();
  });
});

describe("runOrphanSweep target selection", () => {
  it("resolves a null-server docker orphan as local self-hosted, never cloud", async () => {
    h.orphans = [
      routeOrphan({
        id: "orphan-container-1",
        serverId: null,
        targetKey: "local",
        resourceType: "container",
        ref: "container-1",
        projectId: null,
      }),
    ];
    h.resolveDeploymentPlatform.mockResolvedValue(
      resolvedPlatform({
        effectiveTarget: "local",
        serverId: null,
        hostPortTarget: { targetKey: "local", legacyTargetKeys: [], stable: true },
        platform: {
          ...resolvedPlatform().platform,
          localHost: true,
        },
      }),
    );

    await expect(runOrphanSweep()).resolves.toEqual({ reclaimed: 1, deferred: 0 });

    expect(h.resolveDeploymentPlatform).toHaveBeenCalledOnce();
    expect(h.resolveDeploymentPlatform).toHaveBeenCalledWith(
      { deployTarget: "local", runtimeMode: "docker" },
      { organizationId: "org-1" },
    );
    expect(h.isReachable).not.toHaveBeenCalled();
    expect(h.destroy).toHaveBeenCalledWith("container-1");
    expect(h.releaseManagedHostnames).not.toHaveBeenCalled();
    expect(h.deleteOrphan).toHaveBeenCalledWith("orphan-container-1");
  });

  it("replays an unreachable Docker target sweep before releasing its route fence", async () => {
    const runtime = new (DockerRuntime as unknown as new () => DockerRuntime)();
    h.orphans = [
      routeOrphan({
        id: "orphan-target-sweep",
        resourceType: "project_target_sweep",
        ref: "project-1",
        label: "project target server-1",
        payload: {
          slug: "app",
          wipeVolumes: true,
          containerIds: ["known-container"],
          imageRefs: ["openship/app:bld_1", "postgres:17"],
          artifactRefs: ["/opt/openship/static/releases/dep-1"],
          volumeNames: [],
        },
      }),
    ];
    h.listProjectContainerIds.mockResolvedValueOnce(["known-container", "labelled-container"]);
    h.inspectNamedVolumes.mockImplementation(async (id: string) =>
      id === "known-container" ? ["app-data"] : [],
    );
    h.listProjectImages.mockResolvedValueOnce([{ id: "sha256:owned", repoTags: [] }]);
    h.resolveDeploymentPlatform.mockResolvedValueOnce(
      resolvedPlatform({
        platform: { ...resolvedPlatform().platform, runtime },
      }),
    );

    await expect(runOrphanSweep()).resolves.toEqual({ reclaimed: 1, deferred: 0 });

    expect(h.listProjectContainerIds).toHaveBeenCalledWith("project-1");
    expect(h.inspectNamedVolumes).toHaveBeenCalledWith("known-container");
    expect(h.inspectNamedVolumes).toHaveBeenCalledWith("labelled-container");
    expect(h.destroy.mock.calls.map(([ref]) => ref)).toEqual([
      "known-container",
      "labelled-container",
      "/opt/openship/static/releases/dep-1",
    ]);
    expect(h.removeVolume).toHaveBeenCalledWith("app-data");
    expect(h.updatePayload).toHaveBeenCalledWith(
      "orphan-target-sweep",
      expect.objectContaining({ volumeNames: ["app-data"] }),
    );
    expect(h.removeImage).toHaveBeenCalledWith("openship/app:bld_1");
    expect(h.removeImage).toHaveBeenCalledWith("sha256:owned");
    expect(h.removeImage).not.toHaveBeenCalledWith("postgres:17");
    expect(h.removeNetwork).toHaveBeenCalledWith("app");
    expect(h.deleteOrphan).toHaveBeenCalledWith("orphan-target-sweep");
    expect(h.inspectNamedVolumes.mock.invocationCallOrder.at(-1)).toBeLessThan(
      h.updatePayload.mock.invocationCallOrder[0]!,
    );
    expect(h.updatePayload.mock.invocationCallOrder[0]).toBeLessThan(
      h.destroy.mock.invocationCallOrder[0]!,
    );
    expect(h.destroy.mock.invocationCallOrder.at(-1)).toBeLessThan(
      h.removeVolume.mock.invocationCallOrder[0]!,
    );
    expect(h.removeImage.mock.invocationCallOrder.at(-1)).toBeLessThan(
      h.removeNetwork.mock.invocationCallOrder[0]!,
    );
  });

  it("keeps the target sweep when volume discovery fails before destruction", async () => {
    const runtime = new (DockerRuntime as unknown as new () => DockerRuntime)();
    h.orphans = [
      routeOrphan({
        id: "orphan-target-sweep",
        resourceType: "project_target_sweep",
        ref: "project-1",
        payload: {
          slug: "app",
          wipeVolumes: true,
          containerIds: ["container-with-data"],
          imageRefs: [],
          artifactRefs: [],
          volumeNames: [],
        },
      }),
    ];
    h.inspectNamedVolumes.mockRejectedValueOnce(new Error("inspect failed"));
    h.resolveDeploymentPlatform.mockResolvedValueOnce(
      resolvedPlatform({ platform: { ...resolvedPlatform().platform, runtime } }),
    );
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(runOrphanSweep()).resolves.toEqual({ reclaimed: 0, deferred: 1 });

    expect(h.destroy).not.toHaveBeenCalled();
    expect(h.removeVolume).not.toHaveBeenCalled();
    expect(h.deleteOrphan).not.toHaveBeenCalled();
    expect(h.bumpAttempt).toHaveBeenCalledWith("orphan-target-sweep");
    errorLog.mockRestore();
  });

  it("never follows a repointed server row to a different physical target", async () => {
    const runtime = new (DockerRuntime as unknown as new () => DockerRuntime)();
    h.orphans = [
      routeOrphan({
        id: "orphan-repointed-target",
        targetKey: `host:${"a".repeat(64)}`,
        resourceType: "project_target_sweep",
        ref: "project-1",
        payload: {
          slug: "app",
          wipeVolumes: false,
          containerIds: ["same-named-container"],
          imageRefs: [],
          artifactRefs: [],
          volumeNames: [],
        },
      }),
    ];
    h.getServer.mockResolvedValueOnce({
      id: "server-1",
      isLocal: false,
      sshHost: "replacement.example.com",
      sshPort: 22,
      sshJumpHost: null,
      sshArgs: null,
    });
    h.resolveDeploymentPlatform.mockResolvedValueOnce(
      resolvedPlatform({
        hostPortTarget: {
          targetKey: `host:${"b".repeat(64)}`,
          legacyTargetKeys: ["server:server-1"],
          stable: true,
        },
        platform: { ...resolvedPlatform().platform, runtime },
      }),
    );
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(runOrphanSweep()).resolves.toEqual({ reclaimed: 0, deferred: 1 });

    expect(h.destroy).not.toHaveBeenCalled();
    expect(h.listProjectContainerIds).not.toHaveBeenCalled();
    expect(h.deleteOrphan).not.toHaveBeenCalled();
    expect(h.bumpAttempt).toHaveBeenCalledWith("orphan-repointed-target");
    errorLog.mockRestore();
  });
});

describe("runOrphanSweep execution fence", () => {
  it("skips an overlapping tick instead of starting a second destructive sweep", async () => {
    let finishList!: (orphans: Array<Record<string, unknown>>) => void;
    h.listAll.mockImplementationOnce(
      () => new Promise<Array<Record<string, unknown>>>((resolve) => (finishList = resolve)),
    );

    const first = runOrphanSweep();
    await vi.waitFor(() => expect(h.listAll).toHaveBeenCalledOnce());

    await expect(runOrphanSweep()).resolves.toEqual({ reclaimed: 0, deferred: 0 });
    expect(h.acquireGcLock).toHaveBeenCalledOnce();

    finishList([]);
    await expect(first).resolves.toEqual({ reclaimed: 0, deferred: 0 });
    expect(h.releaseGcLock).toHaveBeenCalledOnce();
  });

  it("reopens the in-process fence even when advisory-lock release fails", async () => {
    h.releaseGcLock.mockRejectedValueOnce(new Error("unlock failed"));

    await expect(runOrphanSweep()).rejects.toThrow("unlock failed");
    await expect(runOrphanSweep()).resolves.toEqual({ reclaimed: 0, deferred: 0 });

    expect(h.acquireGcLock).toHaveBeenCalledTimes(2);
  });
});
