import { describe, expect, it, vi } from "vitest";
import type { SwarmDiscoverySnapshot } from "@repo/adapters";
import type { Deployment, Project, SwarmStack } from "@repo/db";
import { createSwarmDeployService, type SwarmDeployLogger } from "./deploy.service";
import { swarmLiveStateDigest } from "../../swarm/swarm-preview";

const stack = {
  id: "swarm-blog",
  projectId: "project-blog",
  organizationId: "org-a",
  managerServerId: "server-manager",
  clusterId: "cluster-a",
  stackName: "blog",
  managementMode: "managed",
  sourceKind: "inline",
  sourceStatus: "valid",
  sourceYamlEnc:
    "services:\n  web:\n    image: nginx:1.27-alpine\n  worker:\n    image: busybox:1.36\n",
  sourceDigest: "sha256:source",
  sourceCommitSha: null,
  registryId: null,
  prune: false,
  withRegistryAuth: false,
} as unknown as SwarmStack;

function discovery(services = true): SwarmDiscoverySnapshot {
  const labels = {
    "com.openship.stack-id": "swarm-blog",
    "com.openship.project-id": "project-blog",
  };
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
    stacks: services
      ? [{ name: "blog", serviceIds: ["svc-web", "svc-worker"], serviceNames: ["web", "worker"] }]
      : [],
    services: services
      ? [
          {
            id: "svc-web",
            name: "blog_web",
            sourceServiceName: "web",
            stackName: "blog",
            specVersion: 4,
            mode: "replicated",
            desiredReplicas: 1,
            image: "nginx:1.27-alpine",
            labels,
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
          {
            id: "svc-worker",
            name: "blog_worker",
            sourceServiceName: "worker",
            stackName: "blog",
            specVersion: 3,
            mode: "replicated",
            desiredReplicas: 1,
            image: "busybox:1.36",
            labels,
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
        ]
      : [],
    tasks: services
      ? [
          {
            id: "task-web",
            serviceId: "svc-web",
            serviceName: "blog_web",
            slot: 1,
            nodeId: "node-a",
            nodeName: "manager",
            desiredState: "Running",
            currentState: "Running 1 second ago",
            error: null,
            image: "nginx:1.27-alpine",
            updatedAt: null,
            observedAt: "2026-07-30T00:00:00.000Z",
          },
          {
            id: "task-worker",
            serviceId: "svc-worker",
            serviceName: "blog_worker",
            slot: 1,
            nodeId: "node-a",
            nodeName: "manager",
            desiredState: "Running",
            currentState: "Running 1 second ago",
            error: null,
            image: "busybox:1.36",
            updatedAt: null,
            observedAt: "2026-07-30T00:00:00.000Z",
          },
        ]
      : [],
    networks: [],
    volumes: [],
    configs: [],
    secrets: [],
    diagnostics: [],
    observedAt: "2026-07-30T00:00:00.000Z",
  };
}

function fixture(
  options: {
    postDeployError?: Error;
    deployError?: Error;
    stackOverride?: SwarmStack;
    beforeDiscovery?: SwarmDiscoverySnapshot;
  } = {},
) {
  const activeStack = options.stackOverride ?? stack;
  const events: string[] = [];
  const createRevision = vi.fn(async (..._args: unknown[]) => ({ id: "revision-1", revision: 1 }));
  const updateRevision = vi.fn(async () => ({ id: "revision-1" }));
  const updateStack = vi.fn(async () => activeStack);
  const syncProjections = vi.fn(async () => [
    { id: "service-web", name: "web", sourceServiceName: "web" },
    { id: "service-worker", name: "worker", sourceServiceName: "worker" },
  ]);
  const createServiceDeployments = vi.fn(async () => []);
  const discover = vi
    .fn()
    .mockResolvedValueOnce(options.beforeDiscovery ?? discovery(false))
    .mockImplementationOnce(async () => {
      if (options.postDeployError) throw options.postDeployError;
      return discovery();
    });
  const deployStack = vi.fn(async (input: unknown) => {
    events.push("deploy");
    if (options.deployError) throw options.deployError;
    return { output: "Creating service blog_web\nCreating service blog_worker" };
  });
  const log = vi.fn((message: string) => events.push(`log:${message}`));
  const logger = {
    log,
    step: vi.fn((phase: string, state: string) => events.push(`${phase}:${state}`)),
  } as unknown as SwarmDeployLogger;
  const service = createSwarmDeployService({
    featureEnabled: () => true,
    getStack: async () => activeStack,
    resolvePlatform: async () =>
      ({
        stackRuntime: {
          discover,
          renderStack: async () => ({
            renderedYaml:
              "services:\n  web:\n    image: nginx:1.27-alpine\n  worker:\n    image: busybox:1.36\n",
            renderedDigest: "sha256:rendered",
            overrideYaml: "services: {}\n",
            warnings: [],
          }),
          deployStack,
        },
      }) as never,
    createRevision: createRevision as never,
    updateRevision: updateRevision as never,
    updateStack,
    syncProjections: syncProjections as never,
    createServiceDeployments,
    now: () => new Date("2026-07-30T00:00:00.000Z"),
  });
  return {
    service,
    events,
    createRevision,
    updateRevision,
    updateStack,
    syncProjections,
    createServiceDeployments,
    deployStack,
    log,
    logger,
  };
}

const project = { id: "project-blog", organizationId: "org-a" } as Project;
const deployment = { id: "deployment-1", organizationId: "org-a" } as Deployment;

describe("managed Swarm deploy", () => {
  it("records a revision before applying and persists stack/service runtime references after manager convergence", async () => {
    const test = fixture();
    test.createRevision.mockImplementationOnce(async () => {
      test.events.push("revision");
      return { id: "revision-1", revision: 1 };
    });

    await expect(
      test.service.deploy({
        project,
        deployment,
        environment: { API_TOKEN: "top-secret" },
        logger: test.logger,
      }),
    ).resolves.toMatchObject({
      state: "ready",
      revisionId: "revision-1",
      runtimeRef: { kind: "swarm-stack", stackName: "blog" },
    });

    expect(test.events.indexOf("revision")).toBeLessThan(test.events.indexOf("deploy"));
    expect(test.deployStack).toHaveBeenCalledWith(
      expect.objectContaining({
        stackName: "blog",
        resolveImage: "always",
        prune: false,
      }),
    );
    expect(test.updateRevision).toHaveBeenCalledWith(
      "revision-1",
      "org-a",
      expect.objectContaining({ applyStatus: "ready" }),
    );
    expect(test.updateStack).toHaveBeenCalledWith(
      "swarm-blog",
      "org-a",
      expect.objectContaining({
        lastAppliedRevisionId: "revision-1",
        driftStatus: "clean",
      }),
    );
    expect(test.createServiceDeployments).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          serviceName: "web",
          status: "success",
          runtimeRef: expect.objectContaining({ kind: "swarm-service", serviceId: "svc-web" }),
        }),
        expect.objectContaining({
          serviceName: "worker",
          status: "success",
          runtimeRef: expect.objectContaining({ kind: "swarm-service", serviceId: "svc-worker" }),
        }),
      ]),
    );
    expect(test.log.mock.calls.flat().join("\n")).not.toContain("top-secret");
  });

  it("keeps a possibly accepted apply reconciling when manager access drops after docker stack deploy", async () => {
    const test = fixture({ postDeployError: new Error("connection lost") });
    await expect(
      test.service.deploy({ project, deployment, environment: {}, logger: test.logger }),
    ).resolves.toMatchObject({
      state: "reconciling",
      warningMessage: expect.stringContaining("unreachable"),
    });
    expect(test.createServiceDeployments).not.toHaveBeenCalled();
    expect(test.updateRevision).toHaveBeenLastCalledWith(
      "revision-1",
      "org-a",
      expect.objectContaining({ applyStatus: "converging" }),
    );
  });

  it("treats a lost deploy command response as indeterminate instead of running container cleanup", async () => {
    const test = fixture({ deployError: new Error("connection lost") });
    await expect(
      test.service.deploy({ project, deployment, environment: {}, logger: test.logger }),
    ).resolves.toMatchObject({
      state: "reconciling",
      warningMessage: expect.stringContaining("during stack deploy"),
    });
    expect(test.updateRevision).toHaveBeenLastCalledWith(
      "revision-1",
      "org-a",
      expect.objectContaining({ applyStatus: "converging" }),
    );
    expect(test.createServiceDeployments).not.toHaveBeenCalled();
  });

  it("permits exactly the current pending claim, disables first-claim prune, and only then marks the stack managed", async () => {
    const pendingClaim = {
      ...stack,
      managementMode: "observe",
      claimedAt: new Date("2026-07-30T00:00:00.000Z"),
      driftDetails: { claimLiveDigest: swarmLiveStateDigest([]) },
      prune: true,
    } as SwarmStack;
    const test = fixture({ stackOverride: pendingClaim });
    await expect(
      test.service.deploy({ project, deployment, environment: {}, logger: test.logger }),
    ).resolves.toMatchObject({ state: "ready" });
    expect(test.deployStack).toHaveBeenCalledWith(expect.objectContaining({ prune: false }));
    expect(test.updateStack).toHaveBeenCalledWith(
      "swarm-blog",
      "org-a",
      expect.objectContaining({ managementMode: "managed" }),
    );
  });

  it("prunes only a reviewed service that already carries this stack's ownership labels", async () => {
    const current = discovery(false);
    current.services = [
      {
        ...discovery().services[0]!,
        id: "svc-retired",
        name: "blog_retired",
        sourceServiceName: "retired",
      },
    ];
    const test = fixture({
      stackOverride: { ...stack, prune: true } as SwarmStack,
      beforeDiscovery: current,
    });
    await expect(
      test.service.deploy({ project, deployment, environment: {}, logger: test.logger }),
    ).resolves.toMatchObject({ state: "ready" });
    expect(test.deployStack).toHaveBeenCalledWith(expect.objectContaining({ prune: true }));
    expect(test.createRevision.mock.calls[0]?.[2]).toMatchObject({
      manifest: expect.objectContaining({ prune: true, pruneRemovals: ["retired"] }),
    });
    expect(test.log.mock.calls.flat().join("\n")).toContain(
      "Confirmed managed-service prune: retired",
    );
  });

  it("blocks automatic prune when a service in the stack namespace lacks matching ownership labels", async () => {
    const current = discovery(false);
    current.services = [
      {
        ...discovery().services[0]!,
        id: "svc-foreign",
        name: "blog_foreign",
        sourceServiceName: "foreign",
        labels: { "com.docker.stack.namespace": "blog" },
      },
    ];
    const test = fixture({
      stackOverride: { ...stack, prune: true } as SwarmStack,
      beforeDiscovery: current,
    });
    await expect(
      test.service.deploy({ project, deployment, environment: {}, logger: test.logger }),
    ).rejects.toMatchObject({ code: "SWARM_STACK_OWNERSHIP_CONFLICT", statusCode: 409 });
    expect(test.deployStack).not.toHaveBeenCalled();
  });
});
