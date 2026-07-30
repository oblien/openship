import { describe, expect, it } from "vitest";
import { deriveSwarmServiceHealth, deriveSwarmStackHealth } from "./health";
import type { SwarmServiceState, SwarmTaskState } from "./types";

const service: SwarmServiceState = {
  id: "service-1", name: "blog_web", sourceServiceName: "web", stackName: "blog", specVersion: 2,
  mode: "replicated", desiredReplicas: 1, image: "nginx:alpine", labels: {}, endpointMode: null,
  placement: null, resources: null, updateConfig: null, rollbackConfig: null, restartPolicy: null,
  networks: [], configs: [], secrets: [], publishedPorts: [], updateState: null, updateMessage: null,
};
const task = (overrides: Partial<SwarmTaskState>): SwarmTaskState => ({
  id: "task-1", serviceId: "service-1", serviceName: "blog_web", slot: 1, nodeId: null, nodeName: null,
  desiredState: "Running", currentState: "Running", error: null, image: null,
  updatedAt: "2026-07-30T00:01:00.000Z", observedAt: "2026-07-30T00:01:00.000Z", ...overrides,
});

describe("Swarm service and stack health", () => {
  it("ignores an old failed task after its slot recovers", () => {
    const health = deriveSwarmServiceHealth(service, [
      task({ id: "old", currentState: "Rejected", error: "image not found", updatedAt: "2026-07-30T00:00:00.000Z" }),
      task({ id: "current", currentState: "Running", updatedAt: "2026-07-30T00:01:00.000Z" }),
    ]);
    expect(health).toMatchObject({ state: "converged", running: 1, failed: 0 });
  });

  it("reports rolling updates, scheduler rejection, global gaps, and intentional zero scale", () => {
    expect(deriveSwarmServiceHealth({ ...service, updateState: "updating" }, [task({ currentState: "Preparing" })]).state).toBe("updating");
    expect(deriveSwarmServiceHealth(service, [task({ currentState: "Rejected", error: "no suitable node" })]).state).toBe("failed");
    expect(deriveSwarmServiceHealth({ ...service, mode: "global", desiredReplicas: null }, [task({ slot: null })], { eligibleNodeCount: 2 }).state).toBe("degraded");
    expect(deriveSwarmServiceHealth({ ...service, desiredReplicas: 0 }, []).state).toBe("scaled-to-zero");
  });

  it("derives aggregate stack states without treating manager loss as a scheduler failure", () => {
    expect(deriveSwarmStackHealth({ stackName: "blog", services: [service], tasks: [task({ currentState: "Rejected" })] }).state).toBe("failed");
    expect(deriveSwarmStackHealth({ stackName: "blog", services: [service], tasks: [], unreachable: true }).state).toBe("unreachable");
  });
});
