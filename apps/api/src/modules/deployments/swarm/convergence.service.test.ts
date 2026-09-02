import { describe, expect, it, vi } from "vitest";
import type { SwarmDiscoverySnapshot } from "@repo/adapters";
import { createSwarmConvergenceService } from "./convergence.service";

function snapshot(state: "running" | "preparing" | "rejected" = "running"): SwarmDiscoverySnapshot {
  return {
    manager: {
      engineVersion: null,
      apiVersion: null,
      localNodeState: "active",
      controlAvailable: true,
      clusterId: "cluster-a",
      nodeId: "node-a",
      nodeAddress: null,
      managerAddress: null,
    },
    nodes: [
      {
        id: "node-a",
        hostname: "manager",
        status: "ready",
        availability: "active",
        managerStatus: "leader",
        engineVersion: null,
        labels: {},
      },
    ],
    stacks: [{ name: "blog", serviceIds: ["svc-web"], serviceNames: ["web"] }],
    services: [
      {
        id: "svc-web",
        name: "blog_web",
        sourceServiceName: "web",
        stackName: "blog",
        specVersion: 1,
        mode: "replicated",
        desiredReplicas: 1,
        image: "nginx",
        labels: {},
        endpointMode: null,
        placement: null,
        resources: null,
        updateConfig: null,
        rollbackConfig: null,
        restartPolicy: null,
        networks: [],
        configs: [],
        secrets: [],
        publishedPorts: [],
        updateState: state === "preparing" ? "updating" : null,
        updateMessage: null,
      },
    ],
    tasks: [
      {
        id: `task-${state}`,
        serviceId: "svc-web",
        serviceName: "blog_web",
        slot: 1,
        nodeId: "node-a",
        nodeName: "manager",
        desiredState: "Running",
        currentState:
          state === "running"
            ? "Running 1 second ago"
            : state === "preparing"
              ? "Preparing"
              : "Rejected",
        error: state === "rejected" ? "no suitable node" : null,
        image: "nginx",
        updatedAt: "2026-07-30T00:00:00.000Z",
        observedAt: "2026-07-30T00:00:00.000Z",
      },
    ],
    networks: [],
    volumes: [],
    configs: [],
    secrets: [],
    diagnostics: [],
    observedAt: "2026-07-30T00:00:00.000Z",
  };
}

const logger = { log: vi.fn() };

describe("Swarm convergence polling", () => {
  it("waits through scheduler preparation and returns structured ready health", async () => {
    let now = 0;
    const discover = vi
      .fn()
      .mockResolvedValueOnce(snapshot("preparing"))
      .mockResolvedValueOnce(snapshot("running"));
    const service = createSwarmConvergenceService({
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
    });
    await expect(
      service.wait({
        runtime: { discover },
        stackName: "blog",
        logger,
        timeoutMs: 5_000,
        pollMs: 100,
      }),
    ).resolves.toMatchObject({ status: "ready", attempts: 2, health: { state: "ready" } });
  });

  it("returns a failure immediately for a rejected current task", async () => {
    const service = createSwarmConvergenceService();
    await expect(
      service.wait({
        runtime: { discover: async () => snapshot("rejected") },
        stackName: "blog",
        logger,
        timeoutMs: 0,
      }),
    ).resolves.toMatchObject({ status: "failed", health: { state: "failed" } });
  });

  it("preserves an indeterminate outcome when manager access disappears", async () => {
    const service = createSwarmConvergenceService();
    await expect(
      service.wait({
        runtime: {
          discover: async () => {
            throw new Error("connection lost");
          },
        },
        stackName: "blog",
        logger,
        timeoutMs: 0,
      }),
    ).resolves.toMatchObject({ status: "unreachable", snapshot: null, health: null, attempts: 1 });
  });
});
