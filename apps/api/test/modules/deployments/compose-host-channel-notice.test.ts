import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BuildLogger, CommandExecutor, MultiServiceRuntimeAdapter, DockerRuntime as DockerRuntimeType, CloudDockerRuntime as CloudDockerRuntimeType } from "@repo/adapters";
import type { Deployment, Project } from "@repo/db";

/**
 * A compose deploy to a box that cannot drive its host must SAY so, once, in the
 * deploy log (#509).
 *
 * With the host channel demoted to refuse-on-use, the #509 repro stops failing and
 * starts silently degrading, which is its own bug: every host touchpoint absorbs the
 * refusal on its own terms. `allocateHostPort` reports "couldn't read occupancy" — and
 * only under `loopback-port` routing — while the routing preflight logs "deploy
 * continues". Neither names the channel or a fix, so the first legible symptom is a
 * container that dies later over a config file that never landed on the host.
 *
 * Driven end-to-end from the real demotion (a `--no-host-control` box resolving its
 * local row) rather than from a stubbed notice, because the bug was never in the
 * wording — it was that nothing carried the fact from the decision to the log.
 */

const h = vi.hoisted(() => ({
  localImageRefs: new Set<string>(),
  targetLockHeld: false,
  probeDeployedReadiness: vi.fn(),
  applyProjectRouting: vi.fn(),
  reapplyProjectLiveRoutes: vi.fn(),
  localRow: {
    id: "srv-local",
    isLocal: true,
    sshHost: "127.0.0.1",
    sshPort: 22,
    sshUser: "root",
  },
  convergeTargetHostPortClaims: vi.fn(),
  convergeTargetHostPortClaimsUnlocked: vi.fn(),
  prepareTargetPinnedHostPorts: vi.fn(),
  allocateAndReservePinnedHostPort: vi.fn(),
  releaseNewPinnedHostPortClaims: vi.fn(),
  reserveResolvedLoopbackRoutes: vi.fn(),
  upsertServiceDeployment: vi.fn(),
  updateServiceDeployment: vi.fn(),
  startServiceDeploymentTiming: vi.fn(),
  finishStartedServiceDeploymentTimings: vi.fn(),
  services: [] as Array<Record<string, unknown>>,
  previousServiceRows: [] as Array<Record<string, unknown>>,
  deploymentById: new Map<string, Record<string, unknown>>(),
  previousDeployment: { id: "d-old", projectId: "p1", organizationId: "org1", containerId: "compose", createdAt: null } as Record<
    string,
    unknown
  >,
}));

vi.mock("@repo/db", () => ({
  repos: {
    routeProtection: { readPrivate: async () => null },
    pullRequestPreview: { findByProject: async () => null },
    server: {
      get: async () => h.localRow,
      getInOrganization: async () => h.localRow,
      update: async () => {},
    },
    service: {
      listByProject: async () => h.services,
      listByDeployment: async () => h.previousServiceRows,
      upsertServiceDeployment: (...args: unknown[]) => h.upsertServiceDeployment(...args),
      updateServiceDeployment: (...args: unknown[]) => h.updateServiceDeployment(...args),
      startServiceDeploymentTiming: (...args: unknown[]) => h.startServiceDeploymentTiming(...args),
      finishStartedServiceDeploymentTimings: (...args: unknown[]) => h.finishStartedServiceDeploymentTimings(...args),
      markServiceDeploymentFailed: async () => undefined,
    },
    deployment: {
      findById: async (id: string) => h.deploymentById.get(id) ?? h.previousDeployment,
    },
    project: {
      findById: async (id: string) => ({ id, workspaceId: null }),
      getEnvMap: async () => ({}),
      listEnvVarChangeMeta: async () => [],
    },
    domain: {
      listByProject: async () => [],
      findByHostname: async () => null,
      findOrCreateWithStatus: async (input: Record<string, unknown>) => ({
        domain: {
          id: `dom-${String(input.hostname)}`,
          status: "pending",
          verified: false,
          sslStatus: "none",
          ...input,
        },
        created: true,
      }),
    },
  },
}));

// The row IS this box. Keyed off the flag so the test doesn't depend on loopback
// resolution or on which org owns the box.
vi.mock("@repo/platform/engine/lib/box-org", () => ({
  isLocalHostRow: async (row: { isLocal?: boolean }) => Boolean(row?.isLocal),
  boxOwningOrgId: async () => "org1",
}));

vi.mock("@repo/platform/engine/lib/provision-lock", () => ({
  createProvisionLock: () => ({ run: (f: () => unknown) => f() }),
}));

vi.mock("@repo/platform/engine/modules/deployments/pinned-host-ports", () => ({
  withHostPortTargetLock: async (_target: unknown, fn: () => unknown) => {
    if (h.targetLockHeld) throw new Error("nested physical target lock");
    h.targetLockHeld = true;
    try { return await fn(); } finally { h.targetLockHeld = false; }
  },
  prepareTargetPinnedHostPorts: (...args: unknown[]) => h.prepareTargetPinnedHostPorts(...args),
  convergeTargetHostPortClaims: (...args: unknown[]) => h.convergeTargetHostPortClaims(...args),
  convergeTargetHostPortClaimsUnlocked: (...args: unknown[]) =>
    h.convergeTargetHostPortClaimsUnlocked(...args),
  allocateAndReservePinnedHostPort: (...args: unknown[]) =>
    h.allocateAndReservePinnedHostPort(...args),
  releaseNewPinnedHostPortClaims: (...args: unknown[]) => h.releaseNewPinnedHostPortClaims(...args),
}));

vi.mock("@repo/platform/engine/modules/deployments/observed-host-port-claims", () => ({
  reserveResolvedLoopbackRoutes: (...args: unknown[]) => h.reserveResolvedLoopbackRoutes(...args),
}));

vi.mock("@repo/platform/engine/modules/deployments/readiness-probe", () => ({
  probeDeployedReadiness: (...args: unknown[]) => h.probeDeployedReadiness(...args),
}));
vi.mock("@repo/platform/engine/modules/domains/project-route.service", () => ({
  reapplyProjectLiveRoutes: (...args: unknown[]) => h.reapplyProjectLiveRoutes(...args),
}));

const { resolveServerExecutor } = await import("@repo/platform/engine/lib/deployment-runtime");
// Spy after the shared runtime has loaded; an eager partial-module mock would
// await that same runtime through routing's circular import during collection.
const routingApply = await import("@repo/platform/engine/modules/domains/routing-apply.service");
vi.spyOn(routingApply, "applyProjectRouting").mockImplementation((...args) => h.applyProjectRouting(...args));
const { deployComposeServices } =
  await import("@repo/platform/engine/modules/deployments/compose/deploy.service");
const { DockerRuntime, CloudDockerRuntime } = await import("@repo/adapters");
const IMAGE_ID = `sha256:${"a".repeat(64)}`;

/** Collects what the deploy log was told, in order. */
function recordingLogger() {
  const lines: { message: string; level: string }[] = [];
  const logger = {
    log: (message: string, level = "info") => lines.push({ message, level }),
    step: () => {},
    callback: (entry: { message: string; level?: string }) =>
      lines.push({ message: entry.message, level: entry.level ?? "info" }),
  } as unknown as BuildLogger;
  return { logger, lines };
}

/** Real image preparation and deploy planning, with only daemon I/O stubbed. */
function imageRefreshFixture() {
  const dbRef = "postgres:16";
  const apiRef = "ghcr.io/acme/api:latest";
  const dbId = `sha256:${"1".repeat(64)}`;
  const apiId = `sha256:${"2".repeat(64)}`;
  const nextId = `sha256:${"3".repeat(64)}`;
  const metadata = (ref: string, id: string) => ({ Id: id,
    RepoDigests: [`${ref.replace(/:[^/:]+$/, "")}@${id}`] });
  const images = new Map([[dbRef, metadata(dbRef, dbId)], [apiRef, metadata(apiRef, apiId)]]);
  const inspect = vi.fn(async (ref: string) => {
    const image = images.get(ref);
    if (!image) throw Object.assign(new Error("No such image"), { statusCode: 404 });
    return image;
  });
  const pull = vi.fn(async (_ref: string, _options?: { force?: boolean }) => undefined);
  const activate = vi.fn(async (_group: unknown, config: { serviceName: string; image: string }) => ({
    status: "running", containerId: `new-${config.serviceName}`, ip: "172.18.0.3",
  }));
  const runtime = Object.assign(Object.create(DockerRuntime.prototype), {
    name: "docker", unsupportedComposeKeys: new Set(),
    supports: (cap: string) => cap === "containerIp" || cap === "containerInfo",
    inspectDeploymentImage: inspect, pullImage: pull, deployServiceWorkload: activate,
    ensureServiceGroup: vi.fn(async () => ({ id: "group-1" })),
    getContainerInfo: vi.fn(async (id: string) => ({
      containerId: id, status: "running", imageId: id === "old-db" ? dbId : apiId, ip: "172.18.0.2",
    })),
    getContainerIp: vi.fn(async () => "172.18.0.3"), destroy: vi.fn(async () => undefined),
  }) as DockerRuntimeType;
  h.services = [
    { id: "svc-db", projectId: "p1", name: "db", image: dbRef, enabled: true,
      updatedAt: new Date(0), dependsOn: [], advanced: null, ports: [], exposed: false },
    { id: "svc-api", projectId: "p1", name: "api", image: apiRef, enabled: true,
      updatedAt: new Date(0), dependsOn: ["db"], advanced: null, ports: [], exposed: false },
  ];
  h.previousServiceRows = h.services.map(service => ({
    id: `sd-${service.name}`, deploymentId: "d-old", serviceId: service.id, serviceName: service.name,
    containerId: `old-${service.name}`, imageRef: service.image, status: "success", ip: "172.18.0.2",
  }));
  h.previousDeployment.createdAt = new Date(1_000);
  const { logger } = recordingLogger();
  const run = (options: Parameters<typeof deployComposeServices>[4] = {}, trigger = "manual", projectOverrides: Partial<Project> = {}) =>
    deployComposeServices({ ...project, activeDeploymentId: "d-old", routeStrategy: "container-ip", ...projectOverrides } as Project,
      { ...dep, trigger }, runtime, logger, options);
  return { runtime, run, logger, images, inspect, pull, activate, metadata, dbRef, apiRef, dbId, apiId, nextId };
}

/** Stops the deploy at the first thing after the notice, so the test exercises the
 *  emission point and its ORDER without needing a Docker host. */
function haltingRuntime(name: "docker" | "cloud" = "docker", containerIp = true) {
  return {
    name,
    supports: (capability: string) => capability === "containerIp" && containerIp,
    ensureServiceGroup: vi.fn(async () => {
      throw new Error("halt: nothing past the notice is under test");
    }),
  } as unknown as MultiServiceRuntimeAdapter;
}

function carriedRuntime(containerIp = true) {
  return {
    name: "docker",
    unsupportedComposeKeys: new Set(),
    supports: (capability: string) =>
      capability === "containerInfo" || (capability === "containerIp" && containerIp),
    ensureServiceGroup: vi.fn(async () => ({ id: "group-1" })),
    getContainerInfo: vi.fn(async () => ({
      status: "running",
      ip: "172.18.0.2",
      hostPort: 30_000,
      hostPortByContainerPort: { 8080: 30_000 },
    })),
    destroy: vi.fn(async () => undefined),
  } as unknown as MultiServiceRuntimeAdapter;
}

function startingRuntime() {
  return {
    name: "docker",
    unsupportedComposeKeys: new Set(),
    supports: (capability: string) => capability === "containerIp",
    ensureServiceGroup: vi.fn(async () => ({ id: "group-1" })),
    deployServiceWorkload: vi.fn(async () => ({
      status: "running",
      containerId: "container-new",
      ip: "172.18.0.3",
    })),
    destroy: vi.fn(async () => undefined),
    getContainerIp: vi.fn(async () => "172.18.0.3"),
  } as unknown as MultiServiceRuntimeAdapter;
}

