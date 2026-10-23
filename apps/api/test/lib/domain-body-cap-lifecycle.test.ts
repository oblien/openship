import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RouteConfig } from "@repo/adapters";

// Database and machine/provider I/O are the boundaries. The deployment planner,
// live/retry writers, row synchronizer, registrar and size resolver remain real.
const h = vi.hoisted(() => ({
  project: {} as any,
  deployment: {} as any,
  domains: [] as any[],
  services: [] as any[],
  live: [] as any[],
  routes: [] as RouteConfig[],
  writes: [] as Array<{ id: string; patch: Record<string, unknown> }>,
  runtime: null as any,
  routing: null as any,
  executor: { exec: async () => "" },
  rejectHost: null as string | null,
  generation: 0,
}));
vi.mock("@repo/db", () => ({
  withAdvisoryLock: async (_key: string, work: () => unknown) => work(),
  runOutsideAdvisoryLock: (work: () => unknown) => work(),
  repos: {
    project: {
      findById: async () => h.project,
      getEnvMap: async () => ({}),
      listEnvVarChangeMeta: async () => [],
      update: async (_id: string, patch: object) => Object.assign(h.project, patch),
    },
    deployment: {
      findById: async () => h.deployment,
      updateStatus: async (_id: string, status: string, patch: object) =>
        Object.assign(h.deployment, { status }, patch),
      listPendingRoleHandovers: async () => [],
    },
    service: {
      listByProject: async () => h.services,
      listByDeployment: async () => h.live,
      upsertServiceDeployment: async (row: any) => {
        h.live = h.live.filter((value) => value.serviceId !== row.serviceId);
        h.live.push(row);
      },
      updateServiceDeployment: async () => {},
      startServiceDeploymentTiming: async () => {},
      finishStartedServiceDeploymentTimings: async () => {},
      markServiceDeploymentFailed: async () => {},
    },
    domain: {
      listByProject: async () => h.domains,
      findByHostname: async (hostname: string) =>
        h.domains.find((row) => row.hostname === hostname),
      update: async (id: string, patch: Record<string, unknown>) => {
        h.writes.push({ id, patch: structuredClone(patch) });
        Object.assign(
          h.domains.find((row) => row.id === id),
          patch,
        );
      },
      findOrCreateWithStatus: async (input: any) => {
        const existing = h.domains.find((row) => row.hostname === input.hostname);
        if (existing) return { domain: existing, created: false };
        const domain = { id: `domain-${input.hostname}`, proxy: null, ...input };
        h.domains.push(domain);
        return { domain, created: true };
      },
    },
    pullRequestPreview: { findByProject: async () => null },
    routeProtection: { readPrivate: async () => null },
  },
}));
vi.mock("@repo/platform/engine/lib/platform-config", () => ({
  platform: () => ({ target: "selfhosted", routing: h.routing, runtime: h.runtime }),
}));
vi.mock("@repo/platform/engine/lib/deployment-runtime", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/lib/deployment-runtime")>()),
  disposePlatform: () => {},
  resolveDeploymentPlatform: async () => ({
    platform: { runtime: h.runtime, routing: h.routing },
    effectiveTarget: "local",
    serverId: null,
    executor: h.executor,
  }),
  withDeploymentPlatform: async (_dep: unknown, work: (value: unknown) => unknown) =>
    work({
      routing: h.routing,
      runtime: h.runtime,
      executor: h.executor,
      effectiveTarget: "local",
    }),
}));
vi.mock("@repo/platform/engine/lib/route-protection", () => ({
  withRouteProtectionLock: async (_id: string, work: () => unknown) => work(),
  resolveProjectRouteProtection: async () => ({ routeOptions: { protection: null } }),
}));
vi.mock("@repo/platform/engine/lib/project-runtime-lock", () => ({
  withLiveProjectRuntimeMutation: async (_id: string, work: (project: unknown) => unknown) =>
    work(h.project),
}));
vi.mock("@repo/platform/engine/lib/project-route-recovery", () => ({
  recoverProjectRouteCleanup: async () => {},
}));
vi.mock("@repo/platform/engine/lib/managed-edge-proxy", () => ({
  syncManagedEdgeRoutes: async () => ({ failures: [] }),
  deregisterManagedEdgeRoutes: async () => ({ failures: [] }),
  ensureManagedEdgeProxy: async () => {},
  edgeUnsyncedWarning: () => "routing unsynced",
}));
vi.mock("@repo/platform/engine/modules/route-rules/route-rule.service", () => ({
  pushProjectRules: async () => {},
}));
vi.mock("@repo/platform/engine/modules/analytics/analytics-config.service", () => ({
  pushProjectAnalyticsConfig: async () => {},
}));
vi.mock("@repo/platform/engine/modules/deployments/readiness-probe", () => ({
  probeDeployedReadiness: async () => ({ failure: null }),
}));
vi.mock("@repo/platform/engine/lib/edge-reconcile", () => ({
  reconcileServerEdge: async () => ({ converted: false, updated: false, edgeDown: false }),
  ensureRoutingReady: async () => {},
}));
vi.mock("@repo/platform/engine/modules/deployments/session-manager", () => ({
  broadcastServiceStatus: () => {},
  broadcastInstallPhase: () => {},
  appendLog: () => {},
}));
vi.mock("@repo/platform/engine/lib/plan-guard", () => ({
  assertCloudDeploymentLimits: async () => {},
}));
vi.mock("@repo/platform/engine/modules/deployments/attach-linked-networks", () => ({
  attachLinkedNetworks: async () => {},
}));
vi.mock("@repo/platform/engine/modules/deployments/port-audit.service", () => ({
  auditPorts: async () => [],
}));
vi.mock("@repo/platform/engine/modules/deployments/output-audit.service", () => ({
  auditStaticOutput: async () => [],
  describeOutputFinding: () => "",
  outputFindingIsBroken: () => false,
  staticOutputTargets: () => [],
}));
vi.mock("@repo/platform/engine/modules/deployments/stability-audit.service", () => ({
  verifyDeployedContainers: async () => [],
  recordUnstableServices: async () => {},
}));
vi.mock("@repo/adapters", async (original) => ({
  ...(await original<typeof import("@repo/adapters")>()),
  checkEdge: async () => ({ healthy: true }),
  edgeProxy: async () => ({ siteFor: async () => null }),
  sharedMountExecutor: async () => h.executor,
}));

