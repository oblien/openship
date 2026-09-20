import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BuildLogger, CommandExecutor, MultiServiceRuntimeAdapter } from "@repo/adapters";
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
  services: [] as Array<Record<string, unknown>>,
  previousServiceRows: [] as Array<Record<string, unknown>>,
  previousDeployment: { id: "d-old", projectId: "p1", organizationId: "org1", containerId: "compose", createdAt: null } as Record<
    string,
    unknown
  >,
}));

vi.mock("@repo/db", () => ({
  repos: {
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
      markServiceDeploymentFailed: async () => undefined,
    },
    deployment: {
      findById: async () => h.previousDeployment,
    },
    project: {
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
  withHostPortTargetLock: (_target: unknown, fn: () => unknown) => fn(),
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

const { resolveServerExecutor } = await import("@repo/platform/engine/lib/deployment-runtime");
const { deployComposeServices } =
  await import("@repo/platform/engine/modules/deployments/compose/deploy.service");

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
  const { CloudDockerRuntime } = await import("@repo/adapters");
  const configurations: Array<Record<string, any>> = [];
  const publishRoute = vi.fn(async () => undefined);
  const pullImage = vi.fn(async () => undefined);
  const runtime = Object.assign(Object.create(CloudDockerRuntime.prototype), {
    name: "cloud", workspaceId: "shared-vm", projectId: "p1", unsupportedComposeKeys: new Set(),
    supports: (cap: string) => cap === "dockerHost",
    ensureServiceGroup: vi.fn(async () => ({ id: "shared-network", kind: "docker-network" })),
    deployServiceWorkload: vi.fn(async (_group: unknown, config: Record<string, any>) => {
      configurations.push(config);
      const hostPortByContainerPort = config.serviceName === "web" ? { 8080: 30001, 9090: 30002 } : { 8080: 30003 };
      return { status: "running", containerId: `${config.serviceName}-container`, hostPortByContainerPort };
    }),
    resolveRoutingTarget: vi.fn(async (id: string, port: number) => ({ workspace: "shared-vm",
      port: id === "web-container" ? (port === 8080 ? 30001 : 30002) : 30003 })),
    getContainerIp: vi.fn(async () => "172.18.0.2"), listAllContainers: vi.fn(async () => []),
    destroy: vi.fn(async () => undefined), publishRoute, pullImage,
  }) as CloudDockerRuntime;
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
  const result = await deployComposeServices({ ...project, cloudWorkspaceId: "shared-vm", routeStrategy: "auto",
    compositeRoutes: [{ hostname: "app.opsh.io", isCustomDomain: false, rootServiceId: "svc-web",
      locations: [{ pathPrefix: "/api/", serviceId: "svc-api" }] }] } as Project,
  { ...dep, projectId: "p1", meta: { deployTarget: "cloud", runtimeMode: "docker", cloudDockerWorkspace: { projectId: "p1", workspaceId: "shared-vm" } } },
  runtime, logger, { executor, localHost: false, usesManagedRouting: false, forcePullImages: true,
    resources: { cpuCores: 1, memoryMb: 1024, diskMb: 8192 },
    routing: { removeRoute: vi.fn(), registerRoute: vi.fn() } as never, ssl: { provisionCert: vi.fn(), verifyCert: vi.fn() } as never });
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
  expect(pullImage).toHaveBeenCalledWith("web:v1", { force: true });
  expect(pullImage).toHaveBeenCalledWith("api:v1", { force: true });
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
});

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
    h.allocateAndReservePinnedHostPort.mockResolvedValueOnce({
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
    });

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
    const occupancyPolicy = h.allocateAndReservePinnedHostPort.mock.calls[0]![0]
      .reuseOccupiedPreferred as (port: number) => boolean;
    expect(occupancyPolicy(20_008)).toBe(false);
    expect(deployServiceWorkload).toHaveBeenCalledTimes(3);
    expect(destroy).toHaveBeenCalled();
    expect(h.upsertServiceDeployment).toHaveBeenCalled();
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

  it("pre-pulls the entire selected image cohort before touching any running service", async () => {
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
    ];

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
          forcePullImages: true,
        },
      ),
    ).rejects.toThrow("registry unavailable");

    expect(pullImage).toHaveBeenNthCalledWith(1, "ghcr.io/acme/api:staging", { force: true });
    expect(pullImage).toHaveBeenNthCalledWith(2, "ghcr.io/acme/worker:staging", { force: true });
    expect(pullImage).toHaveBeenCalledTimes(2);
    expect(pullImage).not.toHaveBeenCalledWith("postgres:17", expect.anything());
    expect(deployServiceWorkload).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
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
    expect(pullImage).toHaveBeenCalledWith("ghcr.io/acme/api:staging", { force: true });
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

    expect(pullImage).toHaveBeenCalledWith(attempted, { force: true });
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

  it("stays quiet on cloud, which has no executor and no host", async () => {
    const { logger, lines } = recordingLogger();
    await expect(
      deployComposeServices(project, dep, haltingRuntime("cloud"), logger, { executor: null }),
    ).rejects.toThrow(/halt/);
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
