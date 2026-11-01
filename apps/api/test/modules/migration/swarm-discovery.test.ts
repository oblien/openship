import { beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  runtime: vi.fn(),
  prune: vi.fn(),
  source: { purpose: "deployment" },
}));
vi.mock("@repo/platform/engine/modules/migration/migration-access", () => ({
  requireMigrationServer: async () => h.source,
}));
vi.mock("@repo/platform/engine/modules/migration/migration-runtime", () => ({
  createMigrationDockerRuntime: h.runtime,
  withMigrationExecution: async (_id: string, _org: string, run: (exec: unknown) => unknown) =>
    run({}),
}));
vi.mock("@repo/platform/engine/lib/openship-manifest-sync", () => ({
  pruneOrphanManifestArtifacts: h.prune,
}));
vi.mock("@repo/platform/engine/lib/openship-manifest", () => ({
  readManifest: vi.fn(),
  projectSnapshotExists: vi.fn(),
}));
vi.mock("@repo/platform/engine/modules/migration/proxy-route-scan", () => ({
  scanProxyRoutes: async () => ({ routesByPort: new Map(), warnings: [] }),
}));
vi.mock("@repo/db", () => ({
  repos: {
    server: { get: async () => ({ isLocal: false }) },
    project: { listByOrganization: async () => ({ rows: [] }) },
  },
}));
import { discoverServerStack } from "@repo/platform/engine/modules/migration/docker-inspect.service";

beforeEach(() => {
  vi.clearAllMocks();
  h.prune.mockResolvedValue(undefined);
  h.source.purpose = "deployment";
});
it.each([false, true])(
  "excludes scheduler tasks before inspecting secrets, including flat import=%s, while retaining recovery artifacts",
  async (flatDocker) => {
    const detail = {
      id: "standalone",
      name: "cache",
      image: "redis:7",
      imageId: "sha256:a",
      state: "running",
      env: [],
      labels: {},
      ports: [],
      mounts: [],
      networks: [],
    };
    const inspectContainer = vi.fn(async () => detail),
      dispose = vi.fn();
    h.runtime.mockResolvedValue({
      assertReachable: async () => {},
      dispose,
      inspectContainer,
      listAllContainers: async () => [
        detail,
        { id: "swarm-a", labels: { "com.docker.swarm.service.name": "shop_web" } },
        {
          id: "swarm-b",
          labels: { "com.docker.swarm.task.id": "task", "openship.project": "proj_swarm" },
        },
      ],
      listAllVolumes: async () => [],
      listAllNetworks: async () => [],
      inspectImageEnv: async () => [],
      inspectImageCmd: async () => [],
    });
    const progress = vi.fn();
    const result = await discoverServerStack("server-a", "org-a", progress, { flatDocker });
    expect(result.services.map((service) => service.containerId)).toEqual(["standalone"]);
    expect(result.openshipProjects).toEqual([]);
    expect(inspectContainer.mock.calls).toEqual([["standalone"]]);
    expect(h.prune).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ liveProjectIds: new Set(["proj_swarm"]) }),
    );
    expect(progress.mock.calls.some(([message]) => message.includes("Excluding 2 Swarm"))).toBe(
      true,
    );
    expect(dispose).toHaveBeenCalledOnce();
  },
);