import { BareRuntime, BuildLogger, DockerRuntime, runDeployPipeline } from "@repo/adapters";
import { createProjectRouteRegistrar } from "@repo/platform/engine/lib/project-route-registration";
import {
  buildProjectRouteDomains,
  toRoutedDomainInputs,
} from "@repo/platform/engine/lib/routing-domains";
import { deployComposeServices } from "@repo/platform/engine/modules/deployments/compose/deploy.service";
import { reapplyProjectLiveRoutes } from "@repo/platform/engine/modules/domains/project-route.service";
import { applyProjectRouting } from "@repo/platform/engine/modules/domains/routing-apply.service";
import { retryProjectRouting } from "@repo/platform/engine/modules/projects/project-runtime.service";

const logger = new BuildLogger(() => {});
const hosts = ["api.example.test", "events.example.test"];
function domain(index: number, serviceId: string | null = null) {
  return {
    id: `domain-${index}`,
    projectId: "project",
    ownerType: "project",
    hostname: hosts[index],
    serviceId,
    targetPort: 8080,
    targetPath: null,
    domainType: "custom",
    verified: true,
    status: "active",
    sslStatus: "active",
    externalIngress: false,
    proxy: index ? { clientMaxBodySize: "1m" } : null,
  };
}
function service(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    projectId: "project",
    name: id,
    enabled: true,
    kind: "compose",
    image: "example:1",
    updatedAt: new Date(0),
    dependsOn: [],
    advanced: null,
    ports: ["8080"],
    exposed: true,
    exposedPort: "8080",
    framework: "express",
    startCommand: "node index.js",
    publicEndpoints: hosts.map((customDomain) => ({
      port: 8080,
      domainType: "custom",
      customDomain,
    })),
    ...overrides,
  };
}
function lastRoute(hostname: string) {
  const route = h.routes.filter((row) => row.domain === hostname).at(-1);
  expect(route, `writer emitted ${hostname}`).toBeDefined();
  return route!;
}
function caps(expected: Array<string | undefined>) {
  expect(hosts.map((host) => lastRoute(host).proxy?.clientMaxBodySize)).toEqual(expected);
}
async function retry() {
  h.routes = [];
  return retryProjectRouting("project", "org");
}
async function compose(options: Record<string, unknown> = {}) {
  h.routes = [];
  const next = {
    ...h.deployment,
    id: `deployment-${++h.generation}`,
    trigger: "manual",
    forceAll: true,
  };
  const result = await deployComposeServices(h.project, next, h.runtime, logger, {
    routing: h.routing,
    ssl: {
      provisionCert: async () => ({ verified: false, reason: "not_local" }),
      verifyCert: async () => ({ verified: true, reason: "not_local" }),
    },
    usesManagedRouting: false,
    ...options,
  } as never);
  expect(result.status).toBe("ready");
  expect(result.routeWarnings ?? []).toEqual([]);
  h.deployment = next;
  h.project.activeDeploymentId = next.id;
  return result;
}
beforeEach(() => {
  vi.restoreAllMocks();
  h.project = {
    id: "project",
    organizationId: "org",
    slug: "example",
    port: 8080,
    activeDeploymentId: "deployment",
    workspaceId: null,
    routeStrategy: "container-ip",
    routingConfig: { proxy: { clientMaxBodySize: "2m", proxyReadTimeout: "90s" } },
  };
  h.deployment = {
    id: "deployment",
    projectId: "project",
    organizationId: "org",
    status: "ready",
    containerId: "single-container",
    environment: "production",
    meta: { deployTarget: "local" },
  };
  h.domains = [domain(0), domain(1)];
  h.services = [];
  h.live = [];
  h.routes = [];
  h.writes = [];
  h.rejectHost = null;
  h.generation = 0;
  h.routing = {
    supportsDomainProxy: true,
    registerRoute: async (route: RouteConfig) => {
      if (route.domain === h.rejectHost) throw new Error("edge config rejected");
      h.routes.push(structuredClone(route));
    },
    removeRoute: async () => {},
  };
  h.runtime = Object.assign(Object.create(DockerRuntime.prototype), {
    name: "docker",
    unsupportedComposeKeys: new Set(),
    supports: (capability: string) => ["containerIp", "containerInfo"].includes(capability),
    ensureServiceGroup: async () => ({ id: "group" }),
    inspectDeploymentImage: async () => ({ Id: `sha256:${"a".repeat(64)}`, RepoDigests: [] }),
    pullImage: async () => {},
    prepareServiceVolumes: async () => {},
    prepareServiceCutover: async () => null,
    deployServiceWorkload: async (_group: unknown, config: any) => ({
      status: "running",
      containerId: `container-${config.serviceName}`,
      ip: "172.18.0.3",
    }),
    getContainerIp: async () => "172.18.0.3",
    getContainerInfo: async () => ({
      status: "running",
      ip: "172.18.0.3",
      imageId: `sha256:${"a".repeat(64)}`,
    }),
    finalizeServiceGroup: async () => {},
    destroy: async () => {},
  });
  vi.spyOn(BareRuntime.prototype, "promoteStaticRelease").mockImplementation(
    async (input) => `/opt/openship/static/releases/${input.releaseId}`,
  );
});

