import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { repos } from "@repo/db";
import type { Project } from "@repo/db";
import { resolveServicePipelineMode } from "@repo/platform/engine/modules/deployments/build-pipeline";
import {
  pinnedAppImage,
  snapshotNeedsGitSource,
} from "@repo/platform/engine/modules/deployments/pinned-artifacts";
import type { DeploymentConfigSnapshot } from "@repo/platform/engine/modules/deployments/build.service";

const h = vi.hoisted(() => ({ requestBuild: vi.fn() }));
vi.mock("@repo/platform/engine/modules/deployments/build.service", async (load) => ({
  ...(await load<typeof import("@repo/platform/engine/modules/deployments/build.service")>()),
  requestBuildAccess: h.requestBuild,
}));
vi.mock("@repo/platform/engine/modules/migration/migration-access", () => ({
  assertMigrationEndpoints: async () => ({ source: {}, target: {} }),
}));
vi.mock("@repo/platform/engine/modules/migration/migration-storage", async (load) => ({
  ...(await load<typeof import("@repo/platform/engine/modules/migration/migration-storage")>()),
  scopeImportedStorage: async () => {},
}));
vi.mock("@repo/platform/engine/modules/migration/migration-routes", async (load) => ({
  ...(await load<typeof import("@repo/platform/engine/modules/migration/migration-routes")>()),
  saveMigrationRoutes: async () => [],
}));
vi.mock("@repo/platform/engine/modules/migration/migration-runtime", async (load) => ({
  ...(await load<typeof import("@repo/platform/engine/modules/migration/migration-runtime")>()),
  withMigrationActivity: (
    _org: unknown,
    _source: unknown,
    _target: unknown,
    _run: unknown,
    work: () => Promise<unknown>,
  ) => work(),
}));
vi.mock("@repo/platform/engine/modules/projects/project-runtime.service", async (load) => ({
  ...(await load<
    typeof import("@repo/platform/engine/modules/projects/project-runtime.service")
  >()),
  syncProjectManagedEdge: async () => ({ ok: true, failures: [] }),
}));
vi.mock("@repo/platform/engine/modules/migration/migrate.service", async (load) => ({
  ...(await load<typeof import("@repo/platform/engine/modules/migration/migrate.service")>()),
  joinReusedContainersToGroup: async () => {},
  attachLiveRuntime: async () => {},
}));

import { migrationOrchestrator } from "@repo/platform/engine/modules/migration/migration.orchestrator";
import type { DiscoveredService } from "@repo/platform/engine/modules/migration/docker-reconcile";
import type { StartMigrationInput } from "@repo/platform/engine/modules/migration/migration.orchestrator";
import type { AdoptResult } from "@repo/platform/engine/modules/migration/migrate.service";

// Run the production migration flow; only host/database boundaries and unrelated
// routing work are replaced. The target deployment request is observed directly.
const engine = migrationOrchestrator as unknown as {
  run: (ctx: unknown, id: string, input: StartMigrationInput) => Promise<void>;
  resolveScannedWorkload: () => Promise<unknown>;
  resolveOwnedProjectWorkload: () => Promise<unknown>;
  moveData: () => Promise<unknown>;
  throwIfCancelled: () => Promise<void>;
  transition: (id: string, status: string, patch?: unknown) => Promise<void>;
  appendLog: () => void;
  waitForDeployment: () => Promise<unknown>;
  carrySourceCerts: () => Promise<void>;
  adoptSourceProxySettings: () => Promise<void>;
  logLiveState: () => Promise<void>;
  rollback: () => Promise<void>;
};
let chosen: DiscoveredService[];
let adopt: AdoptResult;
let imageRefs: Map<string, string>;
let project: Partial<Project>;
let attachChosen: DiscoveredService[];
const sourceImage = `openship/app@sha256:${"a".repeat(64)}`;
const sourceId = `sha256:${"b".repeat(64)}`;
const loadedId = `sha256:${"c".repeat(64)}`;

