import { describe, expect, it, vi } from "vitest";
import type { SwarmDiscoverySnapshot } from "@repo/adapters";
import { createSwarmEdgeService } from "./swarm-edge.service";

const snapshot: SwarmDiscoverySnapshot = {
  manager: { engineVersion: "29", apiVersion: "1.52", localNodeState: "active", controlAvailable: true, clusterId: "cluster-a", nodeId: "node-a", nodeAddress: null, managerAddress: null },
  nodes: [{ id: "node-a", hostname: "ingress", status: "ready", availability: "active", managerStatus: "leader", engineVersion: "29", labels: { "openship.edge.ingress": "true" } }],
  stacks: [], services: [], tasks: [], networks: [], volumes: [], configs: [], secrets: [], diagnostics: [], observedAt: "2026-07-30T00:00:00.000Z",
};

describe("Swarm Edge service", () => {
  it("uses the organization-scoped manager and keeps enablement separate from stack deploys", async () => {
    const exec = vi.fn(async (command: string) => command.includes("docker service create") ? "edgecreated123" : "");
    const resolvePlatform = vi.fn().mockResolvedValue({
      executor: { exec },
      stackRuntime: { probe: vi.fn(), discover: vi.fn().mockResolvedValue(snapshot) },
    });
    const edge = createSwarmEdgeService({
      featureEnabled: () => true,
      getServer: async (id) => ({ id }) as never,
      resolvePlatform,
    });

    await expect(edge.ensure("server-a", "org-a")).resolves.toMatchObject({ serviceId: "edgecreated123", taskIds: [] });
    expect(resolvePlatform).toHaveBeenCalledWith("server", "docker", "server-a", "org-a", "swarm");
    expect(exec.mock.calls.some(([command]) => command.includes("docker service create"))).toBe(true);
  });

  it("hides the mutable edge path when Swarm is disabled", async () => {
    const edge = createSwarmEdgeService({ featureEnabled: () => false });
    await expect(edge.status("server-a", "org-a")).rejects.toMatchObject({ statusCode: 404, code: "SWARM_FEATURE_DISABLED" });
  });
});
