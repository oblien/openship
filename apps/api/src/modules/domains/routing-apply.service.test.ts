import { beforeEach, describe, expect, it, vi } from "vitest";

const projectRepo = vi.hoisted(() => ({ findById: vi.fn() }));
const deploymentRepo = vi.hoisted(() => ({ findById: vi.fn() }));
const serviceRepo = vi.hoisted(() => ({ listByProject: vi.fn(), listByDeployment: vi.fn() }));
const domainRepo = vi.hoisted(() => ({ listByProject: vi.fn() }));

const resolveDeploymentRuntime = vi.hoisted(() => vi.fn());
const usesManagedRouting = vi.hoisted(() => vi.fn().mockReturnValue(false));
const reconcileProjectRoutes = vi.hoisted(() => vi.fn());

vi.mock("@repo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/db")>();
  return {
    ...actual,
    repos: {
      ...actual.repos,
      project: projectRepo,
      deployment: deploymentRepo,
      service: serviceRepo,
      domain: domainRepo,
    },
  };
});

// The service resolves a PLATFORM now (`{platform:{routing,runtime}}`) and releases
// its docker transport when done, so the flat stub above is adapted to that shape
// rather than re-written per test.
vi.mock("../../lib/deployment-runtime", () => ({
  usesManagedRouting,
  disposePlatform: () => {},
  resolveDeploymentPlatform: async (...args: unknown[]) => {
    const flat = (await resolveDeploymentRuntime(...args)) as Record<string, unknown>;
    return { platform: flat, effectiveTarget: flat.effectiveTarget, serverId: flat.serverId };
  },
}));
vi.mock("../../lib/route-apply.service", () => ({ reconcileProjectRoutes }));
vi.mock("../../lib/controller-helpers", () => ({ platform: () => ({ target: "selfhosted" }) }));

import { applyProjectRouting } from "./routing-apply.service";

function emittedRegisters() {
  expect(reconcileProjectRoutes).toHaveBeenCalledTimes(1);
  const [, opts] = reconcileProjectRoutes.mock.calls[0];
  return opts.registers;
}

/** The topology-aware writer is intentionally last for a shared hostname. */
function emittedRegister() {
  const registers = emittedRegisters();
  expect(registers.length).toBeGreaterThan(0);
  return registers.at(-1);
}

function runtimeReturning(opts: {
  /** undefined → the live inspect throws. */
  info?: {
    status?: string;
    ip?: string;
    hostPort?: number;
    hostPortByContainerPort?: Record<number, number>;
  };
  ip?: string | null;
}) {
  resolveDeploymentRuntime.mockResolvedValue({
    runtime: {
      name: "docker",
      supports: (cap: string) => cap === "containerIp" || cap === "containerInfo",
      getContainerInfo: vi.fn(async () => {
        if (!opts.info) throw new Error("not found");
        return { containerId: "container_1", status: "running", ...opts.info };
      }),
      getContainerIp: vi.fn(async () => (opts.ip === undefined ? "172.19.0.2" : opts.ip)),
    },
    routing: { registerRoute: vi.fn() },
    effectiveTarget: "local",
  });
}

/** `service_deployment` row for the migrated service. */
function storeRow(row: {
  containerId?: string | null;
  ip?: string | null;
  hostPort?: number | null;
  hostPorts?: Record<string, number> | null;
}) {
  serviceRepo.listByDeployment.mockResolvedValue([
    {
      id: "sd_1",
      serviceId: "svc_1",
      deploymentId: "dep_1",
      containerId: "container_1",
      ip: null,
      hostPort: null,
      ...row,
    },
  ]);
}

const project = (routeStrategy = "auto") => ({
  id: "proj_1",
  activeDeploymentId: "dep_1",
  routeStrategy,
  routingConfig: null,
  compositeRoutes: [
    { hostname: "app.example.com", isCustomDomain: true, rootServiceId: "svc_1", locations: [] },
  ],
  slug: "app",
  cloudWorkspaceId: null,
  webhookDomain: null,
});

