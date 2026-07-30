import { describe, expect, it } from "vitest";
import type { SwarmDiscoverySnapshot, SwarmServiceState } from "@repo/adapters";
import { buildSwarmDiscoveryView } from "./swarm-discovery-view";

function service(overrides: Partial<SwarmServiceState>): SwarmServiceState {
  return {
    id: "service", name: "blog_web", sourceServiceName: "web", stackName: "blog", specVersion: 1,
    mode: "replicated", desiredReplicas: 1, image: "nginx", labels: {}, endpointMode: null,
    placement: null, resources: null, updateConfig: null, rollbackConfig: null, restartPolicy: null,
    networks: [], configs: [], secrets: [], publishedPorts: [], updateState: null, updateMessage: null,
    ...overrides,
  };
}

describe("Swarm discovery view", () => {
  it("groups Portainer stack services once, retains standalone services, and excludes marked control-plane services", () => {
    const snapshot: SwarmDiscoverySnapshot = {
      manager: { engineVersion: null, apiVersion: null, localNodeState: "active", controlAvailable: true, clusterId: "cluster", nodeId: "node", nodeAddress: null, managerAddress: null },
      nodes: [{ id: "node", hostname: "manager", status: "Ready", availability: "Active", managerStatus: "Leader", engineVersion: null, labels: {} }],
      stacks: [{ name: "blog", serviceIds: ["web", "api"], serviceNames: ["web", "api"] }],
      services: [
        service({ id: "web", name: "blog_web", sourceServiceName: "web", labels: { "io.portainer.stack.id": "42" }, networks: ["frontend"], configs: ["app-config"], secrets: ["db-password"] }),
        service({ id: "api", name: "blog_api", sourceServiceName: "api", labels: { "io.portainer.stack.id": "42" } }),
        service({ id: "single", name: "single", sourceServiceName: "single", stackName: null }),
        service({ id: "openship", name: "openship", sourceServiceName: "openship", stackName: null, labels: { "com.openship.control-plane": "true" } }),
      ],
      tasks: [
        { id: "task-web", serviceId: "web", serviceName: "blog_web", slot: 1, nodeId: "node", nodeName: "manager", desiredState: "Running", currentState: "Running", error: null, image: "nginx", updatedAt: null, observedAt: "2026-07-30T00:00:00.000Z" },
        { id: "task-api", serviceId: "api", serviceName: "blog_api", slot: 1, nodeId: "node", nodeName: "manager", desiredState: "Running", currentState: "Running", error: null, image: "nginx", updatedAt: null, observedAt: "2026-07-30T00:00:00.000Z" },
      ],
      networks: [], volumes: [], configs: [], secrets: [], diagnostics: [], observedAt: "2026-07-30T00:00:00.000Z",
    };
    const view = buildSwarmDiscoveryView(snapshot);
    expect(view.stacks).toHaveLength(1);
    expect(view.stacks[0]).toMatchObject({
      name: "blog", portainerManaged: true, networks: ["frontend"], configs: ["app-config"], secrets: ["db-password"],
    });
    expect(view.stacks[0]?.services.map((entry) => entry.sourceServiceName)).toEqual(["api", "web"]);
    expect(view.standaloneServices.map((entry) => entry.sourceServiceName)).toEqual(["single"]);
  });
});
