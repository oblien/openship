import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { SwarmDiscoverySnapshot } from "@repo/adapters";
import type { SwarmServiceProjection } from "@repo/core";
import type { ContainerRegistry, Deployment, Domain, Service, Project, SwarmStack, SwarmStackRevision } from "@repo/db";
import { createSwarmDeployService, selectSourceBuilds, type SwarmDeployLogger } from "./deploy.service";
import { swarmLiveStateDigest } from "../../swarm/swarm-preview";
import { planManagedInputResources, planManagedSwarmResources } from "../../swarm/swarm-managed-resources";

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
  routingMode: "external",
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
    resourceDiscovery?: SwarmDiscoverySnapshot;
    resourceDiscoveryError?: Error;
    revision?: SwarmStackRevision;
    registry?: ContainerRegistry;
    syncProjections?: (projectId: string, projections: SwarmServiceProjection[]) => Promise<Service[]>;
    listServices?: (projectId: string) => Promise<Service[]>;
    listDomains?: (projectId: string) => Promise<Domain[]>;
    executor?: { exec(command: string): Promise<string>; writeFile(path: string, content: string): Promise<void>; rm(path: string): Promise<void> };
    loadSource?: () => Promise<{ files: Array<{ path: string; content: string }>; composePaths: string[] }>;
    managedInputs?: Array<{ kind: "config" | "secret"; logicalName: string; content: string }>;
    renderedYaml?: string;
  } = {},
) {
  const activeStack = options.stackOverride ?? stack;
  const events: string[] = [];
  const createRevision = vi.fn(async (..._args: unknown[]) => ({ id: "revision-1", revision: 1 }));
  const updateRevision = vi.fn(async () => ({ id: "revision-1" }));
  const updateStack = vi.fn(async () => activeStack);
  const getRevision = vi.fn(async () => options.revision);
  const syncProjections = options.syncProjections ?? vi.fn(async () => [
    { id: "service-web", name: "web", sourceServiceName: "web" },
    { id: "service-worker", name: "worker", sourceServiceName: "worker" },
  ]);
  const createServiceDeployments = vi.fn(async () => []);
  const upsertServiceDeployment = vi.fn(async () => undefined);
  const discover = vi
    .fn()
    .mockResolvedValueOnce(options.beforeDiscovery ?? discovery(false));
  if (options.resourceDiscoveryError) discover.mockRejectedValueOnce(options.resourceDiscoveryError);
  else if (options.resourceDiscovery) discover.mockResolvedValueOnce(options.resourceDiscovery);
  discover
    .mockImplementationOnce(async () => {
      if (options.postDeployError) throw options.postDeployError;
      return discovery();
    });
  const deployStack = vi.fn(async (input: unknown) => {
    events.push("deploy");
    if (options.deployError) throw options.deployError;
    return { output: "Creating service blog_web\nCreating service blog_worker" };
  });
  const renderStack = vi.fn(async () => ({
    renderedYaml: options.renderedYaml ??
      "services:\n  web:\n    image: nginx:1.27-alpine\n  worker:\n    image: busybox:1.36\n",
    renderedDigest: "sha256:rendered",
    overrideYaml: "services: {}\n",
    warnings: [],
  }));
  const log = vi.fn((message: string) => events.push(`log:${message}`));
  const logger = {
    log,
    step: vi.fn((phase: string, state: string) => events.push(`${phase}:${state}`)),
  } as unknown as SwarmDeployLogger;
  const service = createSwarmDeployService({
    featureEnabled: () => true,
    getStack: async () => activeStack,
    getRegistry: async () => options.registry,
    loadManagedInputs: async () => options.managedInputs ?? [],
    ...(options.loadSource ? { loadSource: options.loadSource } : {}),
    resolvePlatform: async () =>
      ({
        stackRuntime: {
          discover,
          renderStack,
          deployStack,
        },
        executor: options.executor ?? null,
      }) as never,
    getRevision,
    createRevision: createRevision as never,
    updateRevision: updateRevision as never,
    updateStack,
    syncProjections: syncProjections as never,
    listServices: options.listServices ?? (async () => []),
    listDomains: options.listDomains ?? (async () => []),
    createServiceDeployments,
    upsertServiceDeployment,
    now: () => new Date("2026-07-30T00:00:00.000Z"),
  });
  return {
    service,
    events,
    createRevision,
    updateRevision,
    updateStack,
    getRevision,
    syncProjections,
    createServiceDeployments,
    upsertServiceDeployment,
    deployStack,
    renderStack,
    log,
    logger,
  };
}

