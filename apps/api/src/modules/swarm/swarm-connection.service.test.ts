import { describe, expect, it, vi } from "vitest";
import type { SwarmDiscoverySnapshot, SwarmManagerInfo } from "@repo/adapters";
import type { SwarmStack } from "@repo/db";
import { AppError } from "@repo/core";
import { createSwarmConnectionService } from "./swarm-connection.service";

const manager: SwarmManagerInfo = {
  engineVersion: "29.0.0",
  apiVersion: "1.52",
  localNodeState: "active",
  controlAvailable: true,
  clusterId: "cluster-a",
  nodeId: "node-b",
  nodeAddress: "10.0.0.2",
  managerAddress: "10.0.0.2:2377",
};

const stack = {
  id: "swarm-blog",
  projectId: "project-blog",
  organizationId: "org-a",
  managerServerId: "server-a",
  clusterId: "cluster-a",
  stackName: "blog",
  lastObservedAt: new Date("2026-07-30T00:00:00.000Z"),
  driftStatus: "unreachable",
  driftDetails: { summary: "The former manager could not be reached." },
} as unknown as SwarmStack;

const servers = [
  { id: "server-a", name: "former manager", sshHost: "10.0.0.1", sshPort: 22, isLocal: false },
  { id: "server-b", name: "manager two", sshHost: "10.0.0.2", sshPort: 2222, isLocal: false },
  { id: "server-c", name: "other cluster", sshHost: "10.0.0.3", sshPort: 22, isLocal: false },
];

function snapshot(): SwarmDiscoverySnapshot {
  return {
    manager,
    nodes: [{
      id: "node-b",
      hostname: "manager-two",
      status: "Ready",
      availability: "Active",
      managerStatus: "Leader",
      engineVersion: "29.0.0",
      labels: { region: "us-east", tier: "control" },
    }],
    stacks: [],
    services: [],
    tasks: [],
    networks: [],
    volumes: [],
    configs: [],
    secrets: [],
    diagnostics: [],
    observedAt: "2026-07-30T00:00:00.000Z",
  };
}

function fixture(options: {
  oldManagerUnavailable?: boolean;
  selectedManager?: SwarmManagerInfo;
  candidateHasManager?: boolean;
} = {}) {
  let current = { ...stack };
  const updateStack = vi.fn(async (_id: string, _org: string, patch: { managerServerId: string }) => {
    current = { ...current, ...patch };
    return current;
  });
  const resolvePlatform = vi.fn(async (serverId: string) => {
    if (serverId === "server-a" && options.oldManagerUnavailable) {
      throw new AppError("The former manager is unreachable.", 503, "SWARM_MANAGER_UNAVAILABLE");
    }
    if (serverId === "server-c") {
      return {
        stackRuntime: {
          probe: async () => ({ ...manager, clusterId: "cluster-c" }),
          discover: async () => snapshot(),
        },
      };
    }
    if (options.candidateHasManager === false) return { stackRuntime: null };
    const selected = options.selectedManager ?? manager;
    return {
      stackRuntime: {
        probe: async () => selected,
        discover: async () => snapshot(),
      },
    };
  });
  return {
    updateStack,
    resolvePlatform,
    service: createSwarmConnectionService({
      featureEnabled: () => true,
      getStack: async () => current,
      getServer: async (serverId, organizationId) =>
        organizationId === "org-a" ? servers.find((server) => server.id === serverId) : undefined,
      listServers: async () => servers,
      resolvePlatform: resolvePlatform as never,
      updateStack,
    }),
  };
}

describe("Swarm manager connection", () => {
  it("reports the configured endpoint, current manager health, and read-only node labels", async () => {
    const test = fixture();
    const result = await test.service.status("project-blog", "org-a");

    expect(result).toMatchObject({
      expectedClusterId: "cluster-a",
      manager: {
        health: "healthy",
        managerState: "active-manager",
        controlAvailable: true,
        clusterId: "cluster-a",
        lastSuccessfulProbeAt: "2026-07-30T00:00:00.000Z",
        server: { endpoint: "10.0.0.1:22" },
      },
    });
    expect(result.manager.nodes).toEqual([
      expect.objectContaining({ hostname: "manager-two", availability: "Active", labels: { region: "us-east", tier: "control" } }),
    ]);
  });

  it("rebinds only after proving another manager reaches the same cluster", async () => {
    const test = fixture({ oldManagerUnavailable: true });

    await expect(test.service.status("project-blog", "org-a")).resolves.toMatchObject({
      manager: { health: "unreachable" },
    });
    await expect(test.service.rebind({
      projectId: "project-blog",
      organizationId: "org-a",
      serverId: "server-b",
    })).resolves.toMatchObject({
      managerServerId: "server-b",
      clusterId: "cluster-a",
      endpoint: "10.0.0.2:2222",
    });
    await expect(test.service.status("project-blog", "org-a")).resolves.toMatchObject({
      manager: { health: "healthy", server: { id: "server-b" } },
    });
    expect(test.updateStack).toHaveBeenCalledWith("swarm-blog", "org-a", { managerServerId: "server-b" });
  });

  it("rejects a manager in another cluster before changing the binding", async () => {
    const test = fixture();
    await expect(test.service.rebind({
      projectId: "project-blog",
      organizationId: "org-a",
      serverId: "server-c",
    })).rejects.toMatchObject({ code: "SWARM_CLUSTER_MISMATCH" });
    expect(test.updateStack).not.toHaveBeenCalled();
  });

  it("rejects a worker/non-manager candidate and cross-organization server IDs", async () => {
    const worker = fixture({ candidateHasManager: false });
    await expect(worker.service.rebind({
      projectId: "project-blog",
      organizationId: "org-a",
      serverId: "server-b",
    })).rejects.toMatchObject({ code: "SWARM_MANAGER_REQUIRED" });
    expect(worker.updateStack).not.toHaveBeenCalled();

    const test = fixture();
    await expect(test.service.rebind({
      projectId: "project-blog",
      organizationId: "org-b",
      serverId: "server-b",
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(test.updateStack).not.toHaveBeenCalled();
  });
});
