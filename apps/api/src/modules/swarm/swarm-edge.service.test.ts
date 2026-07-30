import { describe, expect, it, vi } from "vitest";
import type { SwarmDiscoverySnapshot, SwarmServiceState } from "@repo/adapters";
import { createSwarmEdgeService } from "./swarm-edge.service";

const snapshot: SwarmDiscoverySnapshot = {
  manager: { engineVersion: "29", apiVersion: "1.52", localNodeState: "active", controlAvailable: true, clusterId: "cluster-a", nodeId: "node-a", nodeAddress: null, managerAddress: null },
  nodes: [{ id: "node-a", hostname: "ingress", status: "ready", availability: "active", managerStatus: "leader", engineVersion: "29", labels: { "openship.edge.ingress": "true" } }],
  stacks: [], services: [], tasks: [], networks: [], volumes: [], configs: [], secrets: [], diagnostics: [], observedAt: "2026-07-30T00:00:00.000Z",
};

function routerSnapshot(): SwarmDiscoverySnapshot {
  const router: SwarmServiceState = {
    id: "router-service-123",
    name: "legacy_traefik",
    sourceServiceName: "traefik",
    stackName: "legacy",
    specVersion: 7,
    mode: "replicated",
    desiredReplicas: 2,
    image: "traefik:v3",
    labels: { "com.docker.stack.namespace": "legacy" },
    endpointMode: null,
    placement: null,
    resources: null,
    updateConfig: null,
    rollbackConfig: null,
    restartPolicy: null,
    networks: [], configs: [], secrets: [],
    publishedPorts: [
      { target: 80, published: 80, protocol: "tcp", mode: "ingress" },
      { target: 443, published: 443, protocol: "tcp", mode: "ingress" },
    ],
    updateState: null,
    updateMessage: null,
  };
  return { ...snapshot, services: [router] };
}

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

  it("reports a specific Swarm router as a reviewed cutover plan", async () => {
    const exec = vi.fn(async (_command: string) => "");
    const resolvePlatform = vi.fn().mockResolvedValue({
      executor: { exec },
      stackRuntime: { probe: vi.fn(), discover: vi.fn().mockResolvedValue(routerSnapshot()) },
    });
    const edge = createSwarmEdgeService({
      featureEnabled: () => true,
      getServer: async (id) => ({ id }) as never,
      resolvePlatform,
    });

    await expect(edge.cutoverPlan("server-a", "org-a")).resolves.toMatchObject({
      cutover: {
        kind: "swarm-service",
        serviceId: "router-service-123",
        serviceName: "legacy_traefik",
        specVersion: 7,
        replicas: 2,
      },
    });
  });

  it("requires exact router-name confirmation before mutating a cutover", async () => {
    const exec = vi.fn(async (_command: string) => "");
    const resolvePlatform = vi.fn().mockResolvedValue({
      executor: { exec },
      stackRuntime: { probe: vi.fn(), discover: vi.fn().mockResolvedValue(routerSnapshot()) },
    });
    const edge = createSwarmEdgeService({
      featureEnabled: () => true,
      getServer: async (id) => ({ id }) as never,
      resolvePlatform,
    });

    await expect(edge.cutover("server-a", "org-a", {
      serviceId: "router-service-123",
      specVersion: 7,
      confirmedServiceName: "not-the-router",
    })).rejects.toMatchObject({ code: "SWARM_EDGE_CUTOVER_CONFIRMATION_REQUIRED", statusCode: 409 });
    expect(exec.mock.calls.some(([command]) => command.includes("docker service update"))).toBe(false);
  });
});