it("deploys Cloud Compose endpoints, internal paths, generated files and container identities through one workspace", async () => {
  const { CloudDockerRuntime, CloudInfraProvider } = await import("@repo/adapters");
  const configurations: Array<Record<string, any>> = [];
  const publishRoute = vi.fn(async () => undefined);
  const pullImage = vi.fn(async () => undefined);
  const resolveRoutingTarget = vi.fn(async (id: string, port: number) => ({ workspace: "shared-vm",
    port: id === "web-container" ? (port === 8080 ? 30001 : 30002) : 30003 }));
  const runtime = Object.assign(Object.create(CloudDockerRuntime.prototype), {
    name: "docker", workspaceId: "shared-vm", projectId: "p1", unsupportedComposeKeys: new Set(),
    supports: (cap: string) => cap === "dockerHost",
    ensureServiceGroup: vi.fn(async () => ({ id: "shared-network", kind: "docker-network" })),
    deployServiceWorkload: vi.fn(async (_group: unknown, config: Record<string, any>) => {
      configurations.push(config);
      const hostPortByContainerPort = config.serviceName === "web" ? { 8080: 30001, 9090: 30002 } : { 8080: 30003 };
      return { status: "running", containerId: `${config.serviceName}-container`, hostPortByContainerPort };
    }),
    resolveRoutingTarget,
    getContainerIp: vi.fn(async () => "172.18.0.2"), listAllContainers: vi.fn(async () => []),
    destroy: vi.fn(async () => undefined), publishRoute, pullImage,
  }) as CloudDockerRuntimeType;
  const routing = Object.assign(Object.create(CloudInfraProvider.prototype), {
    publishRoute, resolveRoutingTarget,
  });
  const executor = {
    exec: vi.fn(async () => ""), mkdir: vi.fn(async () => undefined), rm: vi.fn(async () => undefined),
    rename: vi.fn(async () => undefined), writeFile: vi.fn(async () => undefined),
  } as unknown as CommandExecutor;
  h.services = [{ id: "svc-web", name: "web", projectId: "p1", kind: "compose", enabled: true, exposed: true,
    ports: ["8080", "9090"], image: "web:v1", dependsOn: [], environment: {}, volumes: ["data:/data"],
    exposedPort: "8080", domainType: "free", domain: "app", advanced: null,
    publicEndpoints: [{ port: 8080, domain: "app", domainType: "free" }, { port: 9090, domain: "console", domainType: "free" }] },
  { id: "svc-api", name: "api", projectId: "p1", kind: "compose", enabled: true, exposed: false,
    ports: ["8080"], image: "api:v1", dependsOn: [], environment: {}, volumes: [],
    advanced: { resources: { cpuCores: 2, memoryMb: 2048 }, files: [{ path: "/etc/app.yml", content: "enabled: true" }] } }];
  h.previousServiceRows = [];
  h.upsertServiceDeployment.mockImplementation(async row => {
    h.previousServiceRows.push(row);
    return row;
  });
  const { logger } = recordingLogger();
  const result = await deployComposeServices({ ...project, workspaceId: "shared-vm", routeStrategy: "auto",
    compositeRoutes: [{ hostname: "app.opsh.io", isCustomDomain: false, rootServiceId: "svc-web",
      locations: [{ pathPrefix: "/api/", serviceId: "svc-api" }] }] } as Project,
  { ...dep, projectId: "p1", meta: { deployTarget: "cloud", runtimeMode: "docker", managedServer: { projectId: "p1", workspaceId: "shared-vm", ownerWorkspaceId: "subscribed-server" } } },
  runtime, logger, { executor, localHost: false, usesManagedRouting: false, forcePullImages: true,
    resources: { cpuCores: 1, memoryMb: 1024, diskMb: 8192 },
    routing, ssl: { provisionCert: vi.fn(), verifyCert: vi.fn() } as never });
  expect(result.status).toBe("ready");
  expect(result.routeWarnings ?? []).toEqual([]);
  expect(configurations.find(config => config.serviceName === "web")?.cloudEndpoints).toEqual([
    { hostname: "app.opsh.io", port: 8080, custom: false }, { hostname: "console.opsh.io", port: 9090, custom: false },
  ]);
  const api = configurations.find(config => config.serviceName === "api")!;
  expect(api.cloudEndpoints).toEqual([]);
  expect(api.cloudProxyPorts).toEqual([8080]);
  expect(api.volumes.some((volume: string) => volume.endsWith(":/etc/app.yml:ro"))).toBe(true);
  expect(executor.writeFile).toHaveBeenCalledWith(expect.any(String), "enabled: true", expect.any(Object));
  expect(pullImage).toHaveBeenCalledWith("web:v1", { force: true, logger });
  expect(pullImage).toHaveBeenCalledWith("api:v1", { force: true, logger });
  expect(h.upsertServiceDeployment).toHaveBeenCalledWith(expect.objectContaining({
    serviceId: "svc-web", containerId: "web-container", hostPorts: { 8080: 30001, 9090: 30002 },
    allocatedResources: { containerId: "web-container", cpuCores: 1, memoryMb: 1024 },
  }));
  expect(api.resources).toMatchObject({ cpuCores: 2, memoryMb: 2048 });
  expect(h.upsertServiceDeployment).toHaveBeenCalledWith(expect.objectContaining({
    serviceId: "svc-api", allocatedResources: { containerId: "api-container", cpuCores: 2, memoryMb: 2048 },
  }));
  expect(publishRoute).toHaveBeenCalledWith("app.opsh.io", 30001, false, expect.objectContaining({ routes: [
    { match: { path: "/api/", type: "prefix" }, action: { kind: "proxy", workspace: "shared-vm", port: 30003 } },
    { match: { path: "/", type: "prefix" }, action: { kind: "proxy", workspace: "shared-vm", port: 30001 } },
  ] }));
});

const project = { id: "p1", slug: "app", organizationId: "org1" } as unknown as Project;
const dep = {
  id: "d1",
  organizationId: "org1",
  environment: "production",
} as unknown as Deployment;
const localHostPortTarget = {
  targetKey: "local" as const,
  legacyTargetKeys: [],
  stable: true,
};

async function demotedExecutor(): Promise<CommandExecutor> {
  const { executor } = await resolveServerExecutor("srv-local", "org1");
  return executor;
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  h.targetLockHeld = false;
  h.deploymentById.clear();
  h.probeDeployedReadiness.mockReset().mockResolvedValue({ failure: null });
  h.applyProjectRouting.mockReset().mockResolvedValue(undefined);
  h.reapplyProjectLiveRoutes.mockReset().mockResolvedValue(undefined);
  vi.spyOn(DockerRuntime.prototype, "prepareServiceCutover").mockResolvedValue(null);
  // These fixtures stub daemon I/O/activation and intentionally skip constructors.
  // Real volume preparation/cutover is covered by image-volume-persistence.e2e.
  vi.spyOn(DockerRuntime.prototype, "prepareServiceVolumes").mockResolvedValue(undefined);
  h.localImageRefs.clear();
  const inspectImage = async (ref: string) => {
    if (ref.startsWith("/")) throw new Error("invalid image reference");
    const repo = ref.split("@")[0]!.replace(/:[^/:]+$/, "");
    return { Id: IMAGE_ID, RepoDigests: h.localImageRefs.has(ref)
      ? [] : [`${repo}@sha256:${"b".repeat(64)}`] };
  };
  vi.spyOn(DockerRuntime.prototype as unknown as { inspectDeploymentImage: typeof inspectImage }, "inspectDeploymentImage")
    .mockImplementation(inspectImage);
  vi.spyOn(CloudDockerRuntime.prototype as unknown as { inspectDeploymentImage: typeof inspectImage }, "inspectDeploymentImage")
    .mockImplementation(inspectImage);
  vi.spyOn(DockerRuntime.prototype, "getContainerInfo").mockImplementation(async id => ({
    containerId: id, status: "running", imageId: IMAGE_ID, ip: "172.18.0.2",
  }));
  h.allocateAndReservePinnedHostPort.mockReset();
  h.releaseNewPinnedHostPortClaims.mockReset();
  h.services = [
    {
      id: "svc-web",
      projectId: "p1",
      name: "web",
      enabled: true,
      dependsOn: [],
      advanced: null,
      ports: ["8080"],
      image: "nginx:alpine",
      exposed: true,
      exposedPort: "8080",
      domainType: "custom",
      customDomain: "web.example.com",
      publicEndpoints: [],
    },
  ];
  h.previousServiceRows = [
    {
      id: "sd-old",
      deploymentId: "d-old",
      serviceId: "svc-web",
      serviceName: "web",
      containerId: "container-old",
      status: "success",
      imageRef: "nginx:alpine",
      ip: "172.18.0.2",
      hostPort: 30_000,
      hostPorts: { 8080: 30_000 },
    },
  ];
  h.previousDeployment = { id: "d-old", projectId: "p1", organizationId: "org1", containerId: "compose", createdAt: null };
  h.prepareTargetPinnedHostPorts.mockResolvedValue([]);
  h.allocateAndReservePinnedHostPort.mockImplementation(async (input) => ({
    port: 30_000,
    scanned: true,
    claimWasCreated: true,
    claim: {
      id: "hpc-web",
      targetKey: "local",
      ...input.owner,
      port: 30_000,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
  }));
  h.releaseNewPinnedHostPortClaims.mockResolvedValue(0);
  h.reserveResolvedLoopbackRoutes.mockResolvedValue([]);
  h.convergeTargetHostPortClaims.mockResolvedValue({ released: 0, retained: [] });
  h.convergeTargetHostPortClaimsUnlocked.mockResolvedValue({ released: 0, retained: [] });
  h.upsertServiceDeployment.mockResolvedValue(undefined);
  h.updateServiceDeployment.mockResolvedValue(undefined);
  h.startServiceDeploymentTiming.mockResolvedValue(undefined);
  h.finishStartedServiceDeploymentTimings.mockResolvedValue(undefined);
});

afterEach(() => vi.useRealTimers());

function addDisabledPreviousService() {
  h.services.push({
    id: "svc-disabled",
    projectId: "p1",
    name: "disabled",
    enabled: false,
    dependsOn: [],
    advanced: null,
    ports: ["9090"],
    image: "nginx:alpine",
    exposed: false,
    publicEndpoints: [],
  });
  h.previousServiceRows.push({
    id: "sd-disabled",
    deploymentId: "d-old",
    serviceId: "svc-disabled",
    serviceName: "disabled",
    containerId: "container-disabled",
    status: "success",
    imageRef: "nginx:alpine",
    ip: "172.18.0.4",
    hostPort: 30_001,
    hostPorts: { 9090: 30_001 },
  });
}

