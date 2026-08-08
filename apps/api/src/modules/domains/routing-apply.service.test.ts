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

vi.mock("../../lib/deployment-runtime", () => ({
  resolveDeploymentRuntime,
  usesManagedRouting,
}));

vi.mock("../../lib/route-apply.service", () => ({
  reconcileProjectRoutes,
}));

vi.mock("../../lib/controller-helpers", () => ({
  platform: () => ({ target: "selfhosted" }),
}));

import { applyProjectRouting } from "./routing-apply.service";

describe("applyProjectRouting - same-server migration fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    projectRepo.findById.mockResolvedValue({
      id: "proj_1",
      activeDeploymentId: "dep_1",
      routeStrategy: "auto",
      routingConfig: null,
      compositeRoutes: [
        {
          hostname: "app.example.com",
          isCustomDomain: true,
          rootServiceId: "svc_1",
          locations: [],
        },
      ],
      slug: "app",
      cloudWorkspaceId: null,
      webhookDomain: null,
    });

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

    serviceRepo.listByDeployment.mockResolvedValue([
      {
        id: "sd_1",
        serviceId: "svc_1",
        deploymentId: "dep_1",
        containerId: "container_1",
        ip: null,
        hostPort: null,
      },
    ]);

    resolveDeploymentRuntime.mockResolvedValue({
      runtime: {
        name: "docker",
        supports: (cap: string) => cap === "containerIp",
        getContainerInfo: vi.fn().mockResolvedValue({
          containerId: "container_1",
          ip: "172.18.0.5",
          hostPort: undefined,
        }),
        getContainerIp: vi.fn().mockResolvedValue("172.18.0.5"),
      },
      routing: { registerRoute: vi.fn() },
      effectiveTarget: "local",
    });

    usesManagedRouting.mockReturnValue(false);
    reconcileProjectRoutes.mockResolvedValue(undefined);
  });

  it("falls back to the container IP when a migrated container has no loopback host port", async () => {
    await applyProjectRouting("proj_1");

    expect(reconcileProjectRoutes).toHaveBeenCalledTimes(1);
    const [projectArg, optsArg] = reconcileProjectRoutes.mock.calls[0];
    expect(projectArg.id).toBe("proj_1");
    expect(optsArg.registers).toHaveLength(1);
    expect(optsArg.registers[0]).toMatchObject({
      hostname: "app.example.com",
      targetUrl: "http://172.18.0.5:3001",
    });
  });

  it("uses a live loopback host port when the container has one bound", async () => {
    resolveDeploymentRuntime.mockResolvedValue({
      runtime: {
        name: "docker",
        supports: (cap: string) => cap === "containerInfo",
        getContainerInfo: vi.fn().mockResolvedValue({
          containerId: "container_1",
          ip: "172.18.0.5",
          hostPort: 4000,
        }),
        getContainerIp: vi.fn().mockResolvedValue("172.18.0.5"),
      },
      routing: { registerRoute: vi.fn() },
      effectiveTarget: "local",
    });

    await applyProjectRouting("proj_1");

    expect(reconcileProjectRoutes).toHaveBeenCalledTimes(1);
    const [, optsArg] = reconcileProjectRoutes.mock.calls[0];
    expect(optsArg.registers).toHaveLength(1);
    expect(optsArg.registers[0]).toMatchObject({
      hostname: "app.example.com",
      targetUrl: "http://127.0.0.1:4000",
    });
  });

  it("falls back to the container IP even when live inspection fails", async () => {
    resolveDeploymentRuntime.mockResolvedValue({
      runtime: {
        name: "docker",
        supports: () => true,
        getContainerInfo: vi.fn().mockRejectedValue(new Error("not found")),
        getContainerIp: vi.fn().mockResolvedValue("172.18.0.5"),
      },
      routing: { registerRoute: vi.fn() },
      effectiveTarget: "local",
    });

    await applyProjectRouting("proj_1");

    expect(reconcileProjectRoutes).toHaveBeenCalledTimes(1);
    const [, optsArg] = reconcileProjectRoutes.mock.calls[0];
    expect(optsArg.registers).toHaveLength(1);
    expect(optsArg.registers[0]).toMatchObject({
      hostname: "app.example.com",
      targetUrl: "http://172.18.0.5:3001",
    });
  });
});