const project = { id: "project-blog", organizationId: "org-a" } as Project;
const deployment = { id: "deployment-1", organizationId: "org-a" } as Deployment;

describe("managed Swarm deploy", () => {
  it("reuses only a prior digest for an unchanged isolated source-build context", () => {
    const result = selectSourceBuilds({
      stack: {
        ...stack,
        sourceKind: "repository",
        sourcePath: "deploy",
        sourcePaths: ["compose.yaml"],
      } as SwarmStack,
      deployment: { ...deployment, forceAll: false, changedPaths: ["deploy/web/src/main.ts"], changedPathsTruncated: false } as Deployment,
      buildable: [
        { service: { sourceServiceName: "web", mode: "replicated", build: "web", sourceState: "present" }, build: { context: "web" } },
        { service: { sourceServiceName: "worker", mode: "replicated", build: "worker", sourceState: "present" }, build: { context: "worker" } },
      ],
      previousImages: {
        web: "registry.example.com/team/blog/web@sha256:web",
        worker: "registry.example.com/team/blog/worker@sha256:worker",
      },
    });
    expect(result.build.map((entry) => entry.service.sourceServiceName)).toEqual(["web"]);
    expect(result.preserved).toEqual({ worker: "registry.example.com/team/blog/worker@sha256:worker" });
  });

  it("creates content-versioned manager resources and records the concrete refs on the revision", async () => {
    const sourceFiles = [
      {
        path: "compose.yaml",
        content: `services:
  web:
    image: nginx:1.27-alpine
    configs: [app-config]
    secrets: [db-password]
configs:
  app-config: { file: config/app.yaml }
secrets:
  db-password: { file: secrets/db-password }
`,
      },
      { path: "config/app.yaml", content: "theme: dark\n" },
      { path: "secrets/db-password", content: "not-logged\n" },
    ];
    const managed = planManagedSwarmResources({ projectId: project.id, files: sourceFiles, composePaths: ["compose.yaml"] });
    const before = discovery(false);
    const resourceDiscovery = {
      ...before,
      configs: [{ id: "config-version", name: managed[0]!.resourceName, labels: {
        "com.openship.swarm.managed-resource": "true",
        "com.openship.swarm.project-id": project.id,
        "com.openship.swarm.resource-kind": "config",
        "com.openship.swarm.logical-name": "app-config",
        "com.openship.swarm.content-sha256": managed[0]!.contentDigest,
      }, createdAt: null }],
      secrets: [{ id: "secret-version", name: managed[1]!.resourceName, labels: {
        "com.openship.swarm.managed-resource": "true",
        "com.openship.swarm.project-id": project.id,
        "com.openship.swarm.resource-kind": "secret",
        "com.openship.swarm.logical-name": "db-password",
        "com.openship.swarm.content-sha256": managed[1]!.contentDigest,
      }, createdAt: null }],
    };
    const commands: string[] = [];
    const executor = {
      exec: vi.fn(async (command: string) => {
        commands.push(command);
        return command.startsWith("umask 077") ? "/tmp/openship-swarm-resource.abc123" : "";
      }),
      writeFile: vi.fn(async () => undefined),
      rm: vi.fn(async () => undefined),
    };
    const test = fixture({
      stackOverride: { ...stack, sourceKind: "repository" } as SwarmStack,
      beforeDiscovery: before,
      resourceDiscovery,
      executor,
      loadSource: async () => ({ files: sourceFiles, composePaths: ["compose.yaml"] }),
    });

    await expect(test.service.deploy({ project, deployment, environment: {}, logger: test.logger }))
      .resolves.toMatchObject({ state: "ready" });
    expect(commands.join("\n")).toContain("docker config create");
    expect(commands.join("\n")).toContain("docker secret create");
    expect(commands.join("\n")).not.toContain("not-logged");
    expect(test.createRevision).toHaveBeenCalledWith(
      stack.id,
      deployment.organizationId,
      expect.objectContaining({
        configRefs: [managed[0]!.resourceName],
        secretRefs: [managed[1]!.resourceName],
      }),
    );
    expect(test.deployStack).toHaveBeenCalledWith(expect.objectContaining({
      renderedYaml: expect.stringContaining(managed[0]!.resourceName),
    }));
  });

  it("mounts encrypted operator-managed inputs without exposing their values in the rendered stack", async () => {
    const managedInputs = [
      { kind: "config" as const, logicalName: "operator-config", content: "region: internal\n" },
      { kind: "secret" as const, logicalName: "operator-token", content: "do-not-render-this" },
    ];
    const managed = planManagedInputResources({ projectId: project.id, inputs: managedInputs });
    const before = discovery(false);
    const resourceDiscovery = {
      ...before,
      configs: managed.filter((resource) => resource.kind === "config").map((resource) => ({
        id: `config-${resource.logicalName}`,
        name: resource.resourceName,
        labels: {
          "com.openship.swarm.managed-resource": "true",
          "com.openship.swarm.project-id": project.id,
          "com.openship.swarm.resource-kind": resource.kind,
          "com.openship.swarm.logical-name": resource.logicalName,
          "com.openship.swarm.content-sha256": resource.contentDigest,
        },
        createdAt: null,
      })),
      secrets: managed.filter((resource) => resource.kind === "secret").map((resource) => ({
        id: `secret-${resource.logicalName}`,
        name: resource.resourceName,
        labels: {
          "com.openship.swarm.managed-resource": "true",
          "com.openship.swarm.project-id": project.id,
          "com.openship.swarm.resource-kind": resource.kind,
          "com.openship.swarm.logical-name": resource.logicalName,
          "com.openship.swarm.content-sha256": resource.contentDigest,
        },
        createdAt: null,
      })),
    };
    const commands: string[] = [];
    const executor = {
      exec: vi.fn(async (command: string) => {
        commands.push(command);
        return command.startsWith("umask 077") ? "/tmp/openship-swarm-resource.abc123" : "";
      }),
      writeFile: vi.fn(async () => undefined),
      rm: vi.fn(async () => undefined),
    };
    const test = fixture({
      beforeDiscovery: before,
      resourceDiscovery,
      executor,
      managedInputs,
      renderedYaml: `services:
  web:
    image: nginx:1.27-alpine
    configs: [operator-config]
    secrets: [operator-token]
configs:
  operator-config: {}
secrets:
  operator-token: {}
`,
    });

    await expect(test.service.deploy({ project, deployment, environment: {}, logger: test.logger }))
      .resolves.toMatchObject({ state: "ready" });
    expect(test.createRevision).toHaveBeenCalledWith(stack.id, deployment.organizationId, expect.objectContaining({
      configRefs: [managed.find((resource) => resource.kind === "config")!.resourceName],
      secretRefs: [managed.find((resource) => resource.kind === "secret")!.resourceName],
    }));
    const rendered = test.deployStack.mock.calls[0]?.[0] as { renderedYaml: string };
    expect(rendered.renderedYaml).toContain(managed[0]!.resourceName);
    expect(rendered.renderedYaml).toContain(managed[1]!.resourceName);
    expect(rendered.renderedYaml).not.toContain("region: internal");
    expect(rendered.renderedYaml).not.toContain("do-not-render-this");
    expect(commands.join("\n")).not.toContain("do-not-render-this");
  });

  it("removes only newly-created operator resources when revision recording fails before apply", async () => {
    const managedInputs = [{ kind: "secret" as const, logicalName: "operator-token", content: "do-not-render-this" }];
    const [managed] = planManagedInputResources({ projectId: project.id, inputs: managedInputs });
    const before = discovery(false);
    const resourceDiscovery = {
      ...before,
      secrets: [{
        id: "secret-operator-token",
        name: managed!.resourceName,
        labels: {
          "com.openship.swarm.managed-resource": "true",
          "com.openship.swarm.project-id": project.id,
          "com.openship.swarm.resource-kind": "secret",
          "com.openship.swarm.logical-name": "operator-token",
          "com.openship.swarm.content-sha256": managed!.contentDigest,
        },
        createdAt: null,
      }],
    };
    const commands: string[] = [];
    const test = fixture({
      beforeDiscovery: before,
      resourceDiscovery,
      managedInputs,
      executor: {
        exec: vi.fn(async (command: string) => {
          commands.push(command);
          return command.startsWith("umask 077") ? "/tmp/openship-swarm-resource.abc123" : "";
        }),
        writeFile: vi.fn(async () => undefined),
        rm: vi.fn(async () => undefined),
      },
      renderedYaml: `services:
  web:
    image: nginx:1.27-alpine
    secrets: [operator-token]
secrets:
  operator-token: {}
`,
    });
    test.createRevision.mockImplementationOnce(async () => undefined as never);

    await expect(test.service.deploy({ project, deployment, environment: {}, logger: test.logger }))
      .rejects.toMatchObject({ code: "SWARM_STACK_REQUIRED" });
    expect(test.deployStack).not.toHaveBeenCalled();
    expect(commands.join("\n")).toContain(`docker secret create`);
    expect(commands.join("\n")).toContain(`docker secret rm '${managed!.resourceName}'`);
  });

  it("removes newly-created operator resources if the post-create manager discovery fails", async () => {
    const managedInputs = [{ kind: "secret" as const, logicalName: "operator-token", content: "do-not-render-this" }];
    const [managed] = planManagedInputResources({ projectId: project.id, inputs: managedInputs });
    const commands: string[] = [];
    const test = fixture({
      beforeDiscovery: discovery(false),
      resourceDiscoveryError: new Error("manager unavailable"),
      managedInputs,
      executor: {
        exec: vi.fn(async (command: string) => {
          commands.push(command);
          return command.startsWith("umask 077") ? "/tmp/openship-swarm-resource.abc123" : "";
        }),
        writeFile: vi.fn(async () => undefined),
        rm: vi.fn(async () => undefined),
      },
      renderedYaml: `services:
  web:
    image: nginx:1.27-alpine
    secrets: [operator-token]
secrets:
  operator-token: {}
`,
    });

    await expect(test.service.deploy({ project, deployment, environment: {}, logger: test.logger }))
      .rejects.toThrow("manager unavailable");
    expect(test.deployStack).not.toHaveBeenCalled();
    expect(commands.join("\n")).toContain(`docker secret rm '${managed!.resourceName}'`);
  });

  it("rebuilds every source service when the stack source changes or changed paths are incomplete", () => {
    const buildable: Array<{ service: SwarmServiceProjection; build: { context: string } }> = [
      { service: { sourceServiceName: "web", mode: "replicated", build: "web", sourceState: "present" }, build: { context: "web" } },
      { service: { sourceServiceName: "worker", mode: "replicated", build: "worker", sourceState: "present" }, build: { context: "worker" } },
    ];
    for (const deploymentOverride of [
      { changedPaths: ["deploy/compose.yaml"], changedPathsTruncated: false },
      { changedPaths: ["deploy/web/src/main.ts"], changedPathsTruncated: true },
    ]) {
      const result = selectSourceBuilds({
        stack: { ...stack, sourceKind: "repository", sourcePath: "deploy", sourcePaths: ["compose.yaml"] } as SwarmStack,
        deployment: { ...deployment, forceAll: false, ...deploymentOverride } as Deployment,
        buildable,
        previousImages: {
          web: "registry.example.com/team/blog/web@sha256:web",
          worker: "registry.example.com/team/blog/worker@sha256:worker",
        },
      });
      expect(result.build.map((entry) => entry.service.sourceServiceName)).toEqual(["web", "worker"]);
      expect(result.preserved).toEqual({});
    }
  });

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

  it("reapplies a retained revision verbatim as a new rollback revision without rebuilding source images", async () => {
    const retainedYaml = [
      "services:",
      "  web:",
      "    image: registry.example.com/blog/web@sha256:aaaaaaaa",
      "    deploy:",
      "      replicas: 2",
      "  worker:",
      "    image: registry.example.com/blog/worker@sha256:bbbbbbbb",
      "    deploy:",
      "      replicas: 3",
      "",
    ].join("\n");
    const retainedRevision = {
      id: "revision-retained",
      stackId: "swarm-blog",
      revision: 4,
      sourceDigest: "sha256:source-retained",
      sourceCommitSha: "deadbeef",
      renderedYamlEnc: retainedYaml,
      renderedDigest: `sha256:${createHash("sha256").update(retainedYaml).digest("hex")}`,
      renderedYamlRedacted: retainedYaml,
      overrideYamlRedacted: null,
      manifest: { routingMode: "external", prune: false },
      serviceImages: {
        web: "registry.example.com/blog/web@sha256:aaaaaaaa",
        worker: "registry.example.com/blog/worker@sha256:bbbbbbbb",
      },
      configRefs: [],
      secretRefs: [],
      applyStatus: "ready",
    } as unknown as SwarmStackRevision;
    const test = fixture({ revision: retainedRevision });
    const rollbackDeployment = {
      ...deployment,
      meta: { swarmRollback: { sourceDeploymentId: "deployment-old", sourceRevisionId: retainedRevision.id } },
    } as Deployment;

    await expect(test.service.deploy({ project, deployment: rollbackDeployment, environment: {}, logger: test.logger }))
      .resolves.toMatchObject({ state: "ready", revisionId: "revision-1" });

    expect(test.renderStack).not.toHaveBeenCalled();
    expect(test.deployStack).toHaveBeenCalledWith(expect.objectContaining({ renderedYaml: retainedYaml, prune: false }));
    expect(test.createRevision).toHaveBeenCalledWith(
      "swarm-blog",
      "org-a",
      expect.objectContaining({
        sourceDigest: "sha256:source-retained",
        sourceCommitSha: "deadbeef",
        renderedDigest: retainedRevision.renderedDigest,
        serviceImages: retainedRevision.serviceImages,
        manifest: expect.objectContaining({
          rollback: { sourceDeploymentId: "deployment-old", sourceRevisionId: "revision-retained" },
        }),
      }),
    );
  });

  it("blocks a retained revision with a missing config or secret before creating a revision or mutating Swarm", async () => {
    const retainedYaml = "services:\n  web:\n    image: nginx@sha256:aaaaaaaa\n";
    const retainedRevision = {
      id: "revision-retained",
      stackId: "swarm-blog",
      revision: 4,
      sourceDigest: "sha256:source-retained",
      sourceCommitSha: null,
      renderedYamlEnc: retainedYaml,
      renderedDigest: `sha256:${createHash("sha256").update(retainedYaml).digest("hex")}`,
      renderedYamlRedacted: retainedYaml,
      overrideYamlRedacted: null,
      manifest: { routingMode: "external", prune: false },
      serviceImages: { web: "nginx@sha256:aaaaaaaa" },
      configRefs: ["retained-config"],
      secretRefs: ["retained-secret"],
      applyStatus: "ready",
    } as unknown as SwarmStackRevision;
    const test = fixture({ revision: retainedRevision });
    const rollbackDeployment = {
      ...deployment,
      meta: { swarmRollback: { sourceDeploymentId: "deployment-old", sourceRevisionId: retainedRevision.id } },
    } as Deployment;

    await expect(test.service.deploy({ project, deployment: rollbackDeployment, environment: {}, logger: test.logger }))
      .rejects.toMatchObject({ code: "SWARM_ROLLBACK_DEPENDENCY_MISSING" });
    expect(test.createRevision).not.toHaveBeenCalled();
    expect(test.deployStack).not.toHaveBeenCalled();
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

  it("passes only the decrypted registry credential to the transient deploy adapter input", async () => {
    const registry = {
      id: "registry-a",
      organizationId: "org-a",
      registryUrl: "registry.example.com",
      repositoryPrefix: "team",
      username: "robot",
      credentialsEnc: "write-only-secret",
    } as ContainerRegistry;
    const test = fixture({
      stackOverride: { ...stack, registryId: registry.id, withRegistryAuth: true } as SwarmStack,
      registry,
    });
    await expect(test.service.deploy({ project, deployment, environment: {}, logger: test.logger })).resolves.toMatchObject({ state: "ready" });
    expect(test.deployStack).toHaveBeenCalledWith(expect.objectContaining({
      withRegistryAuth: true,
      registryAuth: { serverAddress: "registry.example.com", username: "robot", password: "write-only-secret" },
    }));
    expect(test.log.mock.calls.flat().join("\n")).not.toContain("write-only-secret");
  });

  it("persists a source-build failure before refusing a stack with no registry", async () => {
    const sourceBuildStack = {
      ...stack,
      sourceYamlEnc: "services:\n  web:\n    build: .\n",
      registryId: null,
    } as SwarmStack;
    const test = fixture({ stackOverride: sourceBuildStack });

    await expect(test.service.deploy({ project, deployment, environment: {}, logger: test.logger }))
      .rejects.toMatchObject({ code: "SWARM_BUILD_REGISTRY_REQUIRED" });

    expect(test.upsertServiceDeployment).toHaveBeenCalledWith(expect.objectContaining({
      deploymentId: "deployment-1",
      status: "failure",
      runtimeRef: null,
      errorMessage: expect.stringContaining("No OCI registry"),
    }));
    expect(test.deployStack).not.toHaveBeenCalled();
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

  it("registers a Swarm Edge vhost by stable service DNS without touching a task container", async () => {
    const routeService = {
      id: "service-web",
      kind: "swarm",
      name: "web",
      sourceServiceName: "web",
      enabled: true,
      exposed: true,
      exposedPort: "3000",
      domainType: "custom",
      customDomain: "app.example.test",
      publicEndpoints: [],
      swarmProjection: { sourceServiceName: "web", mode: "replicated", sourceState: "present" },
    } as unknown as Service;
    const routeDomain = {
      id: "domain-app",
      hostname: "app.example.test",
      domainType: "custom",
      verified: false,
      sslStatus: "error",
      externalIngress: false,
      manualSsl: false,
    } as Domain;
    const commands: string[] = [];
    const executor = {
      exec: vi.fn(async (command: string) => {
        commands.push(command);
        if (command.startsWith("docker service inspect")) return "[]";
        if (command.startsWith("umask 077")) return "/tmp/openship-swarm-edge-route.abc123";
        return "";
      }),
      writeFile: vi.fn(async () => {}),
      rm: vi.fn(async () => {}),
    };
    const syncProjections = vi
      .fn()
      .mockResolvedValueOnce([{ ...routeService, exposed: false }])
      .mockResolvedValueOnce([routeService]);
    const test = fixture({
      stackOverride: { ...stack, routingMode: "openship-edge" } as SwarmStack,
      syncProjections,
      listServices: async () => [routeService],
      listDomains: async () => [routeDomain],
      executor,
    });

    await expect(test.service.deploy({ project, deployment, environment: {}, logger: test.logger }))
      .resolves.toMatchObject({ state: "ready" });
    expect(executor.writeFile).toHaveBeenCalledWith(
      expect.stringContaining("/route.conf"),
      expect.stringContaining("proxy_pass http://blog_web:3000;"),
    );
    expect(commands.join("\n")).toContain("docker service update --detach=false");
    expect(commands.join("\n")).not.toContain("docker exec");
  });
});