beforeEach(() => {
  vi.clearAllMocks();
  chosen = [
    {
      name: "web",
      source: "container",
      running: true,
      containerId: "source-container",
      image: sourceImage,
      imageId: sourceId,
      ports: [],
      env: {},
      networks: [],
      volumes: [],
      dependsOn: [],
      warnings: [],
    },
  ];
  adopt = {
    projectId: "project",
    slug: "app",
    created: false,
    adopted: ["frontend"],
    rowNameByDiscovered: { web: "frontend" },
    renames: { "source-container": "frontend" },
    handover: { frontend: sourceImage },
  };
  imageRefs = new Map([[sourceId, loadedId]]);
  project = {
    id: "project",
    organizationId: "org",
    framework: "docker-compose",
    slug: "app",
    runtimeMode: "docker",
  };
  attachChosen = [];
  const workload = async () => ({
    chosen,
    deployChosen: chosen.filter((service) => !attachChosen.includes(service)),
    attachChosen,
    adopt,
  });
  vi.spyOn(engine, "resolveScannedWorkload").mockImplementation(workload);
  vi.spyOn(engine, "resolveOwnedProjectWorkload").mockImplementation(workload);
  vi.spyOn(engine, "moveData").mockImplementation(async () => ({
    bytesMoved: 10,
    targetVolumes: [],
    pendingItems: [],
    imageRefs,
  }));
  for (const method of [
    "throwIfCancelled",
    "transition",
    "carrySourceCerts",
    "adoptSourceProxySettings",
    "logLiveState",
    "rollback",
  ] as const) {
    vi.spyOn(engine, method).mockResolvedValue();
  }
  vi.spyOn(engine, "appendLog").mockImplementation(() => {});
  vi.spyOn(engine, "waitForDeployment").mockResolvedValue({ status: "ready" });
  vi.spyOn(repos.dockerMigrationRun, "bindProject").mockResolvedValue({ id: "run" } as never);
  vi.spyOn(repos.dockerMigrationRun, "placeProject").mockResolvedValue({} as never);
  vi.spyOn(repos.dockerMigrationRun, "findById").mockResolvedValue({
    id: "run",
    killOriginals: false,
  } as never);
  vi.spyOn(repos.service, "listByProject").mockResolvedValue([
    { id: "service", name: "frontend", enabled: true },
  ] as never);
  vi.spyOn(repos.project, "findById").mockImplementation(async () => project as Project);
  vi.spyOn(repos.domain, "listByProject").mockResolvedValue([]);
  h.requestBuild.mockResolvedValue({ deployment_id: "target-deployment" });
});
afterEach(() => vi.restoreAllMocks());

const run = (overrides: Partial<StartMigrationInput> = {}) =>
  engine.run({ organizationId: "org" }, "run", {
    organizationId: "org",
    sourceServerId: "source",
    targetServerId: "target",
    projectName: "app",
    serviceNames: ["web"],
    ...overrides,
  } as StartMigrationInput);