describe("saved domain body caps through lifecycle writers (#1431)", () => {
  it("plans and publishes a single-app deployment and redeployment with current saved caps", async () => {
    const deploy = async () => {
      h.routes = [];
      const domains = buildProjectRouteDomains({
        project: h.project,
        projectDomains: h.domains,
        runtimeName: "docker",
        usesManagedRouting: false,
      });
      const result = await runDeployPipeline(
        {
          canOverlap: true,
          activate: async () => ({ containerId: "single-container" }),
          deactivate: async () => {},
          resolveTargetUrl: async (_container, port) => `http://172.18.0.3:${port}`,
        },
        {
          config: { deploymentId: "deployment", projectId: "project", port: 8080 } as never,
          domains: toRoutedDomainInputs(domains),
          routing: createProjectRouteRegistrar(h.project, h.routing),
          routeOptions: { proxy: h.project.routingConfig.proxy },
        },
        logger,
      );
      expect(result.status).toBe("ready");
      expect(result.routeWarnings ?? []).toEqual([]);
    };
    await deploy();
    caps(["2m", "1m"]);
    expect(lastRoute(hosts[1]!).targetUrl).toBe("http://172.18.0.3:8080");
    h.project.routingConfig.proxy.clientMaxBodySize = "3m";
    await deploy();
    caps(["3m", "1m"]);
    h.domains[1].proxy = null;
    await deploy();
    caps(["3m", "3m"]);
    delete h.project.routingConfig.proxy.clientMaxBodySize;
    await deploy();
    caps([undefined, undefined]);
  });

  it("runs ordinary Compose deploy and redeploy, preserving domain identity and overrides during row sync", async () => {
    h.services = [service("api")];
    h.domains = [domain(0, "old-service"), domain(1, "old-service")];
    h.domains.forEach((row) => {
      row.targetPort = 7070;
    });
    const identity = h.domains.map((row) => [row.id, row.projectId, row.proxy]);
    await compose();
    caps(["2m", "1m"]);
    expect(h.writes).toEqual(
      expect.arrayContaining([
        { id: "domain-0", patch: { serviceId: "api", targetPort: 8080 } },
        { id: "domain-1", patch: { serviceId: "api", targetPort: 8080 } },
      ]),
    );
    expect(h.domains.map((row) => [row.id, row.projectId, row.proxy])).toEqual(identity);
    expect(lastRoute(hosts[1]!).targetUrl).toBe("http://172.18.0.3:8080");
    h.project.routingConfig.proxy.clientMaxBodySize = "3m";
    await compose();
    caps(["3m", "1m"]);
    h.domains[1].proxy = { clientMaxBodySize: "0" };
    await compose();
    caps(["3m", "0"]);
  });

  it("runs the Compose static publisher and final composite writer without losing either cap", async () => {
    h.services = [
      service("web", {
        kind: "monorepo",
        framework: "vite",
        startCommand: "",
        publicEndpoints: [...hosts]
          .reverse()
          .map((customDomain) => ({ port: 8080, domainType: "custom", customDomain })),
      }),
      service("backend", { kind: "monorepo", exposed: false, publicEndpoints: [] }),
    ];
    h.domains = [domain(0, "web"), domain(1, "web")];
    await compose({
      builtImages: new Map([["web", "/opt/openship/static/releases/.builds/fixture-web"]]),
      staticServiceIds: new Set(["web"]),
      staticArtifactRefs: new Map([["web", "/opt/openship/static/releases/.builds/fixture-web"]]),
    });
    caps(["2m", "1m"]);
    for (const host of hosts) {
      const writes = h.routes.filter((route) => route.domain === host);
      expect(writes.some((route) => route.staticRoot && !route.proxyLocations?.length)).toBe(true);
      expect(
        writes.every(
          (route) => route.proxy?.clientMaxBodySize === (host === hosts[0] ? "2m" : "1m"),
        ),
      ).toBe(true);
    }
    const composite = h.routes.find((route) =>
      route.proxyLocations?.some((location) => location.pathPrefix === "/api/"),
    );
    expect(composite).toMatchObject({
      domain: hosts[1],
      proxy: { clientMaxBodySize: "1m" },
      staticRoot: "/opt/openship/static/releases/deployment-1-web",
      proxyLocations: [{ pathPrefix: "/api/", targetUrl: "http://172.18.0.3:8080" }],
    });
  });

  it("reconciles single-app live routes and actual routing retry after project changes, reset and apply failure", async () => {
    await reapplyProjectLiveRoutes(h.project, []);
    caps(["2m", "1m"]);
    h.project.routingConfig.proxy.clientMaxBodySize = "3m";
    h.rejectHost = hosts[1]!;
    expect(await retry()).toMatchObject({ ok: false });
    expect(h.deployment.meta.edgeUnsynced).toBe(true);
    h.rejectHost = null;
    expect(await retry()).toEqual({ ok: true });
    caps(["3m", "1m"]);
    expect(h.deployment.meta.edgeUnsynced).toBeUndefined();
    h.domains[1].proxy = null;
    expect(await retry()).toEqual({ ok: true });
    caps(["3m", "3m"]);
    delete h.project.routingConfig.proxy.clientMaxBodySize;
    expect(await retry()).toEqual({ ok: true });
    caps([undefined, undefined]);
  });

  it("rebuilds complete Compose live topology and migration fan-out with fresh domain caps", async () => {
    h.services = [
      service("web", {
        kind: "monorepo",
        framework: "vite",
        startCommand: "",
        publicEndpoints: hosts.map((customDomain) => ({
          port: 8080,
          domainType: "custom",
          customDomain,
        })),
      }),
      service("backend", { kind: "monorepo", exposed: false, publicEndpoints: [] }),
    ];
    h.domains = [domain(0, "web"), domain(1, "web")];
    h.live = [
      { serviceId: "web", imageRef: "/opt/openship/static/releases/live-web", status: "success" },
      {
        serviceId: "backend",
        containerId: "container-backend",
        ip: "172.18.0.3",
        status: "success",
      },
    ];
    h.project.compositeRoutes = [
      {
        hostname: hosts[1],
        rootServiceId: "backend",
        rootPort: 8080,
        locations: [{ pathPrefix: "/events/", serviceId: "backend", port: 8080 }],
      },
    ];
    await applyProjectRouting("project");
    caps(["2m", "1m"]);
    expect(lastRoute(hosts[0]!).proxyLocations).toEqual([
      { pathPrefix: "/api/", targetUrl: "http://172.18.0.3:8080" },
    ]);
    expect(lastRoute(hosts[1]!).proxyLocations).toEqual([
      { pathPrefix: "/events/", targetUrl: "http://172.18.0.3:8080" },
    ]);
    h.project.routingConfig.proxy.clientMaxBodySize = "3m";
    h.domains[1].proxy = {};
    h.routes = [];
    await applyProjectRouting("project");
    caps(["3m", "3m"]);
  });
});
