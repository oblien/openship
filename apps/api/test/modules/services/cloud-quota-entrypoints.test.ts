import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  tier: "starter",
  cloud: true,
  readRuntime: vi.fn(),
  readNamespace: vi.fn(),
  savedLimits: null as import("@repo/core").PlanLimits | null,
}));
vi.mock("@repo/platform/engine/config/env", async original => {
  const actual = await original<{ env: Record<string, unknown> }>();
  return { ...actual, env: { ...actual.env, get CLOUD_MODE() { return h.cloud; } } };
});
vi.mock("@repo/platform/engine/modules/billing/billing-oblien-quota", async (original) => ({
  ...(await original<
    typeof import("@repo/platform/engine/modules/billing/billing-oblien-quota")
  >()),
  syncOblienEntitlement: async () => ({
    tier: h.tier,
    limits: h.savedLimits ?? planLimits(h.tier),
    resourceLimits: resolvePlan(h.tier).oblienLimits,
  }),
}));
vi.mock("@repo/platform/engine/lib/deployment-runtime", async original => ({
  ...await original<typeof import("@repo/platform/engine/lib/deployment-runtime")>(),
  resolveDeploymentRuntimeForRead: h.readRuntime,
  withDeploymentRuntime: async (_dep: unknown, fn: (runtime: unknown, serverId: string | null) => Promise<unknown>) => {
    const { runtime, serverId } = await h.readRuntime(_dep);
    try { return await fn(runtime, serverId); }
    finally { runtime.dispose?.(); }
  },
}));
vi.mock("@repo/platform/engine/lib/oblien-client", () => ({
  getOblienClient: () => ({ namespaces: { get: h.readNamespace } }),
}));
import { db, schema, repos, seedOwner } from "../jobs/_harness";
import { eq } from "@repo/db";
import { resolvePlan } from "@repo/core";
import { savedLimits as planLimits } from "../../helpers/saved-cloud-offer";
import { createService, updateService, startServiceContainer, restartServiceContainer } from "@repo/platform/engine/modules/services/service.service";
import { createQueuedDeployment, type DeploymentConfigSnapshot } from "@repo/platform/engine/modules/deployments/build.service";
import { createServicesProjectWithId } from "@repo/platform/engine/modules/projects/project-crud.service";
import { enableProject } from "@repo/platform/engine/modules/projects/project-runtime.service";
import type { ExecutionContext as RequestContext } from "@repo/platform";