describe("compose deploy — host channel unavailable", () => {
  it("refreshes registry tags without restarting unchanged databases or apps", async () => {
    const f = imageRefreshFixture();
    const result = await f.run();
    expect(f.pull).toHaveBeenCalledTimes(2);
    expect(f.activate).not.toHaveBeenCalled();
    expect(f.runtime.destroy).not.toHaveBeenCalled();
    expect(result.summary.deployed).toBe(0);
    expect(result.services.every(service => service.carried)).toBe(true);
    expect(h.startServiceDeploymentTiming).not.toHaveBeenCalled();
    expect(h.finishStartedServiceDeploymentTimings).not.toHaveBeenCalled();
  });

  it("includes image preparation in a changed service's clock without timing the unchanged sibling", async () => {
    const f = imageRefreshFixture();
    const start = new Date("2026-10-20T10:00:00Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(start);
    f.pull.mockImplementation(async ref => {
      vi.setSystemTime(Date.now() + 10_000);
      if (ref === f.apiRef) f.images.set(ref, f.metadata(ref, f.nextId));
    });
    await f.run();
    expect(h.startServiceDeploymentTiming).toHaveBeenCalledExactlyOnceWith({
      deploymentId: dep.id, serviceId: "svc-api", serviceName: "api",
      startedAt: new Date(start.getTime() + 10_000),
    });
    expect(h.finishStartedServiceDeploymentTimings).not.toHaveBeenCalled();
    expect(f.activate).toHaveBeenCalledOnce();
    expect(f.pull).toHaveBeenCalledTimes(2);
  });

  it("settles only the failed image preparation attempt before returning its original refusal", async () => {
    const f = imageRefreshFixture();
    const start = new Date("2026-10-20T11:00:00Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(start);
    f.pull.mockImplementation(async ref => {
      vi.setSystemTime(Date.now() + 10_000);
      if (ref === f.apiRef) throw new Error("registry unavailable");
    });
    await expect(f.run()).rejects.toThrow("registry unavailable");
    expect(h.startServiceDeploymentTiming).toHaveBeenCalledExactlyOnceWith({
      deploymentId: dep.id, serviceId: "svc-api", serviceName: "api",
      startedAt: new Date(start.getTime() + 10_000),
    });
    expect(h.finishStartedServiceDeploymentTimings).toHaveBeenCalledExactlyOnceWith(
      dep.id, new Date(start.getTime() + 20_000),
    );
    expect(h.upsertServiceDeployment).not.toHaveBeenCalled();
    expect(f.activate).not.toHaveBeenCalled();
    expect(f.runtime.destroy).not.toHaveBeenCalled();
  });

  it("includes a shared image's single preparation in each selected service that activates", async () => {
    const f = imageRefreshFixture();
    const start = new Date("2026-10-20T12:00:00Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(start);
    h.services[0]!.image = f.apiRef;
    f.pull.mockImplementation(async ref => {
      vi.setSystemTime(Date.now() + 10_000);
      f.images.set(ref, f.metadata(ref, f.nextId));
    });
    await f.run({ targetServiceIds: new Set(["svc-db", "svc-api"]) });
    expect(f.pull).toHaveBeenCalledOnce();
    expect(h.startServiceDeploymentTiming).toHaveBeenCalledTimes(2);
    for (const [input] of h.startServiceDeploymentTiming.mock.calls)
      expect(input.startedAt).toEqual(start);
    expect(f.activate).toHaveBeenCalledTimes(2);
  });

  it("keeps strictly untargeted siblings outside preparation and activation clocks", async () => {
    const f = imageRefreshFixture();
    f.pull.mockImplementation(async ref => {
      f.images.set(ref, f.metadata(ref, f.nextId));
    });
    const result = await f.run({ targetServiceIds: new Set(["svc-api"]), strictScope: true });
    expect(f.pull).toHaveBeenCalledExactlyOnceWith(f.apiRef, { force: true, logger: f.logger });
    expect(h.startServiceDeploymentTiming).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ serviceId: "svc-api", startedAt: expect.any(Date) }),
    );
    expect(result.services).toContainEqual(
      expect.objectContaining({ serviceId: "svc-db", carried: true, containerId: "old-db" }),
    );
  });

  it("does not advertise an unchanged image again after a sibling update", async () => {
    const { isBehind } = await import("@repo/core");
    const f = imageRefreshFixture();
    h.previousServiceRows[0]!.imageRef = "postgres:16.15";
    h.previousServiceRows[0]!.imageDigest = `postgres@${f.dbId}`;
    f.pull.mockImplementation(async (ref) => {
      f.images.set(ref, f.metadata(ref, f.nextId));
    });

    await f.run({ targetServiceIds: new Set(["svc-api"]), strictScope: true }, "update");

    const carried = h.upsertServiceDeployment.mock.calls
      .map(([row]) => row)
      .find((row) => row.serviceId === "svc-db");
    const current = { kind: "image" as const, ref: carried.imageRef, digest: carried.imageDigest };
    expect(isBehind(current, { kind: "image", ref: f.dbRef, digest: f.dbId })).toBe(false);
    expect(isBehind(current, { kind: "image", ref: f.dbRef, digest: f.nextId })).toBe(true);
    expect(f.runtime.destroy).not.toHaveBeenCalledWith("old-db");
  });

  it("applies a project replica change even when service image and configuration are unchanged", async () => {
    const f = imageRefreshFixture();
    h.previousDeployment.meta = { clusterConfig: { replicas: 2 } };
    const result = await deployComposeServices(
      { ...project, activeDeploymentId: "d-old", routeStrategy: "container-ip" } as Project,
      { ...dep, meta: { clusterConfig: { replicas: 3 } } }, f.runtime, f.logger,
    );
    expect(result.status).toBe("ready");
    expect(f.activate).toHaveBeenCalledTimes(2);
    expect(result.services.some(service => service.carried)).toBe(false);
  });

  it("recreates only changed image content and deploys the immutable image acquired", async () => {
    const f = imageRefreshFixture();
    f.pull.mockImplementation(async ref => {
      if (ref === f.apiRef) f.images.set(ref, f.metadata(ref, f.nextId));
    });
    const result = await f.run();
    expect(result.status).toBe("ready");
    expect(f.activate).toHaveBeenCalledOnce();
    expect(f.activate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      serviceName: "api", image: `ghcr.io/acme/api@${f.nextId}`, imageAlreadyPrepared: true, forcePull: false,
    }), expect.anything());
    expect(result.services).toContainEqual(expect.objectContaining({ serviceId: "svc-db", carried: true, containerId: "old-db" }));
    expect(h.upsertServiceDeployment).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: "svc-api", imageRef: f.apiRef, imageDigest: `ghcr.io/acme/api@${f.nextId}`,
    }));
  });

  it("keeps existing replacement order when overlap prerequisites are unavailable", async () => {
    const f = imageRefreshFixture();
    f.pull.mockImplementation(async ref => {
      if (ref === f.apiRef) f.images.set(ref, f.metadata(ref, f.nextId));
    });
    const result = await f.run();
    expect(result.status).toBe("ready");
    expect(f.runtime.destroy).toHaveBeenCalledWith("old-api");
    expect(vi.mocked(f.runtime.destroy).mock.invocationCallOrder[0]).toBeLessThan(
      f.activate.mock.invocationCallOrder[0]!,
    );
  });

  function stagedFixture() {
    const f = imageRefreshFixture();
    h.services = h.services.filter(service => service.id === "svc-api");
    Object.assign(h.services[0]!, { ports: ["8080"], exposed: true, exposedPort: "8080",
      customDomain: "api.example.com", domainType: "custom", dependsOn: [],
      advanced: { resources: { cpuCores: 1, memoryMb: 512 } } });
    h.previousServiceRows = h.previousServiceRows.filter(row => row.serviceId === "svc-api");
    h.previousDeployment.meta = { port: 8080, composeServices: structuredClone(h.services) };
    const publish = vi.fn(async () => ({ ip: "172.18.0.4" }));
    const retire = vi.fn(async () => undefined);
    const prepared = vi.mocked(f.runtime.prepareServiceCutover).mockImplementation(async (_group, config) => ({
      config: { ...config }, previousContainerId: "old-api", previousDeploymentId: "d-old", publish, retire,
    }));
    f.runtime.sampleStability = vi.fn(async () => ({ state: "running" as const, exitCode: null, restartCount: 0,
      health: null, errorLine: null, oomKilled: false, restartPolicy: "always" }));
    f.pull.mockImplementation(async ref => {
      if (ref === f.apiRef) f.images.set(ref, f.metadata(ref, f.nextId));
    });
    const registerRoute = vi.fn(async () => undefined);
    const routingOptions = { hostPortTarget: localHostPortTarget,
      executor: { exec: vi.fn(async () => "") } as unknown as CommandExecutor,
      routing: { registerRoute, removeRoute: vi.fn() } as never,
      ssl: { provisionCert: vi.fn(), verifyCert: vi.fn() } as never, usesManagedRouting: false };
    return { ...f, publish, retire, prepared, registerRoute, routingOptions };
  }

  it("retires a verified candidate's predecessor only after all routing and persistence", async () => {
    const f = stagedFixture();
    const result = await f.run(f.routingOptions);
    expect(result.status).toBe("ready");
    expect(f.publish).toHaveBeenCalledWith("new-api");
    expect(f.runtime.destroy).not.toHaveBeenCalledWith("old-api");
    expect(f.retire).not.toHaveBeenCalled();
    await result.cutover?.commit();
    expect(f.retire).toHaveBeenCalledWith("new-api");
    expect(f.retire.mock.invocationCallOrder[0]).toBeGreaterThan(h.upsertServiceDeployment.mock.invocationCallOrder.at(-1)!);
    expect(f.retire.mock.invocationCallOrder[0]).toBeGreaterThan(f.registerRoute.mock.invocationCallOrder.at(-1)!);
    expect(h.upsertServiceDeployment).toHaveBeenCalledWith(expect.objectContaining({ serviceId: "svc-api", ip: "172.18.0.4" }));
  });

  it.each(["changed port", "unknown snapshot", "unowned snapshot"])("keeps normal replacement for %s", async reason => {
    const f = stagedFixture();
    if (reason === "changed port") Object.assign(h.services[0]!, { exposedPort: "9090", ports: ["9090"] });
    if (reason === "unknown snapshot") h.previousDeployment.meta = {};
    if (reason === "unowned snapshot") {
      h.deploymentById.set("d-unowned", { ...h.previousDeployment, id: "d-unowned",
        organizationId: "another-organization" });
      f.prepared.mockImplementation(async (_group, config) => ({ config: { ...config },
        previousContainerId: "old-api", previousDeploymentId: "d-unowned",
        publish: f.publish, retire: f.retire }));
    }
    const result = await f.run(f.routingOptions);
    expect(result.cutover).toBeUndefined();
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.retire).not.toHaveBeenCalled();
  });

  it("includes a composite route's additional upstream in the predecessor port proof", async () => {
    const f = stagedFixture();
    const result = await f.run(f.routingOptions, "manual", { compositeRoutes: [{
      hostname: "api.example.com", isCustomDomain: true, rootServiceId: "svc-api",
      rootPort: 8080, locations: [{ pathPrefix: "/other", serviceId: "svc-api", port: 9090 }],
    }] });
    expect(f.prepared).toHaveBeenCalled();
    expect(result.cutover).toBeUndefined();
    expect(f.publish).not.toHaveBeenCalled();
  });

  it("checks a carried container's own deployment instead of the active release's pending port edit", async () => {
    const f = stagedFixture();
    h.deploymentById.set("d-container-owner", { ...h.previousDeployment, id: "d-container-owner" });
    Object.assign(h.services[0]!, { exposedPort: "9090", ports: ["9090"] });
    h.previousDeployment.meta = { port: 9090, composeServices: structuredClone(h.services) };
    f.prepared.mockImplementation(async (_group, config) => ({ config: { ...config },
      previousContainerId: "old-api", previousDeploymentId: "d-container-owner",
      publish: f.publish, retire: f.retire }));
    const result = await f.run(f.routingOptions);
    expect(result.cutover).toBeUndefined();
    expect(f.publish).not.toHaveBeenCalled();
  });

  it("waits for the final composite route before retiring the old container", async () => {
    const f = stagedFixture();
    f.registerRoute.mockImplementation(async () => { expect(f.retire).not.toHaveBeenCalled(); });
    const result = await f.run(f.routingOptions, "manual", { compositeRoutes: [{
      hostname: "api.example.com", isCustomDomain: true, rootServiceId: "svc-api", locations: [],
    }] });
    expect(result.status).toBe("ready");
    expect(f.registerRoute.mock.calls.length).toBeGreaterThan(1);
    expect(f.retire).not.toHaveBeenCalled();
    await result.cutover?.commit();
    expect(f.retire.mock.invocationCallOrder[0]).toBeGreaterThan(f.registerRoute.mock.invocationCallOrder.at(-1)!);
  });

  it("restores the incumbent before cleanup when a composite route fails after a service route succeeded", async () => {
    const f = stagedFixture();
    f.registerRoute.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("composite edge reload failed"));
    h.applyProjectRouting.mockImplementation(async () => {
      expect(h.targetLockHeld).toBe(false);
      expect(f.runtime.destroy).not.toHaveBeenCalledWith("new-api");
      expect(f.retire).not.toHaveBeenCalled();
    });
    const result = await f.run(f.routingOptions, "manual", { compositeRoutes: [{
      hostname: "api.example.com", isCustomDomain: true, rootServiceId: "svc-api", locations: [],
    }] });
    expect(f.registerRoute).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("failed");
    expect(result.routeWarnings?.join(" ")).toContain("composite edge reload failed");
    expect(result.cutover).toBeUndefined();
    expect(f.retire).not.toHaveBeenCalled();
    expect(f.runtime.destroy).not.toHaveBeenCalledWith("old-api");
    expect(f.runtime.destroy).toHaveBeenCalledWith("new-api");
    expect(h.applyProjectRouting.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(f.runtime.destroy).mock.invocationCallOrder[0]!,
    );
  });

  it("keeps the incumbent when an existing composite shape cannot resolve its frontend hostname", async () => {
    const f = stagedFixture();
    Object.assign(h.services[0]!, { kind: "monorepo", framework: "nextjs", startCommand: "node server.js" });
    h.services.push({ id: "svc-front", projectId: "p1", name: "front", image: f.apiRef, enabled: true,
      kind: "monorepo", framework: "vite", startCommand: null, updatedAt: new Date(0), dependsOn: [],
      advanced: null, ports: [], exposed: false });
    h.previousServiceRows.push({ id: "sd-front", deploymentId: "d-old", serviceId: "svc-front", serviceName: "front",
      containerId: "old-front", imageRef: f.apiRef, status: "success", ip: "172.18.0.2" });
    const result = await f.run({ ...f.routingOptions, targetServiceIds: new Set(["svc-api"]) });
    expect(f.prepared).toHaveBeenCalledOnce();
    expect(result.status).toBe("failed");
    expect(result.routeWarnings?.join(" ")).toContain("could not resolve every upstream and hostname");
    expect(f.retire).not.toHaveBeenCalled();
    expect(f.runtime.destroy).not.toHaveBeenCalledWith("old-api");
    expect(h.applyProjectRouting).toHaveBeenCalled();
    expect(f.runtime.destroy).toHaveBeenCalledWith("new-api");
  });

  it.each([{ failure: "candidate is not ready" }, { failure: null, skipped: "host probe unavailable" }])(
    "keeps the old container and never publishes a failed or unverifiable candidate (%j)", async verdict => {
      const f = stagedFixture();
      h.probeDeployedReadiness.mockResolvedValue(verdict);
      await f.run(f.routingOptions);
      expect(f.publish).not.toHaveBeenCalled();
      expect(f.retire).not.toHaveBeenCalled();
      expect(f.runtime.destroy).not.toHaveBeenCalledWith("old-api");
      expect(f.runtime.destroy).toHaveBeenCalledWith("new-api");
    },
  );

  it("restores previous routing before reaping a candidate cancelled after partial route writes", async () => {
    const f = stagedFixture();
    const controller = new AbortController();
    f.registerRoute.mockImplementation(async () => { controller.abort(); });
    h.applyProjectRouting.mockImplementation(async () => {
      expect(h.targetLockHeld).toBe(false);
      expect(f.runtime.destroy).not.toHaveBeenCalledWith("new-api");
    });
    await expect(f.run({ ...f.routingOptions, signal: controller.signal })).rejects.toThrow("cancelled");
    expect(h.applyProjectRouting).toHaveBeenCalledWith("p1", expect.anything());
    expect(f.retire).not.toHaveBeenCalled();
    expect(f.runtime.destroy).not.toHaveBeenCalledWith("old-api");
    expect(f.runtime.destroy).toHaveBeenCalledWith("new-api");
    expect(h.applyProjectRouting.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(f.runtime.destroy).mock.invocationCallOrder[0]!,
    );
  });

  it("preserves both containers and tracks the candidate when routing restoration fails", async () => {
    const f = stagedFixture();
    const controller = new AbortController();
    f.registerRoute.mockImplementation(async () => { controller.abort(); });
    h.applyProjectRouting.mockRejectedValue(new Error("edge is unavailable"));
    await expect(f.run({ ...f.routingOptions, signal: controller.signal })).rejects.toThrow("Both containers were preserved");
    expect(f.runtime.destroy).not.toHaveBeenCalled();
    expect(f.retire).not.toHaveBeenCalled();
    expect(h.upsertServiceDeployment).toHaveBeenCalledWith(expect.objectContaining({
      containerId: "new-api", status: "failed", errorMessage: expect.stringContaining("Routing recovery incomplete"),
    }));
  });

  it("preserves both containers after a recovery deadline without abandoning the active route writer", async () => {
    const f = stagedFixture();
    const result = await f.run(f.routingOptions);
    let releaseRoute!: () => void;
    const routeSettled = new Promise<void>(resolve => { releaseRoute = resolve; });
    let routeStarted!: () => void;
    const started = new Promise<void>(resolve => { routeStarted = resolve; });
    h.reapplyProjectLiveRoutes.mockImplementation(async () => {
      routeStarted();
      await routeSettled;
    });
    const setTimeout = globalThis.setTimeout;
    let expire!: () => void;
    const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => {
      if (delay === 30_000) expire = () => (callback as () => void)();
      return setTimeout(callback, delay, ...args);
    });
    try {
      let released = false;
      const recovery = result.cutover!.rollback().finally(() => { released = true; });
      await started;
      expire();
      await Promise.resolve();
      expect(released).toBe(false);
      expect(f.runtime.destroy).not.toHaveBeenCalled();
      releaseRoute();
      await expect(recovery).resolves.toBe(false);
      expect(h.applyProjectRouting).not.toHaveBeenCalled();
      expect(f.retire).not.toHaveBeenCalled();
      expect(f.runtime.destroy).not.toHaveBeenCalled();
      expect(h.upsertServiceDeployment).toHaveBeenCalledWith(expect.objectContaining({
        containerId: "new-api", status: "failed", errorMessage: expect.stringContaining("routing recovery timed out"),
      }));
    } finally {
      releaseRoute();
      timer.mockRestore();
    }
  });

  it("does not retire the predecessor when route registration reports a warning", async () => {
    const f = stagedFixture();
    f.registerRoute.mockRejectedValue(new Error("edge reload failed"));
    const result = await f.run(f.routingOptions);
    expect(result.routeWarnings?.join(" ")).toContain("edge reload failed");
    expect(result.status).toBe("failed");
    expect(h.applyProjectRouting).toHaveBeenCalled();
    expect(f.retire).not.toHaveBeenCalled();
    expect(f.runtime.destroy).not.toHaveBeenCalledWith("old-api");
    expect(f.runtime.destroy).toHaveBeenCalledWith("new-api");
  });

  it("keeps larger cohorts on their existing path without preparing overlap", async () => {
    const f = imageRefreshFixture();
    f.pull.mockImplementation(async ref => { f.images.set(ref, f.metadata(ref, f.nextId)); });
    await f.run();
    expect(f.runtime.prepareServiceCutover).not.toHaveBeenCalled();
    expect(f.runtime.destroy).toHaveBeenCalledWith("old-api");
    expect(f.runtime.destroy).toHaveBeenCalledWith("old-db");
  });

  it("aborts the whole cohort when a later registry pull fails, preserving every old service", async () => {
    const f = imageRefreshFixture();
    f.pull.mockImplementation(async ref => {
      if (ref === f.dbRef) f.images.set(ref, f.metadata(ref, f.nextId));
      else throw new Error("registry unavailable");
    });
    await expect(f.run()).rejects.toThrow("registry unavailable");
    expect(f.activate).not.toHaveBeenCalled();
    expect(f.runtime.destroy).not.toHaveBeenCalled();
    expect(h.upsertServiceDeployment).not.toHaveBeenCalled();
  });

  it("a selected image build failure blocks every other service before activation", async () => {
    const f = imageRefreshFixture();
    await expect(f.run({ buildFailures: new Map([["svc-api", "Dockerfile build failed"]]) }))
      .rejects.toThrow("Image preparation failed for api");
    expect(f.pull).not.toHaveBeenCalled();
    expect(f.activate).not.toHaveBeenCalled();
    expect(f.runtime.destroy).not.toHaveBeenCalled();
  });

  it("a missing selected image blocks the cohort instead of leaving a partial rollout", async () => {
    const f = imageRefreshFixture();
    h.services[1]!.image = null;
    h.previousServiceRows[1]!.imageRef = null;
    await expect(f.run()).rejects.toThrow("No image is available for api");
    expect(f.pull).not.toHaveBeenCalled();
    expect(f.activate).not.toHaveBeenCalled();
  });

  it("refuses to restart a database when its running image cannot be determined", async () => {
    const f = imageRefreshFixture();
    vi.mocked(f.runtime.getContainerInfo).mockResolvedValue({ containerId: "old-db", status: "running" });
    await expect(f.run()).rejects.toThrow("Cannot inspect the running image for db");
    expect(f.pull).not.toHaveBeenCalled();
    expect(f.activate).not.toHaveBeenCalled();
  });

  it("acquires a missing digest-pinned image before any earlier service can cut over", async () => {
    const f = imageRefreshFixture();
    const pinned = `ghcr.io/acme/api@${f.nextId}`;
    h.services[1]!.image = pinned;
    f.pull.mockImplementation(async ref => {
      if (ref === pinned) throw new Error("pinned image unavailable");
      f.images.set(ref, f.metadata(ref, f.nextId));
    });
    await expect(f.run()).rejects.toThrow("pinned image unavailable");
    expect(f.pull).toHaveBeenCalledWith(pinned, { force: false, logger: f.logger });
    expect(f.activate).not.toHaveBeenCalled();
    expect(f.runtime.destroy).not.toHaveBeenCalled();
  });

  it("cancellation during preparation leaves every source container running", async () => {
    const f = imageRefreshFixture();
    const controller = new AbortController();
    f.pull.mockImplementation(async () => { controller.abort(); });
    await expect(f.run({ signal: controller.signal })).rejects.toThrow("cancelled");
    expect(f.pull).toHaveBeenCalledTimes(1);
    expect(f.activate).not.toHaveBeenCalled();
    expect(f.runtime.destroy).not.toHaveBeenCalled();
    expect(h.startServiceDeploymentTiming).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ serviceId: "svc-db", startedAt: expect.any(Date) }),
    );
    expect(h.finishStartedServiceDeploymentTimings).toHaveBeenCalledExactlyOnceWith(dep.id, expect.any(Date));
  });

  it("prepares a shared registry tag once and freezes every selected service to it", async () => {
    const f = imageRefreshFixture();
    h.services[0]!.image = f.apiRef;
    f.pull.mockImplementation(async ref => { f.images.set(ref, f.metadata(ref, f.nextId)); });
    await f.run({ targetServiceIds: new Set(["svc-db", "svc-api"]) });
    expect(f.pull).toHaveBeenCalledExactlyOnceWith(f.apiRef, { force: true, logger: f.logger });
    expect(f.activate).toHaveBeenCalledTimes(2);
    expect(f.activate.mock.calls.every(call => call[1].image === `ghcr.io/acme/api@${f.nextId}`)).toBe(true);
  });

  it("captures a pinned shared tag before another service refreshes it", async () => {
    const f = imageRefreshFixture();
    h.services[0]!.image = f.apiRef;
    f.pull.mockImplementation(async ref => { f.images.set(ref, f.metadata(ref, f.nextId)); });
    await f.run({ targetServiceIds: new Set(["svc-db", "svc-api"]),
      preparedLocalImages: new Map([["svc-db", f.apiRef]]) });
    expect(f.pull).toHaveBeenCalledTimes(1);
    expect(f.activate.mock.calls.map(call => call[1].image)).toEqual([
      `ghcr.io/acme/api@${f.apiId}`, `ghcr.io/acme/api@${f.nextId}`,
    ]);
  });

  it("prepares an untargeted namespace dependent before its provider can be replaced", async () => {
    const f = imageRefreshFixture();
    h.services[1]!.advanced = { networkMode: "service:db" };
    f.images.set(f.apiId, { Id: f.apiId, RepoDigests: [] });
    const result = await f.run({ targetServiceIds: new Set(["svc-db"]) });
    expect(result.status).toBe("ready");
    expect(f.inspect).toHaveBeenCalledWith(f.apiId);
    expect(f.pull).toHaveBeenCalledExactlyOnceWith(f.dbRef, { force: true, logger: f.logger });
    expect(f.activate.mock.calls.map(call => call[1].image)).toEqual([`postgres@${f.dbId}`, f.apiId]);
    expect(f.inspect.mock.invocationCallOrder[0]).toBeLessThan(f.activate.mock.invocationCallOrder[0]!);
  });

  it("an unavailable namespace-dependent image aborts before the provider is touched", async () => {
    const f = imageRefreshFixture();
    h.services[1]!.advanced = { networkMode: "service:db" };
    await expect(f.run({ targetServiceIds: new Set(["svc-db"]) })).rejects.toThrow("Retained image");
    expect(f.pull).not.toHaveBeenCalled();
    expect(f.activate).not.toHaveBeenCalled();
    expect(f.runtime.destroy).not.toHaveBeenCalled();
  });

  it("reuses rollback artifacts even when a force-pull hint survived in the caller", async () => {
    const f = imageRefreshFixture();
    await f.run({ forcePullImages: true }, "rollback");
    expect(f.pull).not.toHaveBeenCalled();
    expect(f.activate).toHaveBeenCalledTimes(2);
  });
  it.each([
    { image: "openship/app-api:bld_previous", rowImage: null, build: "./api" },
    { image: "openship/app-api:bld_previous", rowImage: "ghcr.io/acme/api:latest", build: "./api" },
    { image: "my-private-app:local", rowImage: "my-private-app:local", build: null },
  ])("manual reuse of cached local image $image does not require a registry", async ({ image, rowImage, build }) => {
    h.localImageRefs.add(image);
    const { DockerRuntime } = await import("@repo/adapters");
    const pullImage = vi.fn(async (_ref: string, options?: { force?: boolean }) => {
      if (options?.force) throw new Error("local image exists, but no registry publishes this tag");
    });
    const deployServiceWorkload = vi.fn(async () => ({
      status: "running", containerId: "container-new-api", ip: "172.18.0.3",
    }));
    const runtime = Object.assign(Object.create(DockerRuntime.prototype), {
      name: "docker", unsupportedComposeKeys: new Set(),
      supports: (cap: string) => cap === "containerIp" || cap === "containerInfo",
      ensureServiceGroup: vi.fn(async () => ({ id: "group-1" })),
      getContainerInfo: vi.fn(async (id: string) => ({
        containerId: id, status: "running", ip: "172.18.0.2",
      })),
      getContainerIp: vi.fn(async () => "172.18.0.3"),
      destroy: vi.fn(async () => undefined), pullImage, deployServiceWorkload,
    }) as DockerRuntimeType;
    h.services = [{
      id: "svc-api", projectId: "p1", name: "api", image: rowImage, build,
      enabled: true, dependsOn: [], advanced: null, ports: [], exposed: false,
    }];
    h.previousServiceRows = [{
      id: "sd-api", deploymentId: "d-old", serviceId: "svc-api", serviceName: "api",
      containerId: "container-old-api", status: "success", imageRef: image,
      ip: "172.18.0.2",
    }];
    const { logger } = recordingLogger();
    const result = await deployComposeServices(
      { ...project, activeDeploymentId: "d-old", routeStrategy: "container-ip" } as Project,
      { ...dep, trigger: "manual" }, runtime, logger,
      { targetServiceIds: new Set(["svc-api"]) },
    );
    expect(result.status).toBe("ready");
    expect(pullImage).not.toHaveBeenCalledWith(image, { force: true, logger });
    expect(deployServiceWorkload).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      image: IMAGE_ID, forcePull: false,
    }), expect.anything());
  });

  it.each([false, true])("preserves a carried container's allocation rather than its unapplied settings (live inspect: %s)", async inspect => {
    const runtime = carriedRuntime();
    const allocatedResources = { containerId: "container-old", cpuCores: 2, memoryMb: 2048 };
    h.previousServiceRows[0]!.allocatedResources = allocatedResources;
    h.services[0]!.advanced = { resources: { cpuCores: 32, memoryMb: 32768 } };
    if (inspect) vi.mocked(runtime.getContainerInfo).mockResolvedValue({ containerId: "container-old", status: "running",
      resources: { cpuCores: 1, memoryMb: 1024 }, ip: "172.18.0.2" });
    const { logger } = recordingLogger();
    const result = await deployComposeServices({ ...project, activeDeploymentId: "d-old", routeStrategy: "container-ip" },
      dep, runtime, logger, { targetServiceIds: new Set(), hostPortTarget: localHostPortTarget,
        executor: { exec: vi.fn(async () => "") } as never });
    expect(result.status).toBe("ready");
    expect(h.upsertServiceDeployment).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: "svc-web", containerId: "container-old",
      allocatedResources: inspect ? { containerId: "container-old", cpuCores: 1, memoryMb: 1024 } : allocatedResources,
    }));
  });
  it("aborts an exact cohort before activation when a later service is missing required env", async () => {
    const runtime = startingRuntime();
    const deployServiceWorkload = vi.mocked(runtime.deployServiceWorkload);
    h.services = [
      {
        id: "svc-api",
        projectId: "p1",
        name: "api",
        enabled: true,
        dependsOn: [],
        advanced: null,
        ports: [],
        image: "ghcr.io/acme/api:staging",
        environment: {},
        exposed: false,
      },
      {
        id: "svc-worker",
        projectId: "p1",
        name: "worker",
        enabled: true,
        dependsOn: [],
        advanced: { environmentTemplateKeys: ["TOKEN"] },
        ports: [],
        image: "ghcr.io/acme/worker:staging",
        environment: { TOKEN: "${TOKEN:?TOKEN is required}" },
        exposed: false,
      },
    ];
    h.previousServiceRows = [];

    const { logger } = recordingLogger();
    await expect(
      deployComposeServices(
        { ...project, activeDeploymentId: "d-old", routeStrategy: "container-ip" } as never,
        dep,
        runtime,
        logger,
        {
          targetServiceIds: new Set(["svc-api", "svc-worker"]),
          strictScope: true,
        },
      ),
    ).rejects.toThrow(/aborted before cutover.*worker.*TOKEN/s);

    expect(deployServiceWorkload).not.toHaveBeenCalled();
  });

  it("reserves every exact-cohort host port before activation and rolls back on failure", async () => {
    const runtime = startingRuntime();
    const deployServiceWorkload = vi.mocked(runtime.deployServiceWorkload);
    h.services = [
      {
        id: "svc-api",
        projectId: "p1",
        name: "api",
        enabled: true,
        dependsOn: [],
        advanced: null,
        ports: ["3000"],
        image: "ghcr.io/acme/api:staging",
        exposed: true,
        exposedPort: "3000",
        domainType: "custom",
        customDomain: "api.example.com",
      },
      {
        id: "svc-worker",
        projectId: "p1",
        name: "worker",
        enabled: true,
        dependsOn: [],
        advanced: null,
        ports: ["4000"],
        image: "ghcr.io/acme/worker:staging",
        exposed: true,
        exposedPort: "4000",
        domainType: "custom",
        customDomain: "worker.example.com",
      },
    ];
    h.previousServiceRows = [];
    const firstAllocation = {
      port: 30_000,
      scanned: true,
      claim: {
        id: "hpc-api",
        targetKey: "local",
        projectId: "p1",
        serviceId: "svc-api",
        containerPort: 3000,
        port: 30_000,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    };
    h.allocateAndReservePinnedHostPort
      .mockResolvedValueOnce(firstAllocation)
      .mockRejectedValueOnce(new Error("no host port available"));

    const { logger } = recordingLogger();
    await expect(
      deployComposeServices(
        { ...project, activeDeploymentId: "d-old", routeStrategy: "loopback-port" } as never,
        dep,
        runtime,
        logger,
        {
          executor: {} as CommandExecutor,
          hostPortTarget: localHostPortTarget,
          targetServiceIds: new Set(["svc-api", "svc-worker"]),
          strictScope: true,
          routing: {
            registerRoute: vi.fn(async () => undefined),
            removeRoute: vi.fn(async () => undefined),
          } as never,
          ssl: {
            provisionCert: vi.fn(async () => ({ verified: false })),
            renewCert: vi.fn(),
            verifyCert: vi.fn(),
            installCert: vi.fn(),
          } as never,
          usesManagedRouting: true,
        },
      ),
    ).rejects.toThrow(/aborted before cutover.*no host port available/s);

    expect(h.allocateAndReservePinnedHostPort).toHaveBeenCalledTimes(2);
    expect(h.releaseNewPinnedHostPortClaims).toHaveBeenCalledWith(localHostPortTarget, [
      firstAllocation,
    ]);
    expect(deployServiceWorkload).not.toHaveBeenCalled();
  });

  it("accepts a relocated port during full-redeploy preflight before replacing any service", async () => {
    const runtime = startingRuntime();
    const deployServiceWorkload = vi.mocked(runtime.deployServiceWorkload);
    const destroy = vi.mocked(runtime.destroy);
    h.services = [
      {
        id: "svc-postgres",
        projectId: "p1",
        name: "postgres",
        enabled: true,
        dependsOn: [],
        advanced: null,
        ports: ["5432"],
        image: "postgres:16",
        exposed: false,
        publicEndpoints: [],
      },
      {
        id: "svc-redis",
        projectId: "p1",
        name: "redis",
        enabled: true,
        dependsOn: [],
        advanced: null,
        ports: ["6379"],
        image: "redis:7",
        exposed: false,
        publicEndpoints: [],
      },
      {
        id: "svc-api",
        projectId: "p1",
        name: "api",
        enabled: true,
        dependsOn: ["postgres", "redis"],
        advanced: null,
        ports: ["3000"],
        image: "ghcr.io/acme/api:next",
        exposed: true,
        exposedPort: "3000",
        domainType: "custom",
        customDomain: "api.example.com",
        publicEndpoints: [],
      },
    ];
    h.previousServiceRows = [
      {
        id: "sd-postgres",
        deploymentId: "d-old",
        serviceId: "svc-postgres",
        serviceName: "postgres",
        containerId: "container-postgres",
        status: "success",
        imageRef: "postgres:16",
      },
      {
        id: "sd-redis",
        deploymentId: "d-old",
        serviceId: "svc-redis",
        serviceName: "redis",
        containerId: "container-redis",
        status: "success",
        imageRef: "redis:7",
      },
      {
        id: "sd-api",
        deploymentId: "d-old",
        serviceId: "svc-api",
        serviceName: "api",
        containerId: "container-api",
        status: "success",
        imageRef: "ghcr.io/acme/api:old",
        hostPort: 20_008,
        hostPorts: { 3000: 20_008 },
      },
    ];
    const apiReplacement = {
      port: 20_001,
      preferred: 20_008,
      scanned: true,
      claimWasCreated: true,
      previousClaim: {
        projectId: "p1",
        serviceId: "svc-api",
        containerPort: 3000,
        port: 20_008,
      },
      claim: {
        id: "hpc-api-replacement",
        targetKey: "local",
        projectId: "p1",
        serviceId: "svc-api",
        containerPort: 3000,
        port: 20_001,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    };
    // postgres and redis publish port-only specs, so they are pinned as well.
    const allocateOthers = h.allocateAndReservePinnedHostPort.getMockImplementation()!;
    h.allocateAndReservePinnedHostPort.mockImplementation(async (input) =>
      input.owner.serviceId === "svc-api" ? apiReplacement : allocateOthers(input),
    );

    const { logger } = recordingLogger();
    const result = await deployComposeServices(
      { ...project, activeDeploymentId: "d-old", routeStrategy: "loopback-port" } as never,
      dep,
      runtime,
      logger,
      {
        executor: {} as CommandExecutor,
        hostPortTarget: localHostPortTarget,
        routing: {
          registerRoute: vi.fn(async () => undefined),
          removeRoute: vi.fn(async () => undefined),
        } as never,
        ssl: {
          provisionCert: vi.fn(async () => ({ verified: false })),
          renewCert: vi.fn(),
          verifyCert: vi.fn(),
          installCert: vi.fn(),
        } as never,
        usesManagedRouting: true,
      },
    );

    expect(result.status).toBe("ready");
    expect(h.allocateAndReservePinnedHostPort.mock.invocationCallOrder[0]).toBeLessThan(
      deployServiceWorkload.mock.invocationCallOrder[0]!,
    );
    const apiAllocation = h.allocateAndReservePinnedHostPort.mock.calls.find(
      ([input]) => input.owner.serviceId === "svc-api",
    )![0];
    const occupancyPolicy = apiAllocation.reuseOccupiedPreferred as (port: number) => boolean;
    expect(occupancyPolicy(20_008)).toBe(false);
    expect(deployServiceWorkload).toHaveBeenCalledTimes(3);
    expect(destroy).toHaveBeenCalled();
    expect(h.upsertServiceDeployment).toHaveBeenCalled();
  });

  it("pins port-only publishes outside the ephemeral range instead of letting Docker pick", async () => {
    // Regression: an unrouted service publishing "8800" got `HostPort: ""`, so
    // Docker drew a fresh host port from the kernel's ephemeral range on every
    // deploy (56787 → 56792 → 56796) and the saved-port move never applied.
    const runtime = startingRuntime();
    const deployServiceWorkload = vi.mocked(runtime.deployServiceWorkload);
    h.services = [
      {
        id: "svc-hub",
        projectId: "p1",
        name: "hub",
        enabled: true,
        dependsOn: [],
        advanced: null,
        ports: ["8800", "8801/tcp", "5353/udp"],
        image: "ghcr.io/acme/hub:next",
        exposed: false,
        publicEndpoints: [],
      },
    ];
    h.previousServiceRows = [
      {
        id: "sd-hub",
        deploymentId: "d-old",
        serviceId: "svc-hub",
        serviceName: "hub",
        containerId: "container-hub",
        status: "success",
        imageRef: "ghcr.io/acme/hub:old",
        hostPorts: { 8800: 56_792, 8801: 56_793 },
      },
    ];
    const safePorts = new Map([
      [8800, 20_010],
      [8801, 20_011],
    ]);
    h.allocateAndReservePinnedHostPort.mockImplementation(async (input) => {
      const port = safePorts.get(input.owner.containerPort)!;
      return {
        port,
        preferred: input.cachedPreferred,
        scanned: true,
        claimWasCreated: true,
        claim: {
          id: `hpc-${input.owner.containerPort}`,
          targetKey: "local",
          ...input.owner,
          port,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        },
      };
    });

    const { logger } = recordingLogger();
    const result = await deployComposeServices(
      { ...project, activeDeploymentId: "d-old", routeStrategy: "loopback-port" } as never,
      dep,
      runtime,
      logger,
      { executor: {} as CommandExecutor, hostPortTarget: localHostPortTarget },
    );

    expect(result.status).toBe("ready");
    const owners = h.allocateAndReservePinnedHostPort.mock.calls.map(([input]) => ({
      containerPort: input.owner.containerPort,
      cachedPreferred: input.cachedPreferred,
    }));
    expect(owners).toEqual([
      { containerPort: 8800, cachedPreferred: 56_792 },
      { containerPort: 8801, cachedPreferred: 56_793 },
    ]);
    const [, config] = deployServiceWorkload.mock.calls[0]!;
    expect((config as { ports: string[] }).ports).toEqual([
      "5353/udp",
      "127.0.0.1:20010:8800",
      "127.0.0.1:20011:8801",
    ]);
    expect(h.upsertServiceDeployment).toHaveBeenCalledWith(
      expect.objectContaining({ serviceId: "svc-hub", hostPorts: { 8800: 20_010, 8801: 20_011 } }),
    );
  });

  it("recovers a stale active container id from one live Docker inventory before port reconciliation", async () => {
    const base = startingRuntime();
    const getContainerInfo = vi.fn();
    const runtime = {
      ...base,
      supports: (capability: string) =>
        capability === "containerIp" ||
        capability === "containerInfo" ||
        capability === "hostContainerQuery",
      listAllContainers: vi.fn(async () => [
        {
          id: "live-api-container",
          names: ["openship-app-api"],
          image: "ghcr.io/acme/api:old",
          imageId: "sha256:api",
          state: "running",
          status: "Up 2 hours",
          labels: { "openship.project": "p1", "openship.service": "api" },
          ports: [{ privatePort: 3000, publicPort: 20_008, type: "tcp", ip: "127.0.0.1" }],
          mounts: [],
          ip: "172.18.0.8",
        },
      ]),
      getContainerInfo,
    } as unknown as MultiServiceRuntimeAdapter;
    h.services = [
      {
        id: "svc-api",
        projectId: "p1",
        name: "api",
        enabled: true,
        dependsOn: [],
        advanced: null,
        ports: ["3000"],
        image: "ghcr.io/acme/api:next",
        exposed: true,
        exposedPort: "3000",
        domainType: "custom",
        customDomain: "api.example.com",
        publicEndpoints: [],
      },
    ];
    h.previousServiceRows = [
      {
        id: "sd-api",
        deploymentId: "d-old",
        serviceId: "svc-api",
        serviceName: "api",
        containerId: "stale-api-container",
        status: "success",
        imageRef: "ghcr.io/acme/api:old",
        hostPort: 20_008,
        hostPorts: { 3000: 20_008 },
      },
    ];
    h.allocateAndReservePinnedHostPort.mockRejectedValueOnce(new Error("halt after preflight"));

    const { logger } = recordingLogger();
    await expect(
      deployComposeServices(
        { ...project, activeDeploymentId: "d-old", routeStrategy: "loopback-port" } as never,
        dep,
        runtime,
        logger,
        {
          executor: {} as CommandExecutor,
          hostPortTarget: localHostPortTarget,
          routing: {
            registerRoute: vi.fn(async () => undefined),
            removeRoute: vi.fn(async () => undefined),
          } as never,
          ssl: {
            provisionCert: vi.fn(async () => ({ verified: false })),
            renewCert: vi.fn(),
            verifyCert: vi.fn(),
            installCert: vi.fn(),
          } as never,
          usesManagedRouting: true,
        },
      ),
    ).rejects.toThrow("halt after preflight");

    expect(h.updateServiceDeployment).toHaveBeenCalledWith(
      "sd-api",
      expect.objectContaining({
        containerId: "live-api-container",
        hostPorts: { 3000: 20_008 },
        ip: "172.18.0.8",
      }),
    );
    expect(h.prepareTargetPinnedHostPorts).toHaveBeenCalledWith(
      expect.objectContaining({
        verifiedCarriedHostPorts: [
          expect.objectContaining({
            owner: { projectId: "p1", serviceId: "svc-api", containerPort: 3000 },
            hostPort: 20_008,
            liveHostPortByContainerPort: { 3000: 20_008 },
          }),
        ],
      }),
    );
    expect(h.allocateAndReservePinnedHostPort).toHaveBeenCalledWith(
      expect.objectContaining({ reuseOccupiedPreferred: expect.any(Function) }),
    );
    const occupancyPolicy = h.allocateAndReservePinnedHostPort.mock.calls[0]![0]
      .reuseOccupiedPreferred as (port: number) => boolean;
    expect(occupancyPolicy(20_008)).toBe(true);
    expect(getContainerInfo).not.toHaveBeenCalled();
    expect(base.deployServiceWorkload).not.toHaveBeenCalled();
  });

  it("inspects a stopped carried container when the Docker inventory omits its bindings", async () => {
    const base = startingRuntime();
    const getContainerInfo = vi.fn(async (containerId: string) => ({
      containerId,
      status: "stopped" as const,
      hostPort: 20_007,
      hostPortByContainerPort: { 3000: 20_007 },
    }));
    const runtime = {
      ...base,
      supports: (capability: string) =>
        capability === "containerIp" ||
        capability === "containerInfo" ||
        capability === "hostContainerQuery",
      listAllContainers: vi.fn(async () => [
        {
          id: "stopped-web-container",
          names: ["openship-app-web"],
          image: "ghcr.io/acme/web:old",
          imageId: "sha256:web",
          state: "exited",
          status: "Exited (1) 2 minutes ago",
          labels: { "openship.project": "p1", "openship.service": "web" },
          // Docker's list endpoint may omit published bindings after stop. The
          // inspect endpoint above retains HostConfig.PortBindings.
          ports: [],
          mounts: [],
        },
      ]),
      getContainerInfo,
    } as unknown as MultiServiceRuntimeAdapter;
    h.services = [
      {
        id: "svc-web",
        projectId: "p1",
        name: "web",
        enabled: true,
        dependsOn: [],
        advanced: null,
        ports: ["3000"],
        image: "ghcr.io/acme/web:next",
        exposed: true,
        exposedPort: "3000",
        domainType: "custom",
        customDomain: "web.example.com",
        publicEndpoints: [],
      },
    ];
    h.previousServiceRows = [
      {
        id: "sd-web",
        deploymentId: "d-old",
        serviceId: "svc-web",
        serviceName: "web",
        containerId: "stopped-web-container",
        status: "success",
        imageRef: "ghcr.io/acme/web:old",
        hostPort: 20_007,
        hostPorts: { 3000: 20_007 },
      },
    ];
    h.allocateAndReservePinnedHostPort.mockRejectedValueOnce(new Error("halt after preflight"));
    const promptUser = vi.fn(async () => "abort");

    const { logger } = recordingLogger();
    await expect(
      deployComposeServices(
        { ...project, activeDeploymentId: "d-old", routeStrategy: "loopback-port" } as never,
        dep,
        runtime,
        logger,
        {
          executor: {} as CommandExecutor,
          hostPortTarget: localHostPortTarget,
          routing: {
            registerRoute: vi.fn(async () => undefined),
            removeRoute: vi.fn(async () => undefined),
          } as never,
          ssl: {
            provisionCert: vi.fn(async () => ({ verified: false })),
            renewCert: vi.fn(),
            verifyCert: vi.fn(),
            installCert: vi.fn(),
          } as never,
          usesManagedRouting: true,
          promptUser,
        },
      ),
    ).rejects.toThrow("halt after preflight");

    expect(getContainerInfo).toHaveBeenCalledTimes(1);
    expect(getContainerInfo).toHaveBeenCalledWith("stopped-web-container");
    expect(h.prepareTargetPinnedHostPorts).toHaveBeenCalledWith(
      expect.objectContaining({
        verifiedCarriedHostPorts: [
          expect.objectContaining({
            owner: { projectId: "p1", serviceId: "svc-web", containerPort: 3000 },
            hostPort: 20_007,
            liveHostPortByContainerPort: { 3000: 20_007 },
          }),
        ],
      }),
    );
    expect(h.allocateAndReservePinnedHostPort).toHaveBeenCalledWith(
      expect.objectContaining({
        cachedPreferred: 20_007,
        reuseOccupiedPreferred: expect.any(Function),
      }),
    );
    const occupancyPolicy = h.allocateAndReservePinnedHostPort.mock.calls[0]![0]
      .reuseOccupiedPreferred as (port: number) => boolean;
    expect(occupancyPolicy(20_007)).toBe(false);
    expect(base.deployServiceWorkload).not.toHaveBeenCalled();
  });

  it("refuses ambiguous duplicate containers before repairing or activating anything", async () => {
    const base = startingRuntime();
    const liveContainer = (id: string, name: string) => ({
      id,
      names: [name],
      image: "ghcr.io/acme/api:old",
      imageId: "sha256:api",
      state: "running",
      status: "Up 2 hours",
      labels: { "openship.project": "p1", "openship.service": "api" },
      ports: [{ privatePort: 3000, publicPort: 20_008, type: "tcp", ip: "127.0.0.1" }],
      mounts: [],
      ip: "172.18.0.8",
    });
    const runtime = {
      ...base,
      supports: (capability: string) =>
        capability === "containerIp" ||
        capability === "containerInfo" ||
        capability === "hostContainerQuery",
      listAllContainers: vi.fn(async () => [
        liveContainer("live-api-container-a", "openship-app-api-a"),
        liveContainer("live-api-container-b", "openship-app-api-b"),
      ]),
    } as unknown as MultiServiceRuntimeAdapter;
    h.services = [
      {
        id: "svc-api",
        projectId: "p1",
        name: "api",
        enabled: true,
        dependsOn: [],
        advanced: null,
        ports: ["3000"],
        image: "ghcr.io/acme/api:next",
        exposed: true,
        exposedPort: "3000",
        domainType: "custom",
        customDomain: "api.example.com",
        publicEndpoints: [],
      },
    ];
    h.previousServiceRows = [
      {
        id: "sd-api",
        deploymentId: "d-old",
        serviceId: "svc-api",
        serviceName: "api",
        containerId: "stale-api-container",
        status: "success",
        imageRef: "ghcr.io/acme/api:old",
        hostPort: 20_008,
        hostPorts: { 3000: 20_008 },
      },
    ];

    const { logger } = recordingLogger();
    await expect(
      deployComposeServices(
        { ...project, activeDeploymentId: "d-old", routeStrategy: "loopback-port" } as never,
        dep,
        runtime,
        logger,
        {
          executor: {} as CommandExecutor,
          hostPortTarget: localHostPortTarget,
        },
      ),
    ).rejects.toThrow(
      /more than one container matching active service "api".*no service activation/i,
    );

    expect(h.updateServiceDeployment).not.toHaveBeenCalled();
    expect(h.allocateAndReservePinnedHostPort).not.toHaveBeenCalled();
    expect(base.deployServiceWorkload).not.toHaveBeenCalled();
    expect(base.destroy).not.toHaveBeenCalled();
  });

  it("fails an inconclusive live inventory before any service activation", async () => {
    const base = startingRuntime();
    const runtime = {
      ...base,
      supports: (capability: string) =>
        capability === "containerIp" || capability === "hostContainerQuery",
      listAllContainers: vi.fn(async () => {
        throw new Error("Docker inventory channel timed out");
      }),
    } as unknown as MultiServiceRuntimeAdapter;

    const { logger } = recordingLogger();
    await expect(
      deployComposeServices(
        { ...project, activeDeploymentId: "d-old", routeStrategy: "loopback-port" } as never,
        dep,
        runtime,
        logger,
        {
          executor: {} as CommandExecutor,
          hostPortTarget: localHostPortTarget,
        },
      ),
    ).rejects.toThrow(/preflight could not verify.*no service activation was started.*timed out/i);

    expect(base.deployServiceWorkload).not.toHaveBeenCalled();
    expect(base.destroy).not.toHaveBeenCalled();
    expect(h.allocateAndReservePinnedHostPort).not.toHaveBeenCalled();
  });

  it("releases a target's preallocated host port when earlier carried bookkeeping throws", async () => {
    const runtime = startingRuntime();
    const deployServiceWorkload = vi.mocked(runtime.deployServiceWorkload);
    h.services = [
      {
        id: "svc-carried",
        projectId: "p1",
        name: "carried",
        enabled: true,
        dependsOn: [],
        advanced: null,
        ports: [],
        image: "redis:7",
        exposed: false,
      },
      {
        id: "svc-target",
        projectId: "p1",
        name: "target",
        enabled: true,
        dependsOn: [],
        advanced: null,
        ports: ["4000"],
        image: "ghcr.io/acme/target:staging",
        exposed: true,
        exposedPort: "4000",
        domainType: "custom",
        customDomain: "target.example.com",
      },
    ];
    h.previousServiceRows = [
      {
        id: "sd-carried",
        deploymentId: "d-old",
        serviceId: "svc-carried",
        serviceName: "carried",
        containerId: "container-carried",
        status: "success",
        imageRef: "redis:7",
      },
    ];
    const targetAllocation = {
      port: 30_001,
      scanned: true,
      claim: {
        id: "hpc-target",
        targetKey: "local",
        projectId: "p1",
        serviceId: "svc-target",
        containerPort: 4000,
        port: 30_001,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    };
    h.allocateAndReservePinnedHostPort.mockResolvedValueOnce(targetAllocation);
    h.upsertServiceDeployment.mockRejectedValueOnce(new Error("database unavailable"));

    const { logger } = recordingLogger();
    await expect(
      deployComposeServices(
        {
          ...project,
          activeDeploymentId: "d-old",
          routeStrategy: "loopback-port",
        } as never,
        dep,
        runtime,
        logger,
        {
          executor: {} as CommandExecutor,
          hostPortTarget: localHostPortTarget,
          targetServiceIds: new Set(["svc-target"]),
          strictScope: true,
          routing: {
            registerRoute: vi.fn(async () => undefined),
            removeRoute: vi.fn(async () => undefined),
          } as never,
          ssl: {
            provisionCert: vi.fn(async () => ({ verified: false })),
            renewCert: vi.fn(),
            verifyCert: vi.fn(),
            installCert: vi.fn(),
          } as never,
          usesManagedRouting: true,
        },
      ),
    ).rejects.toThrow("database unavailable");

    expect(h.releaseNewPinnedHostPortClaims).toHaveBeenCalledWith(localHostPortTarget, [
      targetAllocation,
    ]);
    expect(deployServiceWorkload).not.toHaveBeenCalled();
  });

  it("retains an activated claim but releases later preallocations when cancelled", async () => {
    const controller = new AbortController();
    const runtime = startingRuntime();
    const deployServiceWorkload = vi.mocked(runtime.deployServiceWorkload);
    deployServiceWorkload.mockImplementationOnce(async () => {
      controller.abort();
      return {
        status: "running",
        containerId: "container-api",
        ip: "172.18.0.3",
      };
    });
    h.services = [
      {
        id: "svc-api",
        projectId: "p1",
        name: "api",
        enabled: true,
        dependsOn: [],
        advanced: null,
        ports: ["3000"],
        image: "ghcr.io/acme/api:staging",
        exposed: true,
        exposedPort: "3000",
        domainType: "custom",
        customDomain: "api.example.com",
      },
      {
        id: "svc-worker",
        projectId: "p1",
        name: "worker",
        enabled: true,
        dependsOn: [],
        advanced: null,
        ports: ["4000"],
        image: "ghcr.io/acme/worker:staging",
        exposed: true,
        exposedPort: "4000",
        domainType: "custom",
        customDomain: "worker.example.com",
      },
    ];
    h.previousServiceRows = [];
    const apiAllocation = {
      port: 30_000,
      scanned: true,
      claim: {
        id: "hpc-api",
        targetKey: "local",
        projectId: "p1",
        serviceId: "svc-api",
        containerPort: 3000,
        port: 30_000,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    };
    const workerAllocation = {
      port: 30_001,
      scanned: true,
      claim: {
        id: "hpc-worker",
        targetKey: "local",
        projectId: "p1",
        serviceId: "svc-worker",
        containerPort: 4000,
        port: 30_001,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    };
    h.allocateAndReservePinnedHostPort
      .mockResolvedValueOnce(apiAllocation)
      .mockResolvedValueOnce(workerAllocation);

    const { logger } = recordingLogger();
    await expect(
      deployComposeServices(
        {
          ...project,
          activeDeploymentId: null,
          routeStrategy: "loopback-port",
        } as never,
        dep,
        runtime,
        logger,
        {
          executor: {} as CommandExecutor,
          hostPortTarget: localHostPortTarget,
          targetServiceIds: new Set(["svc-api", "svc-worker"]),
          strictScope: true,
          routing: {
            registerRoute: vi.fn(async () => undefined),
            removeRoute: vi.fn(async () => undefined),
          } as never,
          ssl: {
            provisionCert: vi.fn(async () => ({ verified: false })),
            renewCert: vi.fn(),
            verifyCert: vi.fn(),
            installCert: vi.fn(),
          } as never,
          usesManagedRouting: true,
          signal: controller.signal,
        },
      ),
    ).rejects.toThrow("Deployment cancelled");

    expect(deployServiceWorkload).toHaveBeenCalledTimes(1);
    expect(runtime.destroy).toHaveBeenCalledWith("container-api");
    expect(h.releaseNewPinnedHostPortClaims).not.toHaveBeenCalledWith(localHostPortTarget, [
      apiAllocation,
    ]);
    expect(h.releaseNewPinnedHostPortClaims).toHaveBeenCalledWith(localHostPortTarget, [
      workerAllocation,
    ]);
  });

  it.each(["webhook", "update"])("%s pre-pulls the selected image cohort before touching any running service", async (trigger) => {
    const { DockerRuntime } = await import("@repo/adapters");
    const runtime = await DockerRuntime.create({
      dockerSocketPath: "/tmp/openship-test-absent.sock",
    });
    const pullImage = vi
      .spyOn(runtime, "pullImage")
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("registry unavailable"));
    const deployServiceWorkload = vi
      .spyOn(runtime, "deployServiceWorkload")
      .mockResolvedValue({ status: "running", containerId: "new" });
    const destroy = vi.spyOn(runtime, "destroy").mockResolvedValue(undefined);
    vi.spyOn(runtime, "ensureServiceGroup").mockResolvedValue({ id: "group-1" });
    h.services = [
      {
        id: "svc-db",
        projectId: "p1",
        name: "db",
        enabled: true,
        dependsOn: [],
        advanced: null,
        ports: [],
        image: "postgres:17",
        exposed: false,
      },
      {
        id: "svc-api",
        projectId: "p1",
        name: "api",
        enabled: true,
        dependsOn: [],
        advanced: null,
        ports: [],
        image: "ghcr.io/acme/api:staging",
        exposed: false,
      },
      {
        id: "svc-worker",
        projectId: "p1",
        name: "worker",
        enabled: true,
        dependsOn: [],
        advanced: null,
        ports: [],
        image: "ghcr.io/acme/worker:staging",
        exposed: false,
      },
      {
        id: "svc-local", projectId: "p1", name: "local-app", enabled: true,
        dependsOn: [], advanced: null, ports: [], image: "my-private-app:local", exposed: false,
      },
    ];

    const { logger } = recordingLogger();
    await expect(
      deployComposeServices(
        { ...project, activeDeploymentId: "d-old", routeStrategy: "container-ip" } as never,
        { ...dep, trigger },
        runtime,
        logger,
        {
          targetServiceIds: new Set(["svc-api", "svc-worker"]),
          strictScope: true,
          forcePullImages: trigger === "webhook",
        },
      ),
    ).rejects.toThrow("registry unavailable");

    expect(pullImage).toHaveBeenNthCalledWith(1, "ghcr.io/acme/api:staging", { force: true, logger });
    expect(pullImage).toHaveBeenNthCalledWith(2, "ghcr.io/acme/worker:staging", { force: true, logger });
    expect(pullImage).toHaveBeenCalledTimes(2);
    expect(pullImage).not.toHaveBeenCalledWith("postgres:17", expect.anything());
    expect(pullImage).not.toHaveBeenCalledWith("my-private-app:local", expect.anything());
    expect(deployServiceWorkload).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
  });

  it("updates a selected image while carrying the untouched local service into the new deployment", async () => {
    const { DockerRuntime } = await import("@repo/adapters");
    const pullImage = vi.fn(async () => undefined);
    const deployServiceWorkload = vi.fn(async () => ({
      status: "running", containerId: "container-new-api", ip: "172.18.0.3",
    }));
    const runtime = Object.assign(Object.create(DockerRuntime.prototype), {
      name: "docker", unsupportedComposeKeys: new Set(),
      supports: (cap: string) => cap === "containerIp" || cap === "containerInfo",
      ensureServiceGroup: vi.fn(async () => ({ id: "group-1" })),
      getContainerInfo: vi.fn(async (id: string) => ({
        containerId: id, status: "running", ip: "172.18.0.2",
      })),
      getContainerIp: vi.fn(async () => "172.18.0.3"),
      destroy: vi.fn(async () => undefined),
      pullImage, deployServiceWorkload,
    }) as DockerRuntimeType;
    h.services = [
      { id: "svc-local", projectId: "p1", name: "local-app", image: "my-app:custom",
        enabled: true, dependsOn: [], advanced: null, ports: [], exposed: false },
      { id: "svc-api", projectId: "p1", name: "api", image: "ghcr.io/acme/api:stable",
        enabled: true, dependsOn: [], advanced: null, ports: [], exposed: false },
    ];
    h.previousServiceRows = [{
      id: "sd-local", deploymentId: "d-old", serviceId: "svc-local", serviceName: "local-app",
      containerId: "container-local", status: "success", imageRef: "my-app:custom", imageDigest: null,
      ip: "172.18.0.2",
    }];
    const { logger } = recordingLogger();
    const result = await deployComposeServices(
      { ...project, activeDeploymentId: "d-old", routeStrategy: "container-ip" } as Project,
      { ...dep, trigger: "update" }, runtime, logger,
      { targetServiceIds: new Set(["svc-api"]), strictScope: true },
    );
    expect(result.status).toBe("ready");
    expect(pullImage).toHaveBeenCalledExactlyOnceWith("ghcr.io/acme/api:stable", { force: true, logger });
    expect(deployServiceWorkload).toHaveBeenCalledOnce();
    expect(deployServiceWorkload).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      serviceName: "api", forcePull: false,
    }), expect.anything());
    expect(result.services).toContainEqual(expect.objectContaining({
      serviceId: "svc-local", containerId: "container-local", carried: true,
    }));
    expect(h.upsertServiceDeployment).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: "svc-local", containerId: "container-local", imageRef: "my-app:custom",
    }));
    expect(runtime.destroy).not.toHaveBeenCalledWith("container-local");
  });

  it("does not try to pull a static sub-app's host artifact as a Docker image", async () => {
    const { DockerRuntime } = await import("@repo/adapters");
    const runtime = await DockerRuntime.create({
      dockerSocketPath: "/tmp/openship-test-absent.sock",
    });
    const pullImage = vi
      .spyOn(runtime, "pullImage")
      .mockRejectedValueOnce(new Error("stop after cohort classification"));
    const deployServiceWorkload = vi.spyOn(runtime, "deployServiceWorkload");
    vi.spyOn(runtime, "ensureServiceGroup").mockResolvedValue({ id: "group-1" });
    h.services = [
      {
        id: "svc-web",
        projectId: "p1",
        name: "web",
        kind: "monorepo",
        // A valid inherited sub-app can keep these fields on the project
        // snapshot rather than the row. The absolute build result remains the
        // authoritative signal that this is a host artifact, not an image.
        framework: null,
        startCommand: null,
        enabled: true,
        dependsOn: [],
        advanced: null,
        ports: [],
        image: null,
        exposed: true,
      },
      {
        id: "svc-api",
        projectId: "p1",
        name: "api",
        enabled: true,
        dependsOn: [],
        advanced: null,
        ports: [],
        image: "ghcr.io/acme/api:staging",
        exposed: false,
      },
    ];

    const { logger } = recordingLogger();
    await expect(
      deployComposeServices(
        { ...project, activeDeploymentId: "d-old", routeStrategy: "container-ip" } as never,
        dep,
        runtime,
        logger,
        {
          builtImages: new Map([["svc-web", "/opt/openship/static/.builds/web"]]),
          staticArtifactRefs: new Map([["svc-web", "/opt/openship/static/.builds/web"]]),
          staticServiceIds: new Set(["svc-web"]),
          targetServiceIds: new Set(["svc-web", "svc-api"]),
          strictScope: true,
          forcePullImages: true,
        },
      ),
    ).rejects.toThrow("stop after cohort classification");

    expect(pullImage).toHaveBeenCalledTimes(1);
    expect(pullImage).toHaveBeenCalledWith("ghcr.io/acme/api:staging", { force: true, logger });
    expect(deployServiceWorkload).not.toHaveBeenCalled();
  });

  it("does not trust a failed prior row's matching host path as a static artifact", async () => {
    const { DockerRuntime } = await import("@repo/adapters");
    const runtime = await DockerRuntime.create({
      dockerSocketPath: "/tmp/openship-test-absent.sock",
    });
    const pullImage = vi
      .spyOn(runtime, "pullImage")
      .mockRejectedValueOnce(new Error("invalid image reference"));
    const deployServiceWorkload = vi.spyOn(runtime, "deployServiceWorkload");
    vi.spyOn(runtime, "ensureServiceGroup").mockResolvedValue({ id: "group-1" });
    const attempted = "/opt/openship/static/releases/d-old-svc-host-path";
    h.services = [
      {
        id: "svc-host-path",
        projectId: "p1",
        name: "host-path",
        kind: "monorepo",
        enabled: true,
        dependsOn: [],
        advanced: null,
        ports: [],
        image: attempted,
        exposed: false,
      },
    ];
    // Failed rows retain the attempted imageRef for diagnostics. Equality with
    // service.image must not upgrade that untrusted input into a host artifact,
    // even when it has the exact shape of a managed release directory.
    h.previousServiceRows = [
      {
        id: "sd-failed",
        deploymentId: "d-old",
        serviceId: "svc-host-path",
        serviceName: "host-path",
        containerId: null,
        status: "failure",
        imageRef: attempted,
      },
    ];

    const { logger } = recordingLogger();
    await expect(
      deployComposeServices(
        { ...project, activeDeploymentId: "d-old", routeStrategy: "container-ip" } as never,
        dep,
        runtime,
        logger,
        {
          forcePullImages: true,
          staticServiceIds: new Set(["svc-host-path"]),
          staticArtifactRefs: new Map(),
        },
      ),
    ).rejects.toThrow("invalid image reference");

    expect(pullImage).not.toHaveBeenCalled();
    expect(deployServiceWorkload).not.toHaveBeenCalled();
  });

  it("carries an untargeted static release into the new deployment without re-promoting it", async () => {
    const { DockerRuntime } = await import("@repo/adapters");
    const runtime = await DockerRuntime.create({
      dockerSocketPath: "/tmp/openship-test-absent.sock",
    });
    vi.spyOn(runtime, "ensureServiceGroup").mockResolvedValue({ id: "group-1" });
    vi.spyOn(runtime, "listAllContainers").mockResolvedValue([]);
    const deployServiceWorkload = vi.spyOn(runtime, "deployServiceWorkload");
    const release = "/opt/openship/static/releases/d-old-svc-web";
    h.services = [
      {
        id: "svc-web",
        projectId: "p1",
        name: "web",
        kind: "monorepo",
        framework: "vite",
        startCommand: "",
        enabled: true,
        dependsOn: [],
        advanced: null,
        ports: [],
        image: null,
        exposed: false,
      },
    ];
    h.previousServiceRows = [
      {
        id: "sd-static-old",
        deploymentId: "d-old",
        serviceId: "svc-web",
        serviceName: "web",
        containerId: null,
        status: "success",
        imageRef: release,
      },
    ];

    const { logger } = recordingLogger();
    const result = await deployComposeServices(
      {
        ...project,
        activeDeploymentId: "d-old",
        routeStrategy: "container-ip",
      } as never,
      dep,
      runtime,
      logger,
      {
        targetServiceIds: new Set(["some-other-service"]),
        staticServiceIds: new Set(["svc-web"]),
      },
    );

    expect(result.status).toBe("ready");
    expect(result.summary).toMatchObject({ successful: 1, deployed: 0, failed: 0 });
    expect(result.services).toContainEqual(
      expect.objectContaining({
        serviceId: "svc-web",
        staticRoot: release,
        carried: true,
      }),
    );
    expect(h.upsertServiceDeployment).toHaveBeenCalledWith(
      expect.objectContaining({
        deploymentId: "d1",
        serviceId: "svc-web",
        status: "success",
        imageRef: release,
      }),
    );
    expect(deployServiceWorkload).not.toHaveBeenCalled();
  });

  it("states the skip, the reason and the reassurance, before any host touchpoint", async () => {
    // The real demotion path: host control off is the same typed error an
    // unprovisioned container channel raises, and it is the one a test can produce
    // without a container.
    vi.stubEnv("OPENSHIP_HOST_CONTROL", "false");
    const executor = await demotedExecutor();

    const { logger, lines } = recordingLogger();
    await expect(
      deployComposeServices(project, dep, haltingRuntime(), logger, {
        executor,
        hostPortTarget: localHostPortTarget,
      }),
    ).rejects.toThrow(/halt/);

    const notice = lines.find((l) => l.message.includes("Host operations are unavailable"));
    expect(
      notice,
      `no host-channel notice in the deploy log:\n${lines.map((l) => l.message).join("")}`,
    ).toBeDefined();
    expect(notice!.level).toBe("warn");
    // The reason, with the remedy the executor refuses every call with.
    expect(notice!.message).toContain("OPENSHIP_HOST_CONTROL=false");
    // From @repo/core — the deploy in progress still succeeds.
    expect(notice!.message).toContain("Ordinary deploys to this box still work");
    // Said ONCE per deploy, not per touchpoint.
    expect(lines.filter((l) => l.message.includes("Host operations are unavailable"))).toHaveLength(
      1,
    );
    // Before the first host-touching step, so it reads as the cause of what follows
    // rather than as a footnote to it.
    expect(lines.indexOf(notice!)).toBeLessThan(
      lines.findIndex((l) => l.message.includes("service group")),
    );
  });

  it("is independent of the routing strategy", async () => {
    // The pre-existing hint appeared only under `loopback-port` — the one strategy that
    // pins a host port. Every strategy loses the same host operations.
    vi.stubEnv("OPENSHIP_HOST_CONTROL", "false");
    const executor = await demotedExecutor();

    for (const routeStrategy of ["container-ip", "loopback-port", undefined]) {
      const { logger, lines } = recordingLogger();
      await expect(
        deployComposeServices(
          { ...project, routeStrategy } as unknown as Project,
          dep,
          haltingRuntime(),
          logger,
          { executor, hostPortTarget: localHostPortTarget },
        ),
      ).rejects.toThrow(/halt/);
      expect(
        lines.some((l) => l.message.includes("Host operations are unavailable")),
        `no notice under routeStrategy=${String(routeStrategy)}`,
      ).toBe(true);
    }
  });

  it("stays quiet when the channel is fine", async () => {
    // Nothing was demoted, so there is nothing to report — a notice here would be a
    // false claim about the box, which is how the dashboard came to name the wrong
    // machine (#490).
    const { logger, lines } = recordingLogger();
    await expect(
      deployComposeServices(project, dep, haltingRuntime(), logger, {
        executor: {
          exec: async () => ({ code: 0, stdout: "", stderr: "" }),
        } as unknown as CommandExecutor,
        hostPortTarget: localHostPortTarget,
      }),
    ).rejects.toThrow(/halt/);
    expect(lines.some((l) => l.message.includes("Host operations are unavailable"))).toBe(false);
  });

  it("refuses a routed Docker deployment without its target executor", async () => {
    const { logger, lines } = recordingLogger();
    await expect(
      deployComposeServices(project, dep, haltingRuntime("docker", false), logger, { executor: null }),
    ).rejects.toThrow("physical target executor");
    expect(lines.some((l) => l.message.includes("Host operations are unavailable"))).toBe(false);
  });

  it("cancels a pre-activation host wait inside the executor scope and leaves a following deploy unblocked", async () => {
    const runtime = startingRuntime();
    const deployServiceWorkload = vi.mocked(runtime.deployServiceWorkload);
    const destroy = vi.mocked(runtime.destroy);
    let activeSignal: AbortSignal | undefined;
    let channelClosed = false;
    const readFile = vi.fn(() => {
      const signal = activeSignal;
      if (!signal) throw new Error("host operation escaped its deployment cancellation scope");
      return new Promise<string>((_resolve, reject) => {
        const cancel = () => {
          // Model the real executor invariant: settle only after channel close.
          channelClosed = true;
          const error = new Error("SSH preflight cancelled after channel close");
          error.name = "AbortError";
          reject(error);
        };
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) cancel();
      });
    });
    const executor = {
      runWithAbortSignal: async <T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> => {
        activeSignal = signal;
        try {
          return await fn();
        } finally {
          if (activeSignal === signal) activeSignal = undefined;
        }
      },
      readFile,
    } as unknown as CommandExecutor;
    const secondReached = new Error("following deployment reached target preflight");
    const system = {
      ensureFeature: vi
        .fn()
        .mockImplementationOnce(() => readFile())
        .mockRejectedValueOnce(secondReached),
    };
    const firstController = new AbortController();
    const { logger } = recordingLogger();
    const first = deployComposeServices(
      { ...project, activeDeploymentId: "d-old" } as never,
      dep,
      runtime,
      logger,
      {
        executor,
        hostPortTarget: localHostPortTarget,
        system: system as never,
        signal: firstController.signal,
      },
    );
    await vi.waitFor(() => expect(readFile).toHaveBeenCalledTimes(1));

    firstController.abort();

    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(channelClosed).toBe(true);
    expect(deployServiceWorkload).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(h.upsertServiceDeployment).not.toHaveBeenCalled();

    await expect(
      deployComposeServices(
        { ...project, activeDeploymentId: "d-old" } as never,
        { ...dep, id: "d2" } as never,
        runtime,
        logger,
        {
          executor,
          hostPortTarget: localHostPortTarget,
          system: system as never,
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toBe(secondReached);
    expect(system.ensureFeature).toHaveBeenCalledTimes(2);
    expect(deployServiceWorkload).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
  });

  it("fails before container activation when a loopback target has no executor", async () => {
    const runtime = haltingRuntime();
    const ensureServiceGroup = vi.mocked(runtime.ensureServiceGroup);
    const { logger, lines } = recordingLogger();

    await expect(
      deployComposeServices(project, dep, runtime, logger, {
        executor: null,
        hostPortTarget: localHostPortTarget,
      }),
    ).rejects.toThrow("physical target executor");
    expect(ensureServiceGroup).not.toHaveBeenCalled();
  });

  it("does the same for explicit container-ip when the runtime has no container IP", async () => {
    const runtime = haltingRuntime("docker", false);
    const ensureServiceGroup = vi.mocked(runtime.ensureServiceGroup);
    const { logger } = recordingLogger();

    await expect(
      deployComposeServices(
        { ...project, routeStrategy: "container-ip" } as unknown as Project,
        dep,
        runtime,
        logger,
        { executor: null, hostPortTarget: localHostPortTarget },
      ),
    ).rejects.toThrow("physical target executor");
    expect(ensureServiceGroup).not.toHaveBeenCalled();
  });

  it("converges a non-loopback transition to an empty desired set under its own lock", async () => {
    const { logger } = recordingLogger();
    const result = await deployComposeServices(
      {
        ...project,
        activeDeploymentId: "d-old",
        routeStrategy: "container-ip",
      } as unknown as Project,
      dep,
      carriedRuntime(),
      logger,
      {
        executor: { exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })) } as never,
        hostPortTarget: localHostPortTarget,
        targetServiceIds: new Set(),
      },
    );

    expect(result.status).toBe("ready");
    expect(h.convergeTargetHostPortClaims).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p1", desiredPublishes: [] }),
    );
    expect(h.convergeTargetHostPortClaimsUnlocked).not.toHaveBeenCalled();
  });

  it("converges only after every obsolete service workload has been stopped", async () => {
    addDisabledPreviousService();
    const runtime = carriedRuntime();
    const destroy = vi.mocked(runtime.destroy);
    const { logger } = recordingLogger();

    const result = await deployComposeServices(
      {
        ...project,
        activeDeploymentId: "d-old",
        routeStrategy: "container-ip",
      } as unknown as Project,
      dep,
      runtime,
      logger,
      {
        executor: { exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })) } as never,
        hostPortTarget: localHostPortTarget,
        targetServiceIds: new Set(),
      },
    );

    expect(result.status).toBe("ready");
    expect(destroy).toHaveBeenCalledWith("container-disabled");
    expect(destroy.mock.invocationCallOrder[0]).toBeLessThan(
      h.convergeTargetHostPortClaims.mock.invocationCallOrder[0]!,
    );
  });

  it("retains claims when an obsolete service workload cannot be stopped", async () => {
    addDisabledPreviousService();
    const runtime = carriedRuntime();
    vi.mocked(runtime.destroy).mockRejectedValueOnce(new Error("daemon unavailable"));
    const { logger, lines } = recordingLogger();

    const result = await deployComposeServices(
      {
        ...project,
        activeDeploymentId: "d-old",
        routeStrategy: "container-ip",
      } as unknown as Project,
      dep,
      runtime,
      logger,
      {
        executor: { exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })) } as never,
        hostPortTarget: localHostPortTarget,
        targetServiceIds: new Set(),
      },
    );

    expect(result.status).toBe("ready");
    expect(result.warning).toContain("obsolete workload could not be stopped");
    expect(h.convergeTargetHostPortClaims).not.toHaveBeenCalled();
    expect(h.convergeTargetHostPortClaimsUnlocked).not.toHaveBeenCalled();
    expect(
      lines.some(
        (line) => line.level === "warn" && line.message.includes("reservations were retained"),
      ),
    ).toBe(true);
  });

  it("keeps a ready Compose deploy ready and surfaces deferred claim cleanup", async () => {
    h.convergeTargetHostPortClaims.mockRejectedValueOnce(new Error("edge scan unavailable"));
    const { logger, lines } = recordingLogger();
    const result = await deployComposeServices(
      {
        ...project,
        activeDeploymentId: "d-old",
        routeStrategy: "container-ip",
      } as unknown as Project,
      dep,
      carriedRuntime(),
      logger,
      {
        executor: { exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })) } as never,
        hostPortTarget: localHostPortTarget,
        targetServiceIds: new Set(),
      },
    );

    expect(result.status).toBe("ready");
    expect(result.warning).toContain("Host-port reservation cleanup was deferred");
    expect(
      lines.some(
        (line) =>
          line.level === "warn" &&
          line.message.includes("Host-port reservation cleanup was deferred"),
      ),
    ).toBe(true);
  });

  it("never releases an activated claim when failed-workload cleanup is uncertain", async () => {
    h.reserveResolvedLoopbackRoutes.mockRejectedValueOnce(
      new Error("route ownership verification failed"),
    );
    const runtime = startingRuntime();
    vi.mocked(runtime.destroy).mockRejectedValue(new Error("daemon unavailable"));
    const { logger, lines } = recordingLogger();
    const routing = {
      registerRoute: vi.fn(async () => undefined),
      removeRoute: vi.fn(async () => undefined),
    } as never;
    const ssl = {
      provisionCert: vi.fn(async () => ({ verified: false })),
      renewCert: vi.fn(),
      verifyCert: vi.fn(),
      installCert: vi.fn(),
    } as never;

    const result = await deployComposeServices(
      {
        ...project,
        activeDeploymentId: null,
        routeStrategy: "loopback-port",
      } as unknown as Project,
      dep,
      runtime,
      logger,
      {
        executor: { exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })) } as never,
        hostPortTarget: localHostPortTarget,
        routing,
        ssl,
        usesManagedRouting: true,
      },
    );

    expect(result.status).toBe("failed");
    expect(h.allocateAndReservePinnedHostPort).toHaveBeenCalled();
    expect(h.releaseNewPinnedHostPortClaims).not.toHaveBeenCalled();
    expect(h.convergeTargetHostPortClaims).not.toHaveBeenCalled();
    expect(h.convergeTargetHostPortClaimsUnlocked).not.toHaveBeenCalled();
    expect(lines.some((line) => line.message.includes("retained until the next"))).toBe(true);
  });

  it("uses the already-held target lock for a loopback deploy", async () => {
    const { logger } = recordingLogger();
    const routing = {
      registerRoute: vi.fn(async () => undefined),
      removeRoute: vi.fn(async () => undefined),
    } as never;
    const ssl = {
      provisionCert: vi.fn(async () => ({ verified: false })),
      renewCert: vi.fn(),
      verifyCert: vi.fn(),
      installCert: vi.fn(),
    } as never;
    const result = await deployComposeServices(
      {
        ...project,
        activeDeploymentId: "d-old",
        routeStrategy: "loopback-port",
      } as unknown as Project,
      dep,
      carriedRuntime(),
      logger,
      {
        executor: { exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })) } as never,
        hostPortTarget: localHostPortTarget,
        targetServiceIds: new Set(),
        routing,
        ssl,
        usesManagedRouting: true,
      },
    );

    expect(result.status).toBe("ready");
    expect(h.convergeTargetHostPortClaimsUnlocked).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "p1",
        desiredPublishes: [{ serviceId: "svc-web", containerPort: 8080, hostPort: 30_000 }],
      }),
    );
    expect(h.convergeTargetHostPortClaims).not.toHaveBeenCalled();
  });

  it("does not run project-wide convergence for strict single-service scope", async () => {
    const { logger } = recordingLogger();
    const result = await deployComposeServices(
      {
        ...project,
        activeDeploymentId: "d-old",
        routeStrategy: "loopback-port",
      } as unknown as Project,
      dep,
      carriedRuntime(),
      logger,
      {
        executor: { exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })) } as never,
        hostPortTarget: localHostPortTarget,
        targetServiceIds: new Set(),
        strictScope: true,
      },
    );

    expect(result.status).toBe("ready");
    expect(h.convergeTargetHostPortClaims).not.toHaveBeenCalled();
    expect(h.convergeTargetHostPortClaimsUnlocked).not.toHaveBeenCalled();
  });

  it("retains every claim while a started service has an indeterminate outcome", async () => {
    h.upsertServiceDeployment
      .mockRejectedValueOnce(new Error("Channel open failure: connection lost"))
      .mockResolvedValueOnce(undefined);
    const { logger } = recordingLogger();

    const result = await deployComposeServices(
      {
        ...project,
        activeDeploymentId: null,
        routeStrategy: "loopback-port",
      } as unknown as Project,
      dep,
      startingRuntime(),
      logger,
      {
        executor: { exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })) } as never,
        hostPortTarget: localHostPortTarget,
        routing: {
          registerRoute: vi.fn(async () => undefined),
          removeRoute: vi.fn(async () => undefined),
        } as never,
        ssl: {
          provisionCert: vi.fn(async () => ({ verified: false })),
          renewCert: vi.fn(),
          verifyCert: vi.fn(),
          installCert: vi.fn(),
        } as never,
        usesManagedRouting: true,
      },
    );

    expect(result.status).toBe("reconciling");
    expect(h.allocateAndReservePinnedHostPort).toHaveBeenCalled();
    expect(h.releaseNewPinnedHostPortClaims).not.toHaveBeenCalled();
    expect(h.convergeTargetHostPortClaims).not.toHaveBeenCalled();
    expect(h.convergeTargetHostPortClaimsUnlocked).not.toHaveBeenCalled();
  });
});

