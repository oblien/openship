import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  readRuntime: vi.fn(), resolvePlatform: vi.fn(), ensureWorkspace: vi.fn(),
  deploy: vi.fn(), serviceQuota: vi.fn(), plan: vi.fn(), resources: vi.fn(),
  containers: vi.fn(), start: vi.fn(), dispose: vi.fn(),
}));
vi.mock("@repo/platform/engine/config/env", async original => {
  const actual = await original<typeof import("@repo/platform/engine/config/env")>();
  return { ...actual, env: { ...actual.env, CLOUD_MODE: true } };
});
vi.mock("@repo/platform/engine/lib/deployment-runtime", async original => ({
  ...await original<typeof import("@repo/platform/engine/lib/deployment-runtime")>(),
  resolveDeploymentRuntimeForRead: h.readRuntime,
  resolveDeploymentPlatform: h.resolvePlatform,
}));
vi.mock("@repo/platform/engine/lib/cloud-docker-workspace", async original => ({
  ...await original<typeof import("@repo/platform/engine/lib/cloud-docker-workspace")>(),
  ensureCloudDockerWorkspace: h.ensureWorkspace,
}));
vi.mock("@repo/platform/engine/lib/plan-guard", async original => ({
  ...await original<typeof import("@repo/platform/engine/lib/plan-guard")>(),
  assertPlanAllowsServices: h.plan,
  assertRunningServiceQuota: h.serviceQuota,
  assertCloudDeploymentLimits: h.resources,
  assertCloudRuntimeLimits: vi.fn(),
}));
vi.mock("@repo/platform/engine/modules/deployments/compose/deploy.service", () => ({
  deployComposeServices: h.deploy,
}));

import { db, schema, repos } from "@repo/db";
import { AppError } from "@repo/core";
import type { ExecutionContext } from "@repo/platform";
import { startServiceContainer } from "@repo/platform/engine/modules/services/service.service";

let sequence = 0;
let organizationId: string, projectId: string, deploymentId: string, workspaceId: string, managedWorkspaceId: string, serverId: string;
let webId: string, databaseId: string, addedId: string;
let docker: boolean;
const resources = { cpuCores: 1, memoryMb: 1024, diskMb: 4096 };
const buildResources = { cpuCores: 1, memoryMb: 512, diskMb: 4096 };
const runtime = {
  name: "docker",
  supports: (cap: string) => cap === "multiServiceDeploy" || (docker && ["hostContainerQuery", "dockerHost"].includes(cap)),
  listAllContainers: h.containers,
  start: h.start,
  dispose: h.dispose,
};
const ctx = () => ({ organizationId }) as ExecutionContext;