let organizationId: string, projectId: string, managedWorkspaceId: string, serverId: string;
let sequence = 0;
const id = (prefix: string) => `${prefix}-cloud-quota-${++sequence}`;
const resources = { cpuCores: 1, memoryMb: 1024, diskMb: 8192 };
const snapshot = (): DeploymentConfigSnapshot => ({
  repoUrl: "", branch: "main", framework: "node", buildImage: "", runtimeImage: "", packageManager: "",
  installCommand: "", buildCommand: "", outputDirectory: "", productionPaths: [], volumes: [], rootDirectory: "",
  port: 3000, startCommand: "node app.js", resources, buildResources: null, hasServer: true, hasBuild: false,
  deployTarget: "cloud", serverId, managedWorkspaceId, serviceDeploymentMode: "single",
});
async function project() {
  const projectId = id("project");
  const groupId = id("group");
  await db.insert(schema.projectGroup).values({ id: groupId, organizationId, name: groupId, slug: groupId });
  await db.insert(schema.project).values({ id: projectId, groupId, organizationId, name: projectId, slug: projectId, resources, serverId });
  return projectId;
}
async function activateProject() {
  const deploymentId = id("active");
  await db.insert(schema.deployment).values({
    id: deploymentId, projectId, organizationId, branch: "main", status: "ready",
    meta: { ...snapshot(), serviceDeploymentMode: "services", cloudApplicationSlot: false },
  });
  await repos.project.setActiveDeployment(projectId, deploymentId);
}
async function definition(enabled = true, advanced: Record<string, unknown> = {}) {
  const serviceId = id("service");
  await db.insert(schema.service).values({ id: serviceId, projectId, name: serviceId, enabled, image: "alpine:3", advanced });
  return serviceId;
}
async function deployedService(serviceId: string) {
  const deploymentId = id("deployment");
  await db.insert(schema.deployment).values({ id: deploymentId, projectId, organizationId,
    branch: "main", status: "ready", containerId: "deployed-container", meta: snapshot() });
  await db.update(schema.project).set({ activeDeploymentId: deploymentId }).where(eq(schema.project.id, projectId));
  await repos.service.upsertServiceDeployment({ deploymentId, serviceId, serviceName: serviceId,
    containerId: "deployed-container", status: "stopped" });
  return deploymentId;
}
function existingRuntime(appliedResources: { cpuCores: number; memoryMb: number }) {
  const runtime = { name: "docker", supports: (cap?: string) => cap === "dockerHost", start: vi.fn(), restart: vi.fn(), dispose: vi.fn(),
    getContainerInfo: vi.fn().mockResolvedValue({ containerId: "deployed-container", status: "stopped", resources: appliedResources }) };
  h.readRuntime.mockResolvedValue({ runtime, serverId, effectiveTarget: "cloud" });
  return runtime;
}
function queue(target: string, meta = snapshot()) {
  return createQueuedDeployment({ projectId: target, organizationId, branch: "main", environment: "production", framework: "node", meta, envVars: {} });
}
const composeSnapshot = (): DeploymentConfigSnapshot => ({
  ...snapshot(), serviceDeploymentMode: "services",
  composeServices: ["api", "database"].map(name => ({
    name, image: "alpine:3", ports: [], volumes: [], environment: {}, dependsOn: [],
  })),
});
const context = () => ({ organizationId } as RequestContext);
beforeEach(async () => {
  vi.clearAllMocks();
  h.tier = "starter";
  h.cloud = true;
  h.savedLimits = null;
  h.readNamespace.mockImplementation(async (slug: string) => ({
    success: true,
    data: {
      slug,
      effective_resource_limits: resolvePlan(h.tier).oblienLimits,
      allocated_resource_usage: { workspaces: 0, vcpus: 0, ram_mb: 0, disk_gb: 0, pending_updates: 0 },
    },
  }));
  const owner = await seedOwner(); organizationId = owner.orgId;
  const managed = await repos.cloudWorkspace.create({ organizationId, name: "Production" });
  managedWorkspaceId = managed.id;
  await repos.cloudWorkspace.setNamespace(managed.id, organizationId, `namespace-${organizationId}`);
  serverId = (await repos.server.findByWorkspace(managed.id, organizationId))!.id;
  projectId = await project();
  h.readRuntime.mockRejectedValue(new Error("Unexpected provider access"));
});

