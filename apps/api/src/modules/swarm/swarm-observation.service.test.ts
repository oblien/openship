import { describe, expect, it, vi } from "vitest";
import type { SwarmDiscoverySnapshot } from "@repo/adapters";
import type { SwarmStack } from "@repo/db";
import { createSwarmObservationService } from "./swarm-observation.service";

function snapshot(clusterId = "cluster-a"): SwarmDiscoverySnapshot {
  return {
    manager: {
      engineVersion: null,
      apiVersion: null,
      localNodeState: "active",
      controlAvailable: true,
      clusterId,
      nodeId: "node",
      nodeAddress: null,
      managerAddress: null,
    },
    nodes: [],
    stacks: [{ name: "blog", serviceIds: ["svc"], serviceNames: ["web"] }],
    services: [
      {
        id: "svc",
        name: "blog_web",
        sourceServiceName: "web",
        stackName: "blog",
        specVersion: 2,
        mode: "replicated",
        desiredReplicas: 2,
        image: "nginx@sha256:new",
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
        updateState: null,
        updateMessage: null,
      },
    ],
    tasks: [],
    networks: [],
    volumes: [],
    configs: [],
    secrets: [],
    diagnostics: [],
    observedAt: "2026-07-30T00:00:00.000Z",
  };
}

function fixture(discovery = snapshot()) {
  const stack = {
    id: "swarm-blog",
    projectId: "proj-blog",
    organizationId: "org-a",
    managerServerId: "server-a",
    clusterId: "cluster-a",
    stackName: "blog",
    managementMode: "observe",
    sourceKind: "adopted",
    sourceStatus: "missing",
    driftStatus: "unknown",
    driftDetails: {},
    lastObservedDigest: "sha256:old",
    lastObservedAt: null,
  } as unknown as SwarmStack;
  const updateStack = vi.fn().mockResolvedValue(undefined);
  const syncProjections = vi.fn().mockResolvedValue([]);
  return {
    stack,
    updateStack,
    syncProjections,
    service: createSwarmObservationService({
      featureEnabled: () => true,
      getStack: async () => stack,
      resolvePlatform: async () => ({ stackRuntime: { discover: async () => discovery } }) as never,
      updateStack,
      syncProjections,
      now: () => new Date("2026-07-30T00:00:00.000Z"),
    }),
  };
}

describe("Swarm observation refresh", () => {
  it("records redacted external drift and refreshes service projections without a stack operation", async () => {
    const test = fixture();
    const refreshed = await test.service.refresh("proj-blog", "org-a");
    expect(refreshed).toMatchObject({ status: "drifted", changed: true });
    expect(refreshed.digest).toMatch(/^sha256:/);
    expect(test.updateStack).toHaveBeenCalledWith(
      "swarm-blog",
      "org-a",
      expect.objectContaining({
        driftStatus: "drifted",
        driftDetails: { summary: expect.any(String), serviceNames: ["web"] },
      }),
    );
    expect(test.syncProjections).toHaveBeenCalledWith("proj-blog", [
      expect.objectContaining({ sourceServiceName: "web", observedServiceId: "svc" }),
    ]);
  });

  it("surfaces a manager cluster identity change instead of treating it as ordinary drift", async () => {
    const test = fixture(snapshot("cluster-replaced"));
    await expect(test.service.refresh("proj-blog", "org-a")).rejects.toMatchObject({
      code: "SWARM_CLUSTER_MISMATCH",
      statusCode: 409,
    });
    expect(test.updateStack).not.toHaveBeenCalled();
  });

  it("returns safe source and drift status for the observe-mode project", async () => {
    const test = fixture();
    await expect(test.service.status("proj-blog", "org-a")).resolves.toMatchObject({
      stackName: "blog",
      managerServerId: "server-a",
      clusterId: "cluster-a",
      managementMode: "observe",
      source: { kind: "adopted", status: "missing", deployable: false },
      drift: { status: "unknown" },
    });
  });

  it("batches periodic managed-stack refreshes through one manager discovery", async () => {
    const first = {
      ...fixture().stack,
      managementMode: "managed",
      lastAppliedRevisionId: null,
    } as SwarmStack;
    const second = {
      ...first,
      id: "swarm-docs",
      projectId: "proj-docs",
      stackName: "docs",
    } as SwarmStack;
    const resolvePlatform = vi.fn(
      async () => ({ stackRuntime: { discover: async () => snapshot() } }) as never,
    );
    const updateStack = vi.fn().mockResolvedValue(undefined);
    const syncProjections = vi.fn().mockResolvedValue([]);
    const service = createSwarmObservationService({
      featureEnabled: () => true,
      listManaged: async () => [first, second],
      resolvePlatform,
      updateStack,
      syncProjections,
      now: () => new Date("2026-07-30T00:00:00.000Z"),
    });

    await expect(service.refreshManaged()).resolves.toMatchObject({ refreshed: 2, deferred: 0 });
    expect(resolvePlatform).toHaveBeenCalledTimes(1);
    expect(syncProjections).toHaveBeenCalledTimes(2);
  });

  it("backs off an unreachable manager group instead of retrying every bound stack", async () => {
    const first = { ...fixture().stack, managementMode: "managed" } as SwarmStack;
    const second = {
      ...first,
      id: "swarm-docs",
      projectId: "proj-docs",
      stackName: "docs",
    } as SwarmStack;
    const resolvePlatform = vi.fn(async () => {
      throw new Error("connection lost");
    });
    const updateStack = vi.fn().mockResolvedValue(undefined);
    const service = createSwarmObservationService({
      featureEnabled: () => true,
      listManaged: async () => [first, second],
      resolvePlatform,
      updateStack,
      now: () => new Date("2026-07-30T00:00:00.000Z"),
    });

    await expect(service.refreshManaged()).resolves.toMatchObject({ unreachable: 2, deferred: 0 });
    await expect(service.refreshManaged()).resolves.toMatchObject({ unreachable: 0, deferred: 2 });
    expect(resolvePlatform).toHaveBeenCalledTimes(1);
    expect(updateStack).toHaveBeenCalledTimes(2);
  });
});
