import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionContext } from "@repo/platform";

const h = vi.hoisted(() => ({
  find: vi.fn(),
  services: vi.fn(),
  rows: vi.fn(),
  active: vi.fn(),
  save: vi.fn(),
  runtime: vi.fn(),
  builds: vi.fn(),
  trigger: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("@repo/db", () => ({
  repos: {
    project: { findById: h.find, updateWorkloadReplicas: h.save },
    service: { listByProject: h.services, listByDeployment: h.rows },
  },
}));
vi.mock("@repo/platform/engine/lib/active-deployment", () => ({ findActiveDeployment: h.active }));
vi.mock("@repo/platform/engine/lib/project-runtime-lock", () => ({
  withLiveProjectRuntimeMutation: async (_id: string, work: (project: unknown) => unknown) =>
    work(await h.find()),
}));
vi.mock("@repo/platform/engine/lib/deployment-runtime", () => ({
  withDeploymentRuntime: h.runtime,
}));
vi.mock("@repo/platform/engine/modules/deployments/build.service", () => ({
  checkNoActiveBuild: h.builds,
  triggerDeployment: h.trigger,
}));

import { createWorkloadScalingOperations } from "@repo/platform/engine/modules/projects/workload-scaling.operations";
const ctx = { organizationId: "org", userId: "user" } as ExecutionContext;
const updatedAt = new Date("2026-11-17T00:00:00.000Z");
const project = () => ({
  id: "project",
  slug: "app",
  organizationId: "org",
  activeDeploymentId: "active",
  serverId: "server",
  clusterId: null,
  deployTarget: "server",
  runtimeMode: "docker",
  framework: "express",
  hasServer: true,
  updatedAt,
  replicas: 2,
});
const service = () => ({
  id: "api",
  projectId: "project",
  name: "api",
  kind: "compose",
  enabled: true,
  image: "team/api:stable",
  replicas: 3,
  updatedAt,
});
const status = { desired: 2, ready: 2, pods: [] };
const runtime = { supports: () => true, status: vi.fn(async () => status) };
const operations = createWorkloadScalingOperations(h.audit);
const input = () => ({
  replicas: 3,
  expectedDeploymentId: "active",
  expectedUpdatedAt: updatedAt.toISOString(),
});
beforeEach(() => {
  vi.resetAllMocks();
  h.find.mockResolvedValue(project());
  h.services.mockResolvedValue([]);
  h.rows.mockResolvedValue([{ serviceId: "api", containerId: "api-container" }]);
  h.active.mockResolvedValue({
    id: "active",
    containerId: "app-container",
    meta: { serverId: "server", replicas: 2, composeServices: [{ name: "api", replicas: 3 }] },
  });
  runtime.status.mockResolvedValue(status);
  h.runtime.mockImplementation(async (_dep, work) => work(runtime));
  h.save.mockResolvedValue(true);
  h.trigger.mockResolvedValue({ deployment: { id: "configuration-release" } });
});
describe("single-server replica operations", () => {
  it("reports observed and frozen counts without treating the saved count as readiness", async () => {
    h.find.mockResolvedValue({ ...project(), replicas: 4 });
    expect(await operations.getWorkloadScaling(ctx, "project", {})).toMatchObject({
      replicas: 4,
      activeReplicas: 2,
      status,
      unavailableReason: null,
    });
  });
  it("uses the existing configuration release and atomically saves the reviewed version", async () => {
    expect(await operations.scaleWorkload(ctx, "project", input())).toEqual({
      deploymentId: "configuration-release",
    });
    expect(h.save).toHaveBeenCalledWith(
      "project",
      expect.objectContaining({
        replicas: 3,
        expectedProjectUpdatedAt: updatedAt,
        expectedActiveDeploymentId: "active",
      }),
    );
    expect(h.trigger).toHaveBeenCalledWith(ctx, {
      projectId: "project",
      refresh: true,
      forceAll: true,
    });
  });
  it("changes only the selected service, while omitted service counts remain one", async () => {
    h.services.mockResolvedValue([service()]);
    await operations.scaleWorkload(ctx, "project", {
      ...input(),
      serviceId: "api",
      replicas: 4,
      expectedUpdatedAt: `${updatedAt.toISOString()}/${updatedAt.toISOString()}`,
    });
    expect(h.save).toHaveBeenCalledWith(
      "project",
      expect.objectContaining({
        serviceId: "api",
        replicas: 4,
        expectedServiceUpdatedAt: updatedAt,
      }),
    );
    expect(h.trigger).toHaveBeenCalledWith(ctx, {
      projectId: "project",
      refresh: true,
      serviceIds: ["api"],
      refreshServiceIds: ["api"],
    });
    h.services.mockResolvedValue([{ ...service(), replicas: null }]);
    expect(await operations.getWorkloadScaling(ctx, "project", { serviceId: "api" })).toMatchObject(
      { replicas: 1 },
    );
  });
  it("maps the materialized application row back to the same project count", async () => {
    h.services.mockResolvedValue([
      {
        ...service(),
        id: "app",
        name: "app",
        kind: "monorepo",
        image: null,
        sortOrder: -1,
        replicas: null,
      },
    ]);
    expect(await operations.getWorkloadScaling(ctx, "project", { serviceId: "app" })).toMatchObject(
      { replicas: 2, serviceId: null },
    );
    await operations.scaleWorkload(ctx, "project", { ...input(), serviceId: "app" });
    expect(h.save).toHaveBeenCalledWith(
      "project",
      expect.objectContaining({ serviceId: undefined }),
    );
  });
  it("refuses foreign projects and services before resolving any runtime", async () => {
    await expect(
      operations.getWorkloadScaling(ctx, "project", { serviceId: "foreign" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    h.find.mockResolvedValue({ ...project(), organizationId: "other" });
    await expect(operations.scaleWorkload(ctx, "project", input())).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(h.runtime).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
  });
  it.each(["version", "deployment", "concurrent edit"])(
    "refuses stale %s without queuing work",
    async (reason) => {
      const request = input();
      if (reason === "version") request.expectedUpdatedAt = "old";
      if (reason === "deployment") request.expectedDeploymentId = "old";
      if (reason === "concurrent edit") h.save.mockResolvedValue(false);
      await expect(operations.scaleWorkload(ctx, "project", request)).rejects.toMatchObject({
        code: "WORKLOAD_SCALING_CONFLICT",
      });
      expect(h.trigger).not.toHaveBeenCalled();
    },
  );
  it.each(["unsupported", "unreachable", "destination changed", "writable storage", "database"])(
    "refuses %s before changing intent",
    async (reason) => {
      if (reason === "unsupported")
        h.runtime.mockImplementation(async (_dep, work) => work({ supports: () => false }));
      if (reason === "unreachable") h.runtime.mockRejectedValue(new Error("Target unavailable"));
      if (reason === "destination changed")
        h.find.mockResolvedValue({ ...project(), serverId: "other" });
      if (reason === "writable storage")
        h.find.mockResolvedValue({ ...project(), volumes: ["data:/data"] });
      if (reason === "database") h.find.mockResolvedValue({ ...project(), framework: "postgres" });
      await expect(operations.scaleWorkload(ctx, "project", input())).rejects.toMatchObject({
        code: "WORKLOAD_REPLICAS_UNAVAILABLE",
      });
      expect(h.save).not.toHaveBeenCalled();
      expect(h.trigger).not.toHaveBeenCalled();
    },
  );
  it("does not change the configuration while another deployment is active", async () => {
    h.builds.mockRejectedValue(new Error("Deployment already running"));
    await expect(operations.scaleWorkload(ctx, "project", input())).rejects.toThrow(
      /already running/,
    );
    expect(h.save).not.toHaveBeenCalled();
  });
  it("uses the shared static-service classification, including inherited commands", async () => {
    h.services.mockResolvedValue([{ ...service(), kind: "monorepo", framework: "vite" }]);
    expect(await operations.getWorkloadScaling(ctx, "project", { serviceId: "api" })).toMatchObject(
      {
        unavailableReason: "Static files have no application process to replicate.",
      },
    );
    expect(h.runtime).not.toHaveBeenCalled();
    h.find.mockResolvedValue({ ...project(), startCommand: "node server.js" });
    expect(await operations.getWorkloadScaling(ctx, "project", { serviceId: "api" })).toMatchObject(
      {
        unavailableReason: null,
      },
    );
  });
  it("rejects scaling a provider with a shared namespace dependent", async () => {
    h.services.mockResolvedValue([
      service(),
      { ...service(), id: "sidecar", name: "sidecar", advanced: { networkMode: "service:api" } },
    ]);
    const view = await operations.getWorkloadScaling(ctx, "project", { serviceId: "api" });
    expect(view.unavailableReason).toContain('Service "sidecar" shares');
    expect(h.runtime).not.toHaveBeenCalled();
  });
});