describe("Cloud quotas at real application mutation boundaries", () => {
  it("allows draft creation and enabling at the allowance but refuses its deployment", async () => {
    await activateProject();
    await definition();
    await definition();
    await definition();
    const draftId = await project();
    const draft = await createService(context(), draftId, {
      name: "draft-database",
      image: "postgres:17",
      environment: { POSTGRES_PASSWORD: "saved-secret" },
    });
    await updateService(context(), draftId, draft.id, { enabled: false });
    await updateService(context(), draftId, draft.id, { enabled: true });
    expect(await repos.service.countRunningForOrg(organizationId)).toBe(3);
    await expect(
      queue(draftId, {
        ...snapshot(),
        serviceDeploymentMode: "services",
        composeServices: [
          {
            name: draft.name,
            image: "postgres:17",
            ports: [],
            volumes: [],
            environment: {},
            dependsOn: [],
          },
        ],
      }),
    ).rejects.toMatchObject({ reason: "running-services" });
    expect(
      await db.query.deployment.findMany({ where: eq(schema.deployment.projectId, draftId) }),
    ).toEqual([]);
    expect(await repos.service.findById(draft.id)).toMatchObject({
      enabled: true,
      environment: { POSTGRES_PASSWORD: "saved-secret" },
    });
    expect(h.readRuntime).not.toHaveBeenCalled();
  });
  it("reserves first deployments atomically even when both drafts already have definitions", async () => {
    const drafts = [projectId, await project()];
    for (const draftId of drafts) {
      for (const name of ["api", "database"]) {
        await createService(context(), draftId, { name, image: "alpine:3" });
      }
    }
    expect(await repos.service.countRunningForOrg(organizationId)).toBe(0);
    const results = await Promise.allSettled(
      drafts.map((draftId) => queue(draftId, composeSnapshot())),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "PLAN_UPGRADE_REQUIRED", reason: "running-services" },
    });
    expect(await repos.service.countRunningForOrg(organizationId)).toBe(2);
  });

  it("enforces the paid service-count snapshot even when the current tier permits more", async () => {
    await activateProject();
    h.tier = "team";
    h.savedLimits = { ...planLimits("team"), runningServices: 2 };
    await definition();
    await definition();
    await expect(
      createService(context(), projectId, { name: "beyond-paid-contract", image: "alpine:3" }),
    ).rejects.toMatchObject({ reason: "running-services" });
    expect(await repos.service.countRunningForOrg(organizationId)).toBe(2);
  });
  it("enforces the paid machine-size snapshot before queueing new compute", async () => {
    h.tier = "team";
    h.savedLimits = { ...planLimits("team"), maxResourceTier: "low", maxServiceResources: undefined };
    await expect(queue(projectId)).rejects.toMatchObject({ reason: "resource-tier" });
    expect(
      await db.query.deployment.findMany({ where: eq(schema.deployment.projectId, projectId) }),
    ).toHaveLength(0);
  });
  it("serializes service creation so only one request can reserve the final slot", async () => {
    await activateProject();
    await definition(); await definition();
    const results = await Promise.allSettled([
      createService(context(), projectId, { name: "last-a", image: "alpine:3" }),
      createService(context(), projectId, { name: "last-b", image: "alpine:3" }),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "PLAN_UPGRADE_REQUIRED", reason: "running-services" } });
    expect(await repos.service.countRunningForOrg(organizationId)).toBe(3);
  });
  it("serializes re-enabling disabled definitions at the same limit", async () => {
    await activateProject();
    await definition(); await definition();
    const a = await definition(false), b = await definition(false);
    const results = await Promise.allSettled([
      updateService(context(), projectId, a, { enabled: true }),
      updateService(context(), projectId, b, { enabled: true }),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(await repos.service.countRunningForOrg(organizationId)).toBe(3);
  });
  it("reserves native app slots atomically when two projects deploy together", async () => {
    await activateProject();
    await definition(); await definition();
    const a = await project(), b = await project();
    const results = await Promise.allSettled([queue(a), queue(b)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { reason: "running-services" } });
    expect(await repos.service.countRunningForOrg(organizationId)).toBe(3);
    const winner = results.find(result => result.status === "fulfilled");
    if (winner?.status === "fulfilled") expect(winner.value.meta).toMatchObject({ cloudApplicationSlot: true });
  });
  it("includes other projects before queueing a stack whose definitions are not yet saved", async () => {
    await activateProject();
    await definition(); await definition();
    const target = await project();
    await expect(queue(target, composeSnapshot())).rejects.toMatchObject({ reason: "running-services" });
    expect(await db.query.deployment.findMany({ where: eq(schema.deployment.projectId, target) })).toEqual([]);
  });
  it("reserves frozen stack slots before a concurrent deployment or service creation can claim them", async () => {
    await activateProject();
    await definition();
    const a = await project(), b = await project();
    const results = await Promise.allSettled([queue(a, composeSnapshot()), queue(b, composeSnapshot())]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { reason: "running-services" } });
    expect(await repos.service.countRunningForOrg(organizationId)).toBe(3);
    await expect(createService(context(), projectId, { name: "overflow", image: "alpine:3" }))
      .rejects.toMatchObject({ reason: "running-services" });
  });
  it("permits an existing native app to redeploy at the allowance without counting it twice", async () => {
    await activateProject();
    await definition(); await definition();
    const target = await project();
    const activeId = id("deployment");
    await db.insert(schema.deployment).values({ id: activeId, projectId: target, organizationId, branch: "main", status: "ready", containerId: "native-vm", meta: snapshot() });
    await db.update(schema.project).set({ activeDeploymentId: activeId }).where(eq(schema.project.id, target));
    await expect(queue(target)).resolves.toMatchObject({ status: "queued" });
    expect(await repos.service.countRunningForOrg(organizationId)).toBe(3);
  });
  it("refuses an oversized saved update before creating a queued deployment", async () => {
    await expect(queue(projectId, { ...snapshot(), resources: { ...resources, memoryMb: 16384 } }))
      .rejects.toMatchObject({ reason: "resource-tier" });
    expect(await db.query.deployment.findMany({ where: eq(schema.deployment.projectId, projectId) })).toHaveLength(0);
  });
  it("checks the configured resources before provisioning a new service", async () => {
    const serviceId = await definition(true, { resources: { cpuCores: 32, memoryMb: 32768 } });
    const operation = startServiceContainer(context(), projectId, serviceId);
    await expect(operation).rejects.toMatchObject({ reason: "resource-tier" });
    expect(h.readRuntime).not.toHaveBeenCalled();
  });
  it.each(["start", "restart"])("refuses %s of an oversized deployed container after its saved settings were reduced", async action => {
    const serviceId = await definition(false, { resources });
    await deployedService(serviceId);
    const runtime = existingRuntime({ cpuCores: 32, memoryMb: 32768 });
    const operation = action === "start"
      ? startServiceContainer(context(), projectId, serviceId)
      : restartServiceContainer(context(), projectId, serviceId, { force: true });
    await expect(operation).rejects.toMatchObject({ reason: "resource-tier" });
    expect(runtime.start).not.toHaveBeenCalled();
    expect(runtime.restart).not.toHaveBeenCalled();
    expect((await repos.service.findById(serviceId))?.enabled).toBe(false);
    expect(runtime.dispose).toHaveBeenCalled();
  });
  it("restarts an allowed container even when an unapplied saved size is over the plan limit", async () => {
    const serviceId = await definition(true, { resources: { cpuCores: 32, memoryMb: 32768 } });
    await deployedService(serviceId);
    const runtime = existingRuntime(resources);
    await expect(restartServiceContainer(context(), projectId, serviceId, { force: true })).resolves.toMatchObject({ containerId: "deployed-container" });
    expect(runtime.restart).toHaveBeenCalledWith("deployed-container");
  });
  it.each(["matching", "missing", "different-container"])("validates a %s allocation record when the Cloud Docker host is stopped", async record => {
    const serviceId = await definition(false, { resources });
    const deploymentId = await deployedService(serviceId);
    const row = (await repos.service.listByDeployment(deploymentId))[0]!;
    if (record !== "missing") await repos.service.updateServiceDeployment(row.id, {
      allocatedResources: { containerId: record === "matching" ? "deployed-container" : "replaced-container", ...resources },
    });
    const runtime = existingRuntime(resources);
    runtime.supports = (cap?: string) => cap === "dockerHost";
    runtime.getContainerInfo.mockResolvedValue({ containerId: "deployed-container", status: "stopped" });
    const operation = startServiceContainer(context(), projectId, serviceId);
    if (record === "matching") {
      await expect(operation).resolves.toMatchObject({ containerId: "deployed-container" });
      expect(runtime.start).toHaveBeenCalledOnce();
    } else {
      await expect(operation).rejects.toMatchObject({ code: "RESOURCE_LIMITS_UNAVAILABLE" });
      expect(runtime.start).not.toHaveBeenCalled();
      expect((await repos.service.findById(serviceId))?.enabled).toBe(false);
    }
  });
  it("checks all deployed allocations before resuming any container", async () => {
    const first = await definition(false), second = await definition(false);
    const deploymentId = await deployedService(first);
    await db.update(schema.deployment).set({ meta: { ...snapshot(), serviceDeploymentMode: "services" } }).where(eq(schema.deployment.id, deploymentId));
    await repos.service.upsertServiceDeployment({ deploymentId, serviceId: second, serviceName: second,
      containerId: "oversized-container", status: "stopped" });
    await repos.project.update(projectId, { disabledAt: new Date() });
    const runtime = existingRuntime(resources);
    runtime.getContainerInfo.mockImplementation(async (containerId: string) => ({ containerId, status: "stopped",
      resources: containerId === "oversized-container" ? { cpuCores: 32, memoryMb: 32768 } : resources }));
    await expect(enableProject(projectId, organizationId)).rejects.toMatchObject({ reason: "resource-tier" });
    expect(runtime.start).not.toHaveBeenCalled();
    expect((await repos.project.findById(projectId))?.disabledAt).not.toBeNull();
  });
  it("counts disabled definitions whose recorded containers would be resumed", async () => {
    await definition(); await definition(); await definition();
    const target = await definition(false);
    const deploymentId = await deployedService(target);
    await db.update(schema.deployment).set({ meta: { ...snapshot(), serviceDeploymentMode: "services" } }).where(eq(schema.deployment.id, deploymentId));
    await repos.project.update(projectId, { disabledAt: new Date() });
    await expect(enableProject(projectId, organizationId)).rejects.toMatchObject({ reason: "running-services" });
    expect(h.readRuntime).not.toHaveBeenCalled();
    expect((await repos.project.findById(projectId))?.disabledAt).not.toBeNull();
  });
  it("does not enable a stopped definition when Start is over quota", async () => {
    await activateProject();
    await definition(); await definition(); await definition();
    const target = await definition(false);
    await expect(startServiceContainer(context(), projectId, target)).rejects.toMatchObject({ reason: "running-services" });
    expect((await repos.service.findById(target))?.enabled).toBe(false);
    expect(h.readRuntime).not.toHaveBeenCalled();
  });
  it("refuses resuming a paused native project after other services fill its slot", async () => {
    await activateProject();
    await definition(); await definition(); await definition();
    const target = await project(), activeId = id("deployment");
    await db.insert(schema.deployment).values({ id: activeId, projectId: target, organizationId, branch: "main", status: "ready", containerId: "native-vm", meta: { ...snapshot(), cloudApplicationSlot: true } });
    await db.update(schema.project).set({ activeDeploymentId: activeId, disabledAt: new Date() }).where(eq(schema.project.id, target));
    await expect(enableProject(target, organizationId)).rejects.toMatchObject({ reason: "running-services" });
    expect((await repos.project.findById(target))?.disabledAt).not.toBeNull();
    expect(h.readRuntime).not.toHaveBeenCalled();
  });
  it("resumes a containerized static site without counting an application slot", async () => {
    const activeId = id("deployment");
    await db.insert(schema.deployment).values({ id: activeId, projectId, organizationId, branch: "main", status: "ready",
      containerId: "static-container", meta: { ...snapshot(), hasServer: false, workload: "static" } });
    await db.update(schema.project).set({ activeDeploymentId: activeId, disabledAt: new Date(),
      hasServer: false, workloadType: "static" }).where(eq(schema.project.id, projectId));
    const { start } = existingRuntime(resources);
    await expect(enableProject(projectId, organizationId)).resolves.toMatchObject({ success: true });
    expect(start).toHaveBeenCalledWith("static-container");
    expect(await repos.service.countRunningForOrg(organizationId)).toBe(0);
  });
  it("serializes project creation so two imports cannot claim the final project slot", async () => {
    for (let index = 0; index < 8; index++) await project();
    const create = () => { const name = id("import"); return createServicesProjectWithId({ id: name, name, slug: name, organizationId }); };
    const results = await Promise.allSettled([create(), create()]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { reason: "project-limit" } });
    expect((await repos.projectGroup.listByOrganization(organizationId, { page: 1, perPage: 1 })).total).toBe(10);
  });
  it("requires a plan before saving the first Cloud project and leaves no project records behind", async () => {
    h.tier = "free";
    const owner = await seedOwner();
    const name = id("no-plan");
    await expect(createServicesProjectWithId({ id: name, name, slug: name, organizationId: owner.orgId }))
      .rejects.toMatchObject({ code: "PLAN_UPGRADE_REQUIRED", statusCode: 402, reason: "project-limit", message: "Choose a Cloud plan to create projects." });
    expect((await repos.projectGroup.listByOrganization(owner.orgId, { page: 1, perPage: 1 })).total).toBe(0);
    expect(await repos.project.findById(name)).toBeUndefined();
    expect(h.readRuntime).not.toHaveBeenCalled();
  });
  it("keeps self-hosted project creation available without a Cloud subscription", async () => {
    h.cloud = false; h.tier = "free";
    const name = id("self-hosted");
    await expect(createServicesProjectWithId({ id: name, name, slug: name, organizationId })).resolves.toMatchObject({ id: name });
  });
  it("honors a paid unlimited-project plan instead of falling back to the installation default", async () => {
    h.tier = "team";
    await project(); await project(); await project();
    const name = id("uncapped");
    await expect(createServicesProjectWithId({ id: name, name, slug: name, organizationId })).resolves.toMatchObject({ id: name });
  });
});