describe("applyProjectRouting — upstream resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    projectRepo.findById.mockResolvedValue(project());

    deploymentRepo.findById.mockResolvedValue({
      id: "dep_1",
      organizationId: "org_1",
      meta: { deployTarget: "local", runtimeMode: "docker" },
    });

    serviceRepo.listByProject.mockResolvedValue([
      {
        id: "svc_1",
        projectId: "proj_1",
        name: "web",
        enabled: true,
        exposed: true,
        exposedPort: "3001",
        domain: null,
        customDomain: "app.example.com",
        domainType: "custom",
        publicEndpoints: null,
        ports: [],
        kind: "compose",
      },
    ]);

    storeRow({});
    domainRepo.listByProject.mockResolvedValue([]);
    runtimeReturning({ info: { ip: "172.19.0.2" } });
    usesManagedRouting.mockReturnValue(false);
    reconcileProjectRoutes.mockResolvedValue(undefined);
  });

  it("routes a migrated container with no loopback publish at its container IP", async () => {
    await applyProjectRouting("proj_1");

    expect(emittedRegister()).toMatchObject({
      hostname: "app.example.com",
      targetUrl: "http://172.19.0.2:3001",
    });
  });

  /**
   * #506 regression guard. The row still carries a host port from an earlier
   * deploy, but the live container publishes nothing — the stored value must not
   * win, or the edge dials a dead 127.0.0.1:3001 behind a Verified domain.
   */
  it("ignores a stored host port the live container no longer publishes", async () => {
    storeRow({ ip: "172.19.0.2", hostPort: 3001 });

    await applyProjectRouting("proj_1");

    expect(emittedRegister().targetUrl).toBe("http://172.19.0.2:3001");
  });

  it("uses the live loopback port when the container publishes one", async () => {
    storeRow({ ip: "172.19.0.2", hostPort: 3999 });
    runtimeReturning({ info: { ip: "172.19.0.2", hostPort: 4000 } });

    await applyProjectRouting("proj_1");

    expect(emittedRegister().targetUrl).toBe("http://127.0.0.1:4000");
  });

  it("does not re-register a cached loopback upstream when the container cannot be inspected", async () => {
    // A failed inspect proves neither that this container still owns the port nor
    // that the port is unused. Leave the existing vhost untouched; re-registering
    // its cached target could point the hostname at a different workload.
    storeRow({ ip: "172.19.0.2", hostPort: 4000 });
    runtimeReturning({ ip: null });

    await applyProjectRouting("proj_1");

    expect(reconcileProjectRoutes).not.toHaveBeenCalled();
  });

  it("does not trust a cached per-port binding when the container cannot be inspected", async () => {
    storeRow({
      ip: "172.19.0.2",
      hostPort: 4000,
      hostPorts: { "3000": 4000, "3001": 4001 },
    });
    runtimeReturning({ ip: null });

    await applyProjectRouting("proj_1");

    expect(reconcileProjectRoutes).not.toHaveBeenCalled();
  });

  it("does not route a cached address for a service with no container", async () => {
    storeRow({ containerId: null, ip: "172.19.0.2" });

    await applyProjectRouting("proj_1");

    expect(reconcileProjectRoutes).not.toHaveBeenCalled();
  });

  it("honours an explicit container-ip strategy over a published host port", async () => {
    projectRepo.findById.mockResolvedValue(project("container-ip"));
    storeRow({ ip: "172.19.0.2", hostPort: 4000 });
    runtimeReturning({ info: { ip: "172.19.0.2", hostPort: 4000 } });

    await applyProjectRouting("proj_1");

    expect(emittedRegister().targetUrl).toBe("http://172.19.0.2:3001");
  });

  it("reapplies every service-owned port with its exact live loopback ownership", async () => {
    projectRepo.findById.mockResolvedValue({
      ...project("loopback-port"),
      compositeRoutes: [],
    });
    serviceRepo.listByProject.mockResolvedValue([
      {
        id: "svc_1",
        projectId: "proj_1",
        name: "web",
        enabled: true,
        exposed: true,
        exposedPort: "3001",
        domainType: "custom",
        customDomain: "app.example.com",
        publicEndpoints: [
          { port: 3001, domainType: "custom", customDomain: "app.example.com" },
          { port: 3002, domainType: "custom", customDomain: "admin.example.com" },
        ],
        ports: ["3001", "3002"],
        kind: "compose",
      },
    ]);
    storeRow({
      ip: "172.19.0.2",
      hostPort: 4001,
      hostPorts: { "3001": 4001, "3002": 4002 },
    });
    runtimeReturning({
      info: {
        ip: "172.19.0.2",
        hostPort: 4001,
        hostPortByContainerPort: { 3001: 4001, 3002: 4002 },
      },
    });

    await applyProjectRouting("proj_1");

    expect(emittedRegisters()).toMatchObject([
      {
        hostname: "app.example.com",
        targetUrl: "http://127.0.0.1:4001",
        observedLoopbackPublishes: [{ serviceId: "svc_1", containerPort: 3001, hostPort: 4001 }],
      },
      {
        hostname: "admin.example.com",
        targetUrl: "http://127.0.0.1:4002",
        observedLoopbackPublishes: [{ serviceId: "svc_1", containerPort: 3002, hostPort: 4002 }],
      },
    ]);
  });

  it("preserves a service canonical redirect without claiming its suppressed upstream", async () => {
    projectRepo.findById.mockResolvedValue({
      ...project("loopback-port"),
      compositeRoutes: [],
    });
    serviceRepo.listByProject.mockResolvedValue([
      {
        id: "svc_1",
        projectId: "proj_1",
        name: "web",
        enabled: true,
        exposed: true,
        exposedPort: "3001",
        domainType: "custom",
        customDomain: "app.example.com",
        publicEndpoints: [
          { port: 3001, domainType: "custom", customDomain: "app.example.com" },
          { port: 3001, domainType: "custom", customDomain: "www.app.example.com" },
        ],
        ports: ["3001"],
        kind: "compose",
      },
    ]);
    domainRepo.listByProject.mockResolvedValue([
      {
        id: "dom-app",
        projectId: "proj_1",
        serviceId: "svc_1",
        hostname: "app.example.com",
        redirectTo: null,
        redirectStatus: null,
      },
      {
        id: "dom-www",
        projectId: "proj_1",
        serviceId: "svc_1",
        hostname: "www.app.example.com",
        redirectTo: "app.example.com",
        redirectStatus: 308,
      },
    ]);
    storeRow({
      ip: "172.19.0.2",
      hostPort: 4001,
      hostPorts: { "3001": 4001 },
    });
    runtimeReturning({
      info: {
        ip: "172.19.0.2",
        hostPort: 4001,
        hostPortByContainerPort: { 3001: 4001 },
      },
    });

    await applyProjectRouting("proj_1");

    const registers = emittedRegisters();
    expect(
      registers.find((register: { hostname: string }) => register.hostname === "app.example.com"),
    ).toMatchObject({
      observedLoopbackPublishes: [{ serviceId: "svc_1", containerPort: 3001, hostPort: 4001 }],
    });
    const redirect = registers.find(
      (register: { hostname: string }) => register.hostname === "www.app.example.com",
    );
    expect(redirect).toMatchObject({
      redirectHost: { target: "app.example.com", statusCode: 308 },
    });
    expect(redirect.observedLoopbackPublishes).toBeUndefined();
  });
});

