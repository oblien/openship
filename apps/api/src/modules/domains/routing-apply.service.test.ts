import { beforeEach, describe, expect, it, vi } from "vitest";

const projectRepo = vi.hoisted(() => ({ findById: vi.fn() }));
const deploymentRepo = vi.hoisted(() => ({ findById: vi.fn() }));
const serviceRepo = vi.hoisted(() => ({ listByProject: vi.fn(), listByDeployment: vi.fn() }));

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

/** The single register `applyProjectRouting` emitted for the fan-out domain. */
function emittedRegister() {
  expect(reconcileProjectRoutes).toHaveBeenCalledTimes(1);
  const [, opts] = reconcileProjectRoutes.mock.calls[0];
  expect(opts.registers).toHaveLength(1);
  return opts.registers[0];
}

function runtimeReturning(opts: {
  /** undefined → the live inspect throws. */
  info?: { status?: string; ip?: string; hostPort?: number };
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
function storeRow(row: { containerId?: string | null; ip?: string | null; hostPort?: number | null }) {
  serviceRepo.listByDeployment.mockResolvedValue([
    { id: "sd_1", serviceId: "svc_1", deploymentId: "dep_1", containerId: "container_1", ip: null, hostPort: null, ...row },
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

  it("keeps the last-known upstream when the container cannot be inspected", async () => {
    // A failed inspect is not evidence that nothing is published, so the working
    // vhost must survive the re-apply rather than being repointed or dropped.
    storeRow({ ip: "172.19.0.2", hostPort: 4000 });
    runtimeReturning({ ip: null });

    await applyProjectRouting("proj_1");

    expect(emittedRegister().targetUrl).toBe("http://127.0.0.1:4000");
  });

  it("falls back to the stored row for a service with no container yet", async () => {
    storeRow({ containerId: null, ip: "172.19.0.2" });

    await applyProjectRouting("proj_1");

    expect(emittedRegister().targetUrl).toBe("http://172.19.0.2:3001");
  });

  it("honours an explicit container-ip strategy over a published host port", async () => {
    projectRepo.findById.mockResolvedValue(project("container-ip"));
    storeRow({ ip: "172.19.0.2", hostPort: 4000 });
    runtimeReturning({ info: { ip: "172.19.0.2", hostPort: 4000 } });

    await applyProjectRouting("proj_1");

    expect(emittedRegister().targetUrl).toBe("http://172.19.0.2:3001");
  });
});
