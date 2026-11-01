import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { repos } from "@repo/db";

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

import { migrationOrchestrator } from "@repo/platform/engine/modules/migration/migration.orchestrator";
import type { DiscoveredService } from "@repo/platform/engine/modules/migration/docker-reconcile";
import type { StartMigrationInput } from "@repo/platform/engine/modules/migration/migration.orchestrator";
import type { AdoptResult } from "@repo/platform/engine/modules/migration/migrate.service";

// Run the production migration flow; only host/database boundaries and unrelated
// routing work are replaced. The target deployment request is observed directly.
const engine = migrationOrchestrator as unknown as {
  run: (ctx: unknown, id: string, input: StartMigrationInput) => Promise<void>;
  resolveScannedWorkload: () => Promise<unknown>;
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
  vi.spyOn(engine, "resolveScannedWorkload").mockImplementation(async () => ({
    chosen,
    deployChosen: chosen,
    attachChosen: [],
    adopt,
  }));
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
  h.requestBuild.mockResolvedValue({ deployment_id: "target-deployment" });
});
afterEach(() => vi.restoreAllMocks());

const run = () =>
  engine.run({ organizationId: "org" }, "run", {
    organizationId: "org",
    sourceServerId: "source",
    targetServerId: "target",
    projectName: "app",
    serviceNames: ["web"],
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
        handoverAppImage: loadedId,
      }),
    );
    expect(chosen[0]!.image).toBe(sourceImage);
  });

  it("preserves existing handover when an image was not transferred", async () => {
    imageRefs.clear();
    await run();
    expect(engine.rollback).not.toHaveBeenCalled();
    expect(h.requestBuild.mock.calls[0]?.[2]).toMatchObject({
      handoverImages: { frontend: sourceImage },
    });
  });
});
