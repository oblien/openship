import { describe, expect, it, vi } from "vitest";
import type { Project, Server } from "@repo/db";
import {
  AUTOMATIC_BUILD_CACHE_KEEP_BYTES,
  clearProjectBuildCache,
  collectBuildCacheTargets,
  runBuildCacheGcSweep,
  type BuildCacheGcDependencies,
} from "@repo/platform/engine/modules/deployments/build-cache-gc";

const project = (overrides: Record<string, unknown> = {}) =>
  ({
    id: "proj_1",
    organizationId: "org_1",
    cloudWorkspaceId: null,
    serverId: "srv_1",
    activeDeploymentId: null,
    ...overrides,
  }) as Project;

const server = (overrides: Record<string, unknown> = {}) =>
  ({
    id: "srv_1",
    organizationId: "org_1",
    isLocal: false,
    ...overrides,
  }) as Server;

function dependencies(overrides: Partial<BuildCacheGcDependencies> = {}): BuildCacheGcDependencies {
  return {
    listServers: async () => [],
    hasLocalDockerRuntime: () => true,
    findServer: async (serverId) => ({ id: serverId, isLocal: false }),
    resolveProjectTarget: async (p) => ({
      deployTarget: p.serverId ? "server" : "local",
      serverId: p.serverId,
    }),
    createRuntime: async () => ({
      pruneBuildCache: async () => ({ cachesDeleted: [], spaceReclaimed: 0 }),
    }),
    runLocked: async (_key, run) => run(),
    ...overrides,
  };
}

describe("collectBuildCacheTargets", () => {
  it("deduplicates local aliases and retains every owned remote server", () => {
    expect(
      collectBuildCacheTargets(
        [
          server({ id: "local-a", isLocal: true }),
          server({ id: "local-b", isLocal: true }),
          server({ id: "remote-a" }),
          server({ id: "legacy", organizationId: null }),
        ],
        true,
      ).map((target) => target.key),
    ).toEqual(["local", "server:remote-a"]);
  });

  it("keeps the local Docker daemon eligible after its last project is deleted", () => {
    expect(collectBuildCacheTargets([], true)).toEqual([
      { key: "local", serverId: null, organizationId: null },
    ]);
  });

  it("does not probe a local bare runtime for Docker cache", () => {
    expect(
      collectBuildCacheTargets(
        [server({ id: "local", isLocal: true }), server({ id: "remote" })],
        false,
      ).map((target) => target.key),
    ).toEqual(["server:remote"]);
  });
});

describe("clearProjectBuildCache", () => {
  it("fully prunes the project's server under the host lock and disposes the runtime", async () => {
    const pruneBuildCache = vi.fn(async () => ({ cachesDeleted: ["cache-1"], spaceReclaimed: 42 }));
    const dispose = vi.fn(async () => {});
    const createRuntime = vi.fn(async () => ({ pruneBuildCache, dispose }));
    const lockedKeys: string[] = [];
    const runLocked: BuildCacheGcDependencies["runLocked"] = async (key, run) => {
      lockedKeys.push(key);
      return run();
    };

    await expect(
      clearProjectBuildCache(project(), dependencies({ createRuntime, runLocked })),
    ).resolves.toEqual({
      cachesDeleted: ["cache-1"],
      spaceReclaimed: 42,
      target: "server",
      serverId: "srv_1",
    });

    expect(lockedKeys).toEqual(["server:srv_1"]);
    expect(createRuntime).toHaveBeenCalledWith({
      key: "server:srv_1",
      serverId: "srv_1",
      organizationId: "org_1",
    });
    expect(pruneBuildCache).toHaveBeenCalledWith({ all: true });
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("refuses a cloud target without contacting a Docker daemon", async () => {
    const createRuntime = vi.fn();
    await expect(
      clearProjectBuildCache(
        project({ cloudWorkspaceId: "ws_1", serverId: null }),
        dependencies({
          resolveProjectTarget: async () => ({ deployTarget: "cloud", serverId: null }),
          createRuntime,
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "BUILD_CACHE_NOT_LOCAL" });
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it("canonicalizes the This Server row to the local-daemon lock", async () => {
    const createRuntime = vi.fn(async () => ({
      pruneBuildCache: async () => ({ cachesDeleted: [], spaceReclaimed: 0 }),
    }));
    const lockedKeys: string[] = [];
    const runLocked: BuildCacheGcDependencies["runLocked"] = async (key, run) => {
      lockedKeys.push(key);
      return run();
    };

    await expect(
      clearProjectBuildCache(
        project({ serverId: "local-row" }),
        dependencies({
          findServer: async () => ({ id: "local-row", isLocal: true }),
          createRuntime,
          runLocked,
        }),
      ),
    ).resolves.toMatchObject({ target: "local", serverId: null });

    expect(lockedKeys).toEqual(["local"]);
    expect(createRuntime).toHaveBeenCalledWith({
      key: "local",
      serverId: null,
      organizationId: "org_1",
    });
  });
});

describe("runBuildCacheGcSweep", () => {
  it("applies the 5 GiB policy once per host and isolates host failures", async () => {
    const pruneByTarget = new Map<string, ReturnType<typeof vi.fn>>();
    const disposed: string[] = [];
    const createRuntime: BuildCacheGcDependencies["createRuntime"] = async (target) => {
      const prune = vi.fn(async () => {
        if (target.key === "server:bad") throw new Error("offline");
        return { cachesDeleted: [`cache-${target.key}`], spaceReclaimed: 1024 };
      });
      pruneByTarget.set(target.key, prune);
      return {
        pruneBuildCache: prune,
        dispose: async () => {
          disposed.push(target.key);
        },
      };
    };

    const summary = await runBuildCacheGcSweep(
      dependencies({
        listServers: async () => [server({ id: "good" }), server({ id: "bad" })],
        createRuntime,
      }),
    );

    expect(summary).toEqual({
      hostsScanned: 3,
      cachesDeleted: 2,
      bytesReclaimed: 2048,
      errors: 1,
    });
    expect(disposed).toEqual(["server:good", "server:bad", "local"]);
    for (const prune of pruneByTarget.values()) {
      expect(prune).toHaveBeenCalledWith({
        all: true,
        keepStorageBytes: AUTOMATIC_BUILD_CACHE_KEEP_BYTES,
      });
    }
  });
});
