import { describe, expect, it, vi } from "vitest";
import type { SwarmDiscoverySnapshot } from "@repo/adapters";
import type { Deployment, Project, SwarmStack, SwarmStackRevision } from "@repo/db";
import { createSwarmDeploymentReconciler } from "./reconcile.service";

const stack = {
  id: "swarm-blog",
  projectId: "project-blog",
  organizationId: "org-a",
  managerServerId: "server-a",
  clusterId: "cluster-a",
  stackName: "blog",
  managementMode: "managed",
  sourceStatus: "valid",
} as SwarmStack;

const revision = {
  id: "revision-1",
  stackId: "swarm-blog",
  renderedDigest: "sha256:rendered",
  applyOutput: {},
  manifest: {
    services: [
      {
        sourceServiceName: "web",
        mode: "replicated",
        replicas: { desired: 1 },
        image: "nginx@sha256:old",
        publishedPorts: [],
        networks: [],
        volumes: [],
        configs: [],
        secrets: [],
        sourceState: "present",
      },
    ],
  },
} as unknown as SwarmStackRevision;

function snapshot(image = "nginx@sha256:old"): SwarmDiscoverySnapshot {
  return {
    manager: {
      engineVersion: "27",
      apiVersion: "1.47",
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
        engineVersion: "27",
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
        specVersion: 3,
        mode: "replicated",
        desiredReplicas: 1,
        image,
        labels: {
          "com.docker.stack.namespace": "blog",
          "com.openship.stack-id": "swarm-blog",
          "com.openship.project-id": "project-blog",
        },
        endpointMode: null,
        placement: null,
        resources: null,
        updateConfig: null,
        rollbackConfig: null,
        restartPolicy: null,
        networks: [],
        volumes: [],
        configs: [],
        secrets: [],
        publishedPorts: [],
        updateState: null,
        updateMessage: null,
      },
    ],
    tasks: [
      {
        id: "task-web",
        serviceId: "svc-web",
        serviceName: "blog_web",
        slot: 1,
        nodeId: "node-a",
        nodeName: "manager",
        desiredState: "Running",
        currentState: "Running",
        error: null,
        image,
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

const deployment = {
  id: "deployment-1",
  projectId: "project-blog",
  organizationId: "org-a",
  createdAt: new Date("2026-07-30T00:00:00.000Z"),
  meta: {},
} as Deployment;
const runtimeRef = {
  kind: "swarm-stack" as const,
  clusterId: "cluster-a",
  managerServerId: "server-a",
  stackName: "blog",
  revisionId: "revision-1",
};

function fixture(discovery: () => Promise<SwarmDiscoverySnapshot>) {
  const updateStack = vi.fn();
  const updateRevision = vi.fn();
  const updateDeployment = vi.fn();
  const createServiceDeployments = vi.fn();
  const setActiveDeployment = vi.fn();
  const retainDeployment = vi.fn();
  const service = createSwarmDeploymentReconciler({
    getStack: async () => stack,
    getRevision: async () => revision,
    resolvePlatform: async () => ({ stackRuntime: { discover: discovery } }) as never,
    updateStack,
    updateRevision,
    updateDeployment,
    syncProjections: async () => [{ id: "service-web", name: "web" }] as never,
    listServiceDeployments: async () => [],
    updateServiceDeployment: vi.fn(),
    createServiceDeployments,
    getProject: async () => ({ id: "project-blog", activeDeploymentId: null }) as Project,
    getDeployment: async () => undefined,
    setActiveDeployment,
    retainDeployment,
    now: () => new Date("2026-07-30T00:01:00.000Z"),
  });
  return {
    service,
    updateStack,
    updateRevision,
    updateDeployment,
    createServiceDeployments,
    setActiveDeployment,
    retainDeployment,
  };
}

describe("uncertain Swarm deployment reconciliation", () => {
  it("settles an accepted apply to ready from manager state without issuing another deploy", async () => {
    const test = fixture(async () => snapshot());
    await expect(test.service.reconcile({ deployment, runtimeRef })).resolves.toBe("finalized");
    expect(test.updateRevision).toHaveBeenCalledWith(
      "revision-1",
      "org-a",
      expect.objectContaining({ applyStatus: "ready" }),
    );
    expect(test.updateDeployment).toHaveBeenCalledWith("deployment-1", "ready", expect.any(Object));
    expect(test.createServiceDeployments).toHaveBeenCalledWith([
      expect.objectContaining({
        serviceName: "web",
        status: "success",
        runtimeRef: expect.objectContaining({ kind: "swarm-service", serviceId: "svc-web" }),
      }),
    ]);
    expect(test.setActiveDeployment).toHaveBeenCalledWith("project-blog", "deployment-1");
    expect(test.retainDeployment).toHaveBeenCalledWith(deployment, null);
  });

  it("records externally changed service specs as drift rather than reapplying the source", async () => {
    const test = fixture(async () => snapshot("nginx@sha256:external"));
    await expect(test.service.reconcile({ deployment, runtimeRef })).resolves.toBe("finalized");
    expect(test.updateStack).toHaveBeenCalledWith(
      "swarm-blog",
      "org-a",
      expect.objectContaining({
        driftStatus: "drifted",
        driftDetails: expect.objectContaining({
          changes: expect.arrayContaining([expect.objectContaining({ kind: "image" })]),
        }),
      }),
    );
    expect(test.updateDeployment).toHaveBeenCalledWith(
      "deployment-1",
      "partial_failure",
      expect.objectContaining({
        meta: expect.objectContaining({
          swarmDeployment: expect.objectContaining({ state: "drifted" }),
        }),
      }),
    );
    expect(test.createServiceDeployments).not.toHaveBeenCalled();
  });

  it("keeps the deployment reconciling when the manager still cannot be reached", async () => {
    const test = fixture(async () => {
      throw new Error("connection lost");
    });
    await expect(test.service.reconcile({ deployment, runtimeRef })).resolves.toBe("unreachable");
    expect(test.updateDeployment).not.toHaveBeenCalled();
    expect(test.updateStack).not.toHaveBeenCalled();
  });
});