vi.mock("@repo/platform/engine/lib/platform-config", () => ({ platform: () => ({ target: "selfhosted" }) }));

it("rejects an invalid GPU request before pulling images or replacing any sibling", async () => {
  const fixture = imageRefreshFixture();
  h.services[0]!.updatedAt = new Date(2000);
  h.services[1]!.advanced = { gpus: { driver: "amd", count: 1 } };
  await expect(fixture.run()).rejects.toThrow(/only.*NVIDIA/);
  expect(fixture.pull).not.toHaveBeenCalled();
  expect(fixture.activate).not.toHaveBeenCalled();
  expect(fixture.runtime.destroy).not.toHaveBeenCalled();
});

it.each([{ ports: [] }, { ports: ["127.0.0.1:25774:25774"] }])(
  "deploys private services without taking over the edge ($ports)",
  async ({ ports }) => {
    h.services = [{ ...h.services[0], exposed: false, customDomain: null, ports }];
    h.previousServiceRows = [];
    const runtime = startingRuntime();
    const exec = vi.fn(async () => {
      throw new Error("foreign proxy must not be touched");
    });
    const system = { ensureFeature: vi.fn(async (_feature: string) => undefined) };
    const { logger, lines } = recordingLogger();
    const result = await deployComposeServices(project, dep, runtime, logger, {
      executor: { exec } as unknown as CommandExecutor,
      hostPortTarget: localHostPortTarget,
      system: system as never,
    });
    expect(result.status).toBe("ready");
    expect(system.ensureFeature.mock.calls.map((call) => call[0])).toEqual(["deploy"]);
    expect(h.prepareTargetPinnedHostPorts).not.toHaveBeenCalled();
    expect(h.allocateAndReservePinnedHostPort).not.toHaveBeenCalled();
    expect(runtime.deployServiceWorkload).toHaveBeenCalled();
    expect(vi.mocked(runtime.deployServiceWorkload).mock.calls[0]?.[1].ports).toEqual(ports);
    expect(lines.some((line) => line.message.includes("Edge/routing setup failed"))).toBe(false);
  },
);

