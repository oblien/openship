import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  project: {
    id: "proj_1",
    organizationId: "org_1",
    slug: "app",
    activeDeploymentId: "dep_1",
    isControlPlane: false,
    resources: null,
  },
  deployment: {
    id: "dep_1",
    organizationId: "org_1",
    projectId: "proj_1",
    environment: "production",
    meta: { framework: "vite", startCommand: "" },
  },
  service: {
    id: "svc_web",
    projectId: "proj_1",
    name: "web",
    kind: "monorepo",
    framework: null,
    startCommand: null,
    image: "/opt/openship/static/releases/dep_1-svc_web",
    build: null,
    enabled: true,
  },
  deployComposeServices: vi.fn(),
  resolveDeploymentRuntimeForRead: vi.fn(),
  resolveServicePlatform: vi.fn(),
  liveContainerIdWithRuntime: vi.fn(),
  assertPlanAllowsServices: vi.fn(),
}));

const runtime = {
  name: "docker",
  supports: (capability: string) => capability === "multiServiceDeploy",
  dispose: vi.fn(async () => undefined),
};

vi.mock("@repo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/db")>();
  return {
    ...actual,
    repos: {
      ...actual.repos,
      project: {
        ...actual.repos.project,
        findById: vi.fn(async () => h.project),
      },
      deployment: {
        ...actual.repos.deployment,
        findById: vi.fn(async () => h.deployment),
      },
      service: {
        ...actual.repos.service,
        listByProject: vi.fn(async () => [h.service]),
        listByDeployment: vi.fn(async () => [
          {
            id: "sd_1",
            deploymentId: "dep_1",
            serviceId: "svc_web",
            containerId: null,
            status: "success",
            imageRef: h.service.image,
          },
        ]),
        update: vi.fn(async () => undefined),
        updateServiceDeployment: vi.fn(async () => undefined),
      },
    },
  };
});

vi.mock("@repo/platform/engine/lib/deployment-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/platform/engine/lib/deployment-runtime")>();
  return {
    ...actual,
    resolveDeploymentRuntimeForRead: h.resolveDeploymentRuntimeForRead,
  };
});

vi.mock("@repo/platform/engine/modules/services/service-container", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@repo/platform/engine/modules/services/service-container")>();
  return {
    ...actual,
    liveContainerIdWithRuntime: h.liveContainerIdWithRuntime,
    resolveServicePlatform: h.resolveServicePlatform,
  };
});

vi.mock("@repo/platform/engine/modules/deployments/compose/deploy.service", () => ({
  deployComposeServices: h.deployComposeServices,
}));

vi.mock("@repo/platform/engine/lib/plan-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/platform/engine/lib/plan-guard")>();
  return { ...actual, assertPlanAllowsServices: h.assertPlanAllowsServices };
});

import { startServiceContainer } from "@repo/platform/engine/modules/services/service.service";

const ctx = { organizationId: "org_1" } as never;

beforeEach(() => {
  vi.clearAllMocks();
  h.resolveDeploymentRuntimeForRead.mockResolvedValue({ runtime, serverId: null });
  h.liveContainerIdWithRuntime.mockResolvedValue(null);
  h.resolveServicePlatform.mockResolvedValue({
    platform: {
      runtime,
      routing: {},
      ssl: {},
      system: null,
      executor: null,
      localHost: false,
    },
    effectiveTarget: "server",
    hostPortTarget: null,
    usesManagedRouting: false,
    serverId: null,
  });
  h.assertPlanAllowsServices.mockResolvedValue(undefined);
  h.deployComposeServices.mockResolvedValue({
    status: "ready",
    summary: {
      total: 1,
      successful: 1,
      deployed: 0,
      failed: 0,
      indeterminate: 0,
      mutated: false,
      failedServices: [],
    },
    services: [
      {
        serviceId: "svc_web",
        serviceName: "web",
        status: "running",
        staticRoot: h.service.image,
        carried: true,
      },
    ],
  });
});

describe("direct service Start — static artifact classification", () => {
  it("passes effective snapshot-inherited static identity without fabricating provenance", async () => {
    await startServiceContainer(ctx, "proj_1", "svc_web");

    const options = h.deployComposeServices.mock.calls[0]?.[4];
    expect(options.staticServiceIds).toEqual(new Set(["svc_web"]));
    expect(options).not.toHaveProperty("staticArtifactRefs");
    expect(options).toMatchObject({
      targetServiceIds: new Set(["svc_web"]),
      strictScope: true,
    });
  });
});