/**
 * The live re-apply has to be able to produce the SAME vhost the deploy produces,
 * for the flagship monorepo shape: one static frontend served from a host directory
 * plus one server backend proxied at a prefix. It could not — the frontend has no
 * container and no port, so its upstream resolved to null, `buildCompositeRegistration`
 * refused, and a routing save (or the Retry-routing button) wrote nothing and said
 * nothing. The directory is on the active deployment's `service_deployment.image_ref`;
 * these tests pin that it is read, and that a composite we still cannot build is
 * reported rather than swallowed.
 */
describe("applyProjectRouting — static frontend composite", () => {
  const web = {
    id: "svc_web",
    projectId: "proj_1",
    name: "web",
    kind: "monorepo",
    framework: "vite",
    startCommand: null,
    enabled: true,
    // Exposed WITH a port, like a real static sub-app row: the port is what earns it
    // a hostname. It just has nothing listening on it — no container, so no live
    // upstream — which is exactly why the release directory has to back `/`.
    exposed: true,
    exposedPort: "4173",
    ports: [],
    domain: null,
    customDomain: "app.example.com",
    domainType: "custom",
    publicEndpoints: null,
  };
  const api = {
    id: "svc_api",
    projectId: "proj_1",
    name: "api",
    kind: "monorepo",
    framework: "express",
    startCommand: "npm start",
    enabled: true,
    exposed: true,
    exposedPort: "3000",
    ports: [],
    domain: null,
    customDomain: null,
    domainType: null,
    publicEndpoints: null,
  };
  const RELEASE_DIR = "/opt/openship/static/releases/dep_1-web";

  /** The static frontend owns no container — only the promoted release directory. */
  function rows(webImageRef: string | null) {
    serviceRepo.listByDeployment.mockResolvedValue([
      {
        id: "sd_web",
        serviceId: "svc_web",
        deploymentId: "dep_1",
        containerId: null,
        imageRef: webImageRef,
        ip: null,
        hostPort: null,
      },
      {
        id: "sd_api",
        serviceId: "svc_api",
        deploymentId: "dep_1",
        containerId: "container_api",
        imageRef: "openship/api:bld_1",
        ip: "172.19.0.5",
        hostPort: null,
      },
    ]);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // No fan-out routes: the only register that may appear is the composite.
    projectRepo.findById.mockResolvedValue({ ...project(), compositeRoutes: [] });
    deploymentRepo.findById.mockResolvedValue({
      id: "dep_1",
      organizationId: "org_1",
      meta: { deployTarget: "local", runtimeMode: "docker" },
    });
    serviceRepo.listByProject.mockResolvedValue([web, api]);
    domainRepo.listByProject.mockResolvedValue([]);
    rows(RELEASE_DIR);
    runtimeReturning({ info: {}, ip: "172.19.0.5" });
    usesManagedRouting.mockReturnValue(false);
    reconcileProjectRoutes.mockResolvedValue(undefined);
  });

  it("serves the frontend from its release directory and proxies the backend", async () => {
    await applyProjectRouting("proj_1");

    const registers = emittedRegisters();
    expect(registers).toHaveLength(2);
    expect(registers[0]).toMatchObject({
      hostname: "app.example.com",
      staticRoot: RELEASE_DIR,
    });
    expect(registers[0].proxyLocations).toBeUndefined();
    const register = registers.at(-1);
    expect(register).toMatchObject({
      hostname: "app.example.com",
      staticRoot: RELEASE_DIR,
      proxyLocations: [{ pathPrefix: "/api/", targetUrl: "http://172.19.0.5:3000" }],
    });
    // Files at `/` OR an upstream at `/`, never both — an undefined targetUrl reaching
    // the edge is `Invalid proxy target: undefined`.
    expect(register.targetUrl).toBeUndefined();
  });

  it("ignores an image tag in the same column", async () => {
    // `image_ref` is polymorphic: a containerized service's tag lives there too, and
    // handing `openship/web:bld_1` to nginx as a `root` would emit a broken vhost.
    rows("openship/web:bld_1");

    await applyProjectRouting("proj_1");

    expect(reconcileProjectRoutes).not.toHaveBeenCalled();
  });

  it("says why when the composite still cannot be built", async () => {
    rows(null);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await applyProjectRouting("proj_1");

    expect(reconcileProjectRoutes).not.toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(" ")).toMatch(
      /composite vhost not emitted.*frontend has neither a static root nor a live upstream/,
    );
    warn.mockRestore();
  });

  it("reports the backend, not the frontend, when only the backend is down", async () => {
    serviceRepo.listByDeployment.mockResolvedValue([
      {
        id: "sd_web",
        serviceId: "svc_web",
        deploymentId: "dep_1",
        containerId: null,
        imageRef: RELEASE_DIR,
        ip: null,
        hostPort: null,
      },
      {
        id: "sd_api",
        serviceId: "svc_api",
        deploymentId: "dep_1",
        containerId: "container_api",
        imageRef: "openship/api:bld_1",
        ip: null,
        hostPort: null,
      },
    ]);
    runtimeReturning({ ip: null });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await applyProjectRouting("proj_1");

    expect(emittedRegisters()).toMatchObject([
      { hostname: "app.example.com", staticRoot: RELEASE_DIR },
    ]);
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).toMatch(/backend has no live upstream/);
    expect(logged).not.toMatch(/frontend has neither/);
    warn.mockRestore();
  });
});