describe("migration target artifact handover", () => {
  it("deploys a transferred digest by its target reference using the final service name", async () => {
    await run();
    expect(engine.rollback).not.toHaveBeenCalled();
    expect(h.requestBuild).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ serviceIds: ["service"] }),
      expect.objectContaining({
        handoverImages: { frontend: loadedId },
      }),
    );
    expect(chosen[0]!.image).toBe(sourceImage);
    expect(h.requestBuild.mock.calls[0]?.[2]).not.toHaveProperty("handoverAppImage");
  });

  it("preserves existing handover when an image was not transferred", async () => {
    imageRefs.clear();
    await run();
    expect(engine.rollback).not.toHaveBeenCalled();
    expect(h.requestBuild.mock.calls[0]?.[2]).toMatchObject({
      handoverImages: { frontend: sourceImage },
    });
  });

  it.each(["move", "copy"] as const)(
    "deploys a project-owned single worker app during %s without rebuilding",
    async (intent) => {
      project = { ...project, framework: "docker", workloadType: "worker", hasServer: false };
      vi.mocked(repos.service.listByProject).mockResolvedValue([]);
      await run({ projectMove: { projectId: "project", intent } });
      expect(engine.rollback).not.toHaveBeenCalled();
      const [, request, internal] = h.requestBuild.mock.calls[0]!;
      expect(request).toMatchObject({
        projectId: "project",
        serverId: "target",
        serviceDeploymentMode: "single",
      });
      expect(request).not.toHaveProperty("serviceIds");
      expect(internal).not.toHaveProperty("strictServiceScope");
      expect(internal).not.toHaveProperty("handoverImages");
      expect(internal.handoverAppImage).toBe(loadedId);
      const snapshot = {
        ...request,
        ...internal,
        framework: "docker",
        workload: "worker",
        source: "git",
        repoUrl: "https://example.test/worker.git",
      } as DeploymentConfigSnapshot;
      expect(pinnedAppImage(snapshot)).toBe(loadedId);
      expect(snapshotNeedsGitSource(snapshot)).toBe(false);
      expect(await resolveServicePipelineMode(project as Project, snapshot)).toMatchObject({
        useSingleAppPipeline: true,
        useServicePipeline: false,
      });
      expect(engine.transition).toHaveBeenCalledWith("run", "verifying");
    },
  );

  it.each([
    { framework: "docker-compose" },
    { framework: "docker", composePath: "deploy/compose.yml" },
  ])("refuses an empty service-first scope before moving data: %j", async (shape) => {
    project = { ...project, ...shape };
    vi.mocked(repos.service.listByProject).mockResolvedValue([]);
    await run({ projectMove: { projectId: "project", intent: "move" } });
    expect(engine.moveData).not.toHaveBeenCalled();
    expect(h.requestBuild).not.toHaveBeenCalled();
    expect(engine.rollback).toHaveBeenCalled();
  });

  it("does not turn disabled service rows into a full application deployment", async () => {
    project.framework = "docker";
    vi.mocked(repos.service.listByProject).mockResolvedValue([
      { id: "disabled", name: "frontend", enabled: false },
    ] as never);
    await run({ projectMove: { projectId: "project", intent: "move" } });
    expect(engine.moveData).not.toHaveBeenCalled();
    expect(h.requestBuild).not.toHaveBeenCalled();
  });

  it("does not guess an app image when multiple live workloads have no service rows", async () => {
    project.framework = "docker";
    vi.mocked(repos.service.listByProject).mockResolvedValue([]);
    chosen.push({ ...chosen[0]!, name: "other", containerId: "other-container" });
    await run({ projectMove: { projectId: "project", intent: "move" } });
    expect(engine.moveData).not.toHaveBeenCalled();
    expect(h.requestBuild).not.toHaveBeenCalled();
  });

  it("refuses a single app without a captured image before moving data", async () => {
    project.framework = "docker";
    vi.mocked(repos.service.listByProject).mockResolvedValue([]);
    adopt.handover = {};
    await run({ projectMove: { projectId: "project", intent: "move" } });
    expect(engine.moveData).not.toHaveBeenCalled();
    expect(h.requestBuild).not.toHaveBeenCalled();
    expect(engine.rollback).toHaveBeenCalled();
  });

  it.each(["volume", "bind"] as const)(
    "refuses a single app with a %s mount instead of skipping its data",
    async (type) => {
      project.framework = "docker";
      vi.mocked(repos.service.listByProject).mockResolvedValue([]);
      chosen[0]!.volumes = [
        {
          type,
          source: type === "volume" ? "app-data" : "/srv/app-data",
          target: "/data",
          rw: true,
        },
      ];
      await run({ projectMove: { projectId: "project", intent: "move" } });
      expect(engine.moveData).not.toHaveBeenCalled();
      expect(h.requestBuild).not.toHaveBeenCalled();
      expect(engine.rollback).toHaveBeenCalledWith(
        expect.anything(),
        "run",
        expect.anything(),
        expect.anything(),
        undefined,
        undefined,
        expect.stringContaining("mounted data"),
      );
    },
  );

  it("keeps an exclusive nonempty service scope when another container is reused", async () => {
    const reused = { ...chosen[0]!, name: "db", containerId: "reused-container" };
    chosen.push(reused);
    attachChosen.push(reused);
    imageRefs.clear();
    vi.mocked(repos.service.listByProject).mockResolvedValue([
      { id: "moved", name: "frontend", enabled: true },
      { id: "reused", name: "db", enabled: true },
    ] as never);
    await run({ sourceServerId: "target" });
    expect(engine.rollback).not.toHaveBeenCalled();
    expect(h.requestBuild.mock.calls[0]?.[1]).toMatchObject({
      serviceDeploymentMode: "services",
      serviceIds: ["moved"],
    });
    expect(h.requestBuild.mock.calls[0]?.[2]).toMatchObject({ strictServiceScope: true });
    expect(h.requestBuild.mock.calls[0]?.[2]).not.toHaveProperty("handoverAppImage");
  });
});