it("passes generated config through scheduler-native files without requiring a host writer", async () => {
  h.services = [{id: "svc-web", projectId: "p1", name: "web", enabled: true, dependsOn: [],
    image: "busybox:1.37", ports: [], volumes: [], exposed: false, environment: {GREETING: "${GREETING:-hello}"},
    advanced: {environmentTemplateKeys: ["GREETING"], files: [{path: "/etc/app.yml", content: "enabled: true"}]},
  }];
  h.previousServiceRows = [];
  const runtime = startingRuntime();
  Object.assign(runtime, {name: "swarm", supports: (cap: string) => ["clusterStatus", "containerIp", "serviceConfigFiles"].includes(cap)});
  const {logger} = recordingLogger();
  const result = await deployComposeServices(project, dep, runtime, logger);
  expect(result.status, JSON.stringify(result.services)).toBe("ready");
  expect(runtime.deployServiceWorkload).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
    environment: expect.objectContaining({GREETING: "hello"}),
    advanced: expect.objectContaining({files: [{path: "/etc/app.yml", content: "enabled: true"}]}),
    volumes: [],
  }), expect.any(Function));
});

it("refuses automatic private publishes when route inventory is unreadable without preparing the edge", async () => {
  h.services = [{ ...h.services[0], exposed: false, customDomain: null, ports: ["8800"] }];
  h.previousServiceRows = [];
  h.prepareTargetPinnedHostPorts.mockRejectedValueOnce(new Error("route inventory unreadable"));
  const runtime = startingRuntime();
  const system = { ensureFeature: vi.fn(async (_feature: string) => undefined) };
  const { logger } = recordingLogger();
  await expect(
    deployComposeServices(project, dep, runtime, logger, {
      executor: { exec: vi.fn(async () => "") } as unknown as CommandExecutor,
      hostPortTarget: localHostPortTarget,
      system: system as never,
    }),
  ).rejects.toThrow("route inventory unreadable");
  expect(system.ensureFeature.mock.calls.map((call) => call[0])).toEqual(["deploy"]);
  expect(h.prepareTargetPinnedHostPorts).toHaveBeenCalledTimes(1);
  expect(h.allocateAndReservePinnedHostPort).not.toHaveBeenCalled();
  expect(runtime.deployServiceWorkload).not.toHaveBeenCalled();
});