async function recorded(serviceId: string, containerId: string, memoryMb = 1024) {
  await repos.service.upsertServiceDeployment({
    deploymentId, serviceId, serviceName: serviceId, containerId, status: "success",
    allocatedResources: { containerId, cpuCores: 1, memoryMb },
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  for (const mock of [h.readRuntime, h.ensureWorkspace, h.plan, h.serviceQuota, h.resources, h.start]) mock.mockReset();
  const suffix = `cloud-start-${++sequence}`;
  organizationId = `org-${suffix}`; projectId = `proj-${suffix}`;
  deploymentId = `dep-${suffix}`; workspaceId = `workspace-${suffix}`;
  webId = `web-${suffix}`; databaseId = `db-${suffix}`; addedId = `added-${suffix}`;
  docker = true;
  await db.insert(schema.organization).values({ id: organizationId, name: suffix, slug: suffix, createdAt: new Date() });
  const managed = await repos.cloudWorkspace.create({ organizationId, name: "Test server" });
  managedWorkspaceId = managed.id;
  serverId = (await repos.server.findByWorkspace(managed.id, organizationId))!.id;
  await db.insert(schema.projectGroup).values({ id: `group-${suffix}`, organizationId, name: suffix, slug: suffix });
  await db.insert(schema.project).values({ id: projectId, groupId: `group-${suffix}`, organizationId,
    name: suffix, slug: suffix, resources, buildResources, serverId });
  await db.insert(schema.deployment).values({ id: deploymentId, projectId, organizationId, branch: "main", status: "ready",
    meta: { deployTarget: "cloud", serverId, managedWorkspaceId, runtimeMode: "docker", serviceDeploymentMode: "services", resources, buildResources,
      managedServer: { projectId, workspaceId } } });
  await repos.project.update(projectId, { activeDeploymentId: deploymentId });
  await db.insert(schema.service).values([
    { id: webId, projectId, name: "web", image: "nginx:alpine", advanced: { resources: { ...resources, memoryMb: 128 } } },
    { id: databaseId, projectId, name: "database", image: "postgres:18", enabled: false },
    { id: addedId, projectId, name: "cache", image: "redis:8", enabled: true,
      advanced: { resources: { ...resources, memoryMb: 2048 } }, volumes: ["cache-data:/data"] },
  ]);
  await recorded(webId, "web-container", 2048);
  await recorded(databaseId, "database-container");
  h.containers.mockResolvedValue([
    { id: "web-container", names: ["web"], state: "running", labels: { "openship.project": projectId, "openship.service": "web" } },
    { id: "database-container", names: ["database"], state: "running", labels: { "openship.project": projectId, "openship.service": "database" } },
  ]);
  h.readRuntime.mockResolvedValue({ runtime, serverId: null });
  h.resolvePlatform.mockResolvedValue({ platform: { runtime, routing: {}, ssl: {}, system: null, executor: null, localHost: false },
    effectiveTarget: "cloud", serverId: null, usesManagedRouting: false, hostPortTarget: null });
  h.ensureWorkspace.mockResolvedValue({ projectId, workspaceId });
  h.deploy.mockResolvedValue({ status: "ready", services: [{ serviceId: addedId, serviceName: "cache", status: "running", containerId: "cache-container" }] });
});

describe("Cloud service Start placement and recovery", () => {
  it("adds a service to the same managed server without resizing it or changing the active release", async () => {
    const before = await repos.deployment.findById(deploymentId);
    await expect(startServiceContainer(ctx(), projectId, addedId)).resolves.toMatchObject({ containerId: "cache-container" });
    expect(h.ensureWorkspace).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      projectId, organizationId, existingWorkspaceId: workspaceId,
    }));
    expect(h.ensureWorkspace.mock.calls[0]![0]).not.toHaveProperty("resources");
    // Existing containers keep their resources; service Start cannot resize the server.
    expect(h.resolvePlatform).toHaveBeenCalledWith(expect.objectContaining({ managedServer: { projectId, workspaceId } }), { organizationId });
    expect(h.deploy).toHaveBeenCalledWith(expect.anything(), expect.anything(), runtime, expect.anything(), expect.objectContaining({
      targetServiceIds: new Set([addedId]), strictScope: true,
    }));
    expect(h.ensureWorkspace.mock.invocationCallOrder[0]).toBeLessThan(h.resolvePlatform.mock.invocationCallOrder[0]!);
    expect((await repos.deployment.findById(deploymentId))?.meta).toEqual(before?.meta);
    expect((await repos.project.findById(projectId))?.activeDeploymentId).toBe(deploymentId);
    expect((await repos.service.listByDeployment(deploymentId)).map(row => row.containerId).sort())
      .toEqual(["database-container", "web-container"]);
  });

  it("runs services beside a bare application using Docker on that same server", async () => {
    docker = true;
    await repos.deployment.updateStatus(deploymentId, "ready", {
      meta: { deployTarget: "cloud", serverId, managedWorkspaceId, runtimeMode: "bare", serviceDeploymentMode: "single", resources, managedServer: { projectId, workspaceId } },
    });
    await repos.service.update(addedId, { volumes: [] });
    h.deploy.mockResolvedValue({ status: "ready", services: [{ serviceId: addedId, status: "running", containerId: "new-docker-service" }] });
    await expect(startServiceContainer(ctx(), projectId, addedId))
      .resolves.toMatchObject({ containerId: "new-docker-service" });
    expect(h.ensureWorkspace).toHaveBeenCalledOnce();
    expect(h.resolvePlatform.mock.calls[0]![0]).toMatchObject({ serviceDeploymentMode: "single", runtimeMode: "docker", serverId, managedWorkspaceId });
    expect((await repos.project.findById(projectId))?.workspaceId).toBe(managedWorkspaceId);
  });

  it("starts an existing container without resizing the workspace or provisioning", async () => {
    await recorded(addedId, "cache-container", 2048);
    h.containers.mockResolvedValue([{ id: "cache-container", names: ["cache"], state: "exited",
      labels: { "openship.project": projectId, "openship.service": "cache" } }]);
    await startServiceContainer(ctx(), projectId, addedId);
    expect(h.start).toHaveBeenCalledExactlyOnceWith("cache-container");
    expect(h.ensureWorkspace).not.toHaveBeenCalled();
    expect(h.deploy).not.toHaveBeenCalled();
  });

  it.each(["runtime", "inventory"])("does not provision when the %s lookup fails", async phase => {
    const failure = new Error("Provider connection unavailable");
    (phase === "runtime" ? h.readRuntime : h.containers).mockRejectedValue(failure);
    await expect(startServiceContainer(ctx(), projectId, addedId)).rejects.toBe(failure);
    expect(h.ensureWorkspace).not.toHaveBeenCalled();
    expect(h.deploy).not.toHaveBeenCalled();
    expect(await repos.service.findById(addedId)).toMatchObject({ id: addedId, volumes: ["cache-data:/data"] });
  });

  it("allows an explicit Start to resume the same stopped Compose workspace before adding a container", async () => {
    h.containers.mockRejectedValue(new AppError("Workspace is stopped", 409, "CLOUD_WORKSPACE_STOPPED"));
    await expect(startServiceContainer(ctx(), projectId, addedId)).resolves.toMatchObject({ containerId: "cache-container" });
    expect(h.ensureWorkspace).toHaveBeenCalledWith(expect.objectContaining({ existingWorkspaceId: workspaceId }));
  });

  it("leaves the saved service intact when server connection fails", async () => {
    h.ensureWorkspace.mockRejectedValue(new Error("Server unavailable"));
    await expect(startServiceContainer(ctx(), projectId, addedId)).rejects.toThrow("Server unavailable");
    expect(h.resolvePlatform).not.toHaveBeenCalled();
    expect(h.deploy).not.toHaveBeenCalled();
    expect(await repos.service.findById(addedId)).toMatchObject({ id: addedId, volumes: ["cache-data:/data"] });
  });

  it("does not add a service during an active build", async () => {
    await db.insert(schema.deployment).values({ id: `${deploymentId}-building`, projectId, organizationId,
      branch: "main", status: "building", meta: {} });
    await expect(startServiceContainer(ctx(), projectId, addedId)).rejects.toMatchObject({ code: "DEPLOYMENT_IN_PROGRESS" });
    expect(h.ensureWorkspace).not.toHaveBeenCalled();
    expect(h.deploy).not.toHaveBeenCalled();
  });

  it("checks the service allowance before starting compute or enabling the service", async () => {
    await repos.service.update(addedId, { enabled: false });
    h.serviceQuota.mockRejectedValue(new AppError("Service allowance used", 402, "PLAN_UPGRADE_REQUIRED"));
    await expect(startServiceContainer(ctx(), projectId, addedId)).rejects.toMatchObject({ code: "PLAN_UPGRADE_REQUIRED" });
    expect(h.readRuntime).not.toHaveBeenCalled();
    expect(h.ensureWorkspace).not.toHaveBeenCalled();
    expect((await repos.service.findById(addedId))?.enabled).toBe(false);
  });

  it("refuses a frozen server binding belonging to another project", async () => {
    await repos.deployment.updateStatus(deploymentId, "ready", {
      meta: { deployTarget: "cloud", managedServer: { projectId: "different-project", workspaceId } },
    });
    await expect(startServiceContainer(ctx(), projectId, addedId)).rejects.toMatchObject({ code: "CLOUD_WORKSPACE_NOT_FOUND" });
    expect(h.ensureWorkspace).not.toHaveBeenCalled();
    expect(h.deploy).not.toHaveBeenCalled();
  });

  it("requires the build pipeline for a new source service before allocating more compute", async () => {
    await repos.service.update(addedId, { image: null, build: "." });
    await expect(startServiceContainer(ctx(), projectId, addedId)).rejects.toMatchObject({ code: "SERVICE_BUILD_REQUIRED" });
    expect(h.ensureWorkspace).not.toHaveBeenCalled();
    expect(h.deploy).not.toHaveBeenCalled();
  });

  it("directs repository bind mounts through deployment before resizing or pulling images", async () => {
    await repos.service.update(addedId, { volumes: ["./redis.conf:/etc/redis.conf:ro"] });
    await expect(startServiceContainer(ctx(), projectId, addedId)).rejects.toMatchObject({ code: "SERVICE_SOURCE_REQUIRED" });
    expect(h.ensureWorkspace).not.toHaveBeenCalled();
    expect(h.deploy).not.toHaveBeenCalled();
  });

  it.each(["indeterminate", "missing"])("does not report a successful Start when the target is %s", async outcome => {
    h.deploy.mockResolvedValue({ status: outcome === "indeterminate" ? "reconciling" : "ready",
      services: outcome === "indeterminate" ? [{ serviceId: addedId, status: "indeterminate" }] : [] });
    await expect(startServiceContainer(ctx(), projectId, addedId)).rejects.toMatchObject({ code: "SERVICE_START_UNVERIFIED" });
    expect(await repos.service.findById(addedId)).toMatchObject({ id: addedId, image: "redis:8" });
  });
});
