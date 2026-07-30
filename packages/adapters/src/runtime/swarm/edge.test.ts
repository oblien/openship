import { describe, expect, it, vi } from "vitest";
import type { SwarmDiscoverySnapshot } from "./types";
import {
  buildSwarmEdgeCreateCommand,
  SWARM_EDGE_INGRESS_LABEL,
  SWARM_EDGE_NETWORK_NAME,
  SWARM_EDGE_SERVICE_NAME,
  SwarmEdgeManager,
} from "./edge";

function snapshot(overrides: Partial<SwarmDiscoverySnapshot> = {}): SwarmDiscoverySnapshot {
  return {
    manager: { engineVersion: "29", apiVersion: "1.52", localNodeState: "active", controlAvailable: true, clusterId: "cluster-a", nodeId: "manager", nodeAddress: null, managerAddress: null },
    nodes: [{ id: "node-ingress", hostname: "ingress", status: "ready", availability: "active", managerStatus: "leader", engineVersion: "29", labels: { [SWARM_EDGE_INGRESS_LABEL]: "true" } }],
    stacks: [],
    services: [{ id: "edge-service", name: SWARM_EDGE_SERVICE_NAME, sourceServiceName: SWARM_EDGE_SERVICE_NAME, stackName: null, specVersion: 1, mode: "replicated", desiredReplicas: 1, image: "registry/edge@sha256:abc", labels: { "com.openship.edge": "swarm" }, endpointMode: "vip", placement: null, resources: null, updateConfig: null, rollbackConfig: null, restartPolicy: null, networks: [SWARM_EDGE_NETWORK_NAME], configs: [], secrets: [], publishedPorts: [{ target: 80, published: 80, protocol: "tcp", mode: "host" }, { target: 443, published: 443, protocol: "tcp", mode: "host" }], updateState: null, updateMessage: null }],
    tasks: [{ id: "edge-task-new", serviceId: "edge-service", serviceName: SWARM_EDGE_SERVICE_NAME, slot: 1, nodeId: "node-ingress", nodeName: "ingress", desiredState: "Running", currentState: "Running", error: null, image: "registry/edge@sha256:abc", updatedAt: null, observedAt: "2026-07-30T00:00:00.000Z" }],
    networks: [], volumes: [], configs: [], secrets: [], diagnostics: [], observedAt: "2026-07-30T00:00:00.000Z",
    ...overrides,
  };
}

describe("SwarmEdgeManager", () => {
  it("creates a labelled overlay and one host-port edge pinned to a deliberate ingress node", async () => {
    const exec = vi.fn(async (command: string) => {
      if (command.includes("network inspect")) return "";
      if (command.includes("service inspect")) return "";
      if (command.includes("docker service create")) return "edgecreated123";
      return "";
    });
    const discover = vi.fn().mockResolvedValue(snapshot());
    const edge = new SwarmEdgeManager({ probe: vi.fn(), discover }, { exec });

    await expect(edge.ensure({ image: "registry/edge:1.0.0" })).resolves.toMatchObject({
      serviceId: "edge-service", taskIds: ["edge-task-new"], nodeIds: ["node-ingress"],
    });
    expect(exec.mock.calls.map(([command]) => command)).toEqual(expect.arrayContaining([
      expect.stringContaining("docker network create --driver overlay --attachable=false"),
      expect.stringContaining("docker service create"),
      expect.stringContaining("published=80,target=80,protocol=tcp,mode=host"),
      expect.stringContaining("node.labels.openship.edge.ingress == true"),
    ]));
  });

  it("refuses to replace a foreign router service or proceed without an ingress node", async () => {
    const noNode = snapshot({ nodes: [] });
    const first = new SwarmEdgeManager({ probe: vi.fn(), discover: vi.fn().mockResolvedValue(noNode) }, { exec: vi.fn() });
    await expect(first.ensure({ image: "registry/edge:1" })).rejects.toThrow(/Label one deliberate ingress node/);

    const foreign = JSON.stringify({ Spec: { Labels: { "traefik.enable": "true" }, TaskTemplate: { Placement: { Constraints: [`node.labels.${SWARM_EDGE_INGRESS_LABEL} == true`] } }, EndpointSpec: { Ports: [{ PublishedPort: 80, TargetPort: 80, PublishMode: "host" }, { PublishedPort: 443, TargetPort: 443, PublishMode: "host" }] } } });
    const second = new SwarmEdgeManager({ probe: vi.fn(), discover: vi.fn().mockResolvedValue(snapshot()) }, {
      exec: vi.fn(async (command: string) => command.includes("network inspect") ? JSON.stringify({ Name: SWARM_EDGE_NETWORK_NAME, Driver: "overlay", Scope: "swarm", Labels: { "com.openship.edge.network": "true" } }) : command.includes("service inspect") ? foreign : ""),
    });
    await expect(second.ensure({ image: "registry/edge:1" })).rejects.toThrow(/will not replace a router service automatically/);
  });

  it("requires a future explicit cutover when another Swarm service owns 80 or 443", async () => {
    const router = snapshot({ services: [{ ...snapshot().services[0]!, id: "traefik", name: "router_traefik", sourceServiceName: "traefik", labels: { "traefik.enable": "true" } }] });
    const exec = vi.fn();
    const edge = new SwarmEdgeManager({ probe: vi.fn(), discover: vi.fn().mockResolvedValue(router) }, { exec });
    await expect(edge.ensure({ image: "registry/edge:1" })).rejects.toThrow(/will not take over a Swarm router/);
    expect(exec).not.toHaveBeenCalled();
  });

  it("uses manager discovery to locate the replacement task after rescheduling", async () => {
    const afterReschedule = snapshot({ tasks: [{ ...snapshot().tasks[0]!, id: "edge-task-replaced", nodeId: "node-ingress" }] });
    const edge = new SwarmEdgeManager({ probe: vi.fn(), discover: vi.fn().mockResolvedValue(afterReschedule) }, { exec: vi.fn() });
    await expect(edge.status({ image: "registry/edge:1" })).resolves.toMatchObject({ taskIds: ["edge-task-replaced"] });
  });

  it("acknowledges a manager-accepted service before the scheduler creates its first task", async () => {
    const before = snapshot({ services: [], tasks: [] });
    const exec = vi.fn(async (command: string) => command.includes("docker service create") ? "edgecreated123" : "");
    const edge = new SwarmEdgeManager({ probe: vi.fn(), discover: vi.fn().mockResolvedValue(before) }, { exec });
    await expect(edge.ensure({ image: "registry/edge:1" })).resolves.toMatchObject({
      serviceId: "edgecreated123", taskIds: [], nodeIds: [],
    });
  });
});

describe("buildSwarmEdgeCreateCommand", () => {
  it("uses named persistent volumes and never exposes application ports", () => {
    const command = buildSwarmEdgeCreateCommand({ image: "registry/edge:1", ingressLabel: SWARM_EDGE_INGRESS_LABEL });
    expect(command).toContain("openship-edge-certs");
    expect(command).toContain("--publish published=443,target=443,protocol=tcp,mode=host");
    expect(command).not.toContain("target=3000");
  });
});
