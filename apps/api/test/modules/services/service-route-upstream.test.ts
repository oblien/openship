import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Publishing a domain on a service is the migration CUTOVER path: the wizard
 * calls `updateService({ exposed, exposedPort, domainType, customDomain })` once
 * the new deployment is verified healthy. A same-server migration attaches a
 * container that was never published to `127.0.0.1`, so the upstream that gets
 * registered here has to come from the LIVE container — not from a
 * `service_deployment` row that may still carry a host port from an earlier
 * deploy. Getting that backwards is #506: a healthy app, a Verified domain, and
 * an edge dialing a loopback port nothing listens on.
 */

const projectRepo = vi.hoisted(() => ({ findById: vi.fn() }));
const serviceRepo = vi.hoisted(() => ({
  findById: vi.fn(),
  findByName: vi.fn(),
  listByProject: vi.fn(),
  listByDeployment: vi.fn(),
  update: vi.fn(),
}));
const deploymentRepo = vi.hoisted(() => ({ findById: vi.fn() }));
const domainRepo = vi.hoisted(() => ({ listByProject: vi.fn() }));

vi.mock("@repo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/db")>();
  return {
    ...actual,
    repos: {
      ...actual.repos,
      project: projectRepo,
      service: serviceRepo,
      deployment: deploymentRepo,
      domain: domainRepo,
    },
  };
});

vi.mock("../../../src/lib/free-domain-guard", () => ({ assertFreeEndpointsAllowed: vi.fn() }));

vi.mock("../../../src/modules/domains/domain.service", () => ({
  ensurePendingServiceDomain: vi.fn().mockResolvedValue({ created: false }),
  removeServiceDomain: vi.fn(),
  reuseServerCertForDomain: vi.fn(),
}));

const reconcileProjectRoutes = vi.hoisted(() => vi.fn());
vi.mock("../../../src/lib/route-apply.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/route-apply.service")>();
  return { ...actual, reconcileProjectRoutes };
});

vi.mock("../../../src/lib/controller-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/controller-helpers")>();
  return { ...actual, platform: () => ({ runtime: { name: "docker" } }) };
});

const resolveDeploymentRuntimeForRead = vi.hoisted(() => vi.fn());
vi.mock("../../../src/lib/deployment-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/deployment-runtime")>();
  return { ...actual, resolveDeploymentRuntimeForRead };
});

import { updateService } from "../../../src/modules/services/service.service";

const ctx = { organizationId: "org_1" } as never;
const project = {
  id: "proj_1",
  organizationId: "org_1",
  slug: "kuma",
  activeDeploymentId: "dep_1",
  routeStrategy: "auto",
};

/** A migrated single-service project: listens on 3001, custom domain attached. */
const migratedService = () => ({
  id: "svc_1",
  projectId: project.id,
  name: "uptime-kuma",
  kind: "compose",
  enabled: true,
  environment: {},
  ports: [],
  exposed: true,
  exposedPort: "3001",
  domain: null,
  customDomain: "status.example.com",
  domainType: "custom",
  publicEndpoints: null,
});

/** The container as docker actually reports it. */
function liveContainer(info: { ip?: string; hostPort?: number } | null) {
  const dispose = vi.fn().mockResolvedValue(undefined);
  resolveDeploymentRuntimeForRead.mockResolvedValue({
    serverId: "srv_1",
    runtime: {
      name: "docker",
      supports: (cap: string) => cap === "containerIp" || cap === "containerInfo",
      getContainerInfo: vi.fn(async () => {
        if (!info) throw new Error("daemon unreachable");
        return { containerId: "container_1", status: "running", ...info };
      }),
      getContainerIp: vi.fn(async () => info?.ip ?? null),
      dispose,
    },
  });
  return { dispose };
}

/** What the edge was told to proxy this hostname at. */
const registeredTarget = () => {
  const [, opts] = reconcileProjectRoutes.mock.calls.at(-1) ?? [];
  return (opts as { registers?: Array<{ hostname: string; targetUrl?: string }> })?.registers?.find(
    (r) => r.hostname === "status.example.com",
  );
};

/** The exact call the migration cutover makes to publish a route. */
const publishRoute = () =>
  updateService(ctx, project.id, "svc_1", {
    exposed: true,
    exposedPort: "3001",
    domainType: "custom",
    customDomain: "status.example.com",
  } as never);

describe("service route upstream (migration cutover)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projectRepo.findById.mockResolvedValue(project);
    serviceRepo.findById.mockResolvedValue(migratedService());
    serviceRepo.findByName.mockResolvedValue(null);
    serviceRepo.listByProject.mockResolvedValue([migratedService()]);
    serviceRepo.update.mockResolvedValue(undefined);
    domainRepo.listByProject.mockResolvedValue([]);
    reconcileProjectRoutes.mockResolvedValue(undefined);
    deploymentRepo.findById.mockResolvedValue({
      id: "dep_1",
      organizationId: "org_1",
      meta: { deployTarget: "server", serverId: "srv_1", runtimeMode: "docker" },
    });
    // The row still claims a loopback publish from an earlier deploy.
    serviceRepo.listByDeployment.mockResolvedValue([
      {
        serviceId: "svc_1",
        deploymentId: "dep_1",
        containerId: "container_1",
        ip: "172.19.0.2",
        hostPort: 3001,
      },
    ]);
    liveContainer({ ip: "172.19.0.2" });
  });

  it("registers the container IP when the migrated container publishes no loopback port", async () => {
    await publishRoute();

    // NOT http://127.0.0.1:3001 — nothing is listening there.
    expect(registeredTarget()?.targetUrl).toBe("http://172.19.0.2:3001");
  });

  it("registers the live loopback port when the container does publish one", async () => {
    liveContainer({ ip: "172.19.0.2", hostPort: 43001 });

    await publishRoute();

    expect(registeredTarget()?.targetUrl).toBe("http://127.0.0.1:43001");
  });

  it("does not re-register a cached upstream when the container cannot be inspected", async () => {
    liveContainer(null);

    await publishRoute();

    expect(registeredTarget()?.targetUrl).toBeUndefined();
  });

  it("does not re-register a cache when the target runtime cannot be resolved", async () => {
    resolveDeploymentRuntimeForRead.mockRejectedValueOnce(new Error("host unavailable"));

    await publishRoute();

    expect(registeredTarget()?.targetUrl).toBeUndefined();
  });

  it("releases the runtime it opened to inspect the container", async () => {
    const { dispose } = liveContainer({ ip: "172.19.0.2" });

    await publishRoute();

    expect(dispose).toHaveBeenCalled();
  });

  it("does not route a stored bridge IP when the service has no container", async () => {
    serviceRepo.listByDeployment.mockResolvedValue([
      {
        serviceId: "svc_1",
        deploymentId: "dep_1",
        containerId: null,
        ip: "172.19.0.2",
        hostPort: null,
      },
    ]);

    await publishRoute();

    expect(resolveDeploymentRuntimeForRead).not.toHaveBeenCalled();
    expect(registeredTarget()?.targetUrl).toBeUndefined();
  });
});
