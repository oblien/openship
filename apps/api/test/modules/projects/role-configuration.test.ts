import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, repos, schema } from "@repo/db";
import { DockerRuntime, initPlatform, resetPlatform } from "@repo/adapters";
import { ProjectControlSchemas } from "@repo/contracts";
import { createResourceOperations } from "../../../../../packages/platform/src/resource-operations";
import { createProjectControls } from "@repo/platform/engine/modules/projects/project-controls.operations";
import type { ExecutionContext } from "@repo/platform";
import { seedDeployment, seedOrg, seedProject, seedService, setActive } from "../../helpers/seed";
const h = vi.hoisted(() => ({
  runtime: null as unknown,
  start: vi.fn(async () => "build"),
  access: vi.fn(async () => {}),
}));
vi.mock("@repo/platform/engine/lib/deployment-runtime", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/lib/deployment-runtime")>()),
  withDeploymentRuntime: async (_dep: unknown, run: (runtime: unknown) => Promise<unknown>) =>
    run(h.runtime),
}));
vi.mock("@repo/platform/engine/modules/deployments/build.service", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/modules/deployments/build.service")>()),
  startBuild: h.start,
}));
vi.mock("@repo/platform/engine/modules/github/github-access", () => ({
  assertGitHubRepoAccess: h.access,
}));
const { configureRuntimeRoles, getRoleConfiguration } =
  await import("@repo/platform/engine/modules/projects/role-configuration.service");
const imageId = `sha256:${"a".repeat(64)}`;
const owned: string[] = [];
beforeAll(() => initPlatform({ target: "selfhosted", runtime: "docker" }));
afterAll(() => resetPlatform());
beforeEach(() => {
  h.start.mockClear();
  h.access.mockClear();
});
afterEach(async () => {
  for (const id of owned.splice(0))
    await db.delete(schema.project).where(eq(schema.project.id, id));
});
async function fixture(target = "server") {
  const org = await seedOrg();
  const project = await seedProject(org.organizationId);
  owned.push(project.id);
  const active = await seedDeployment(project, {
    containerId: "web",
    url: "https://app.example.test",
    meta: {
      runtimeMode: "docker",
      deployTarget: target,
      hasServer: true,
      framework: "node",
      port: 3000,
      startCommand: "exec app",
      roles: [],
    },
    envVars: { SECRET: "frozen" },
  });
  await setActive(project.id, active.id);
  const runtime = Object.create(DockerRuntime.prototype) as DockerRuntime;
  Object.assign(runtime, {
    capabilities: new Set(["roles"]),
    findOwnedDeploymentContainer: async (_ref: string, owner: { deploymentId: string }) =>
      owner.deploymentId === active.id ? "web" : null,
    inspectContainer: async () => ({ id: "web", state: "running", imageId }),
  });
  h.runtime = runtime;
  const config = await getRoleConfiguration(project.id, org.organizationId);
  const ctx = {
    organizationId: org.organizationId,
    userId: org.userId,
    source: "test",
  } as unknown as ExecutionContext;
  const input = {
    expectedDeploymentId: active.id,
    expectedUpdatedAt: config.updatedAt,
    roles: [{ name: "queue", kind: "worker" as const, command: "exec worker", replicas: 2 }],
  };
  return { project, active, org, config, ctx, input, runtime };
}
describe("runtime role configuration admission", () => {
  it("uses the active immutable image and frozen environment, persists desired roles atomically and deduplicates a pending retry", async () => {
    const f = await fixture();
    const operations = createResourceOperations(
      ProjectControlSchemas,
      {
        authorize: async (ctx: ExecutionContext) => ctx,
      },
      "project",
      createProjectControls(vi.fn()),
    );
    const read = await operations.getRuntimeRoleConfiguration(f.ctx, f.project.id);
    expect(read.data).toMatchObject({ supported: true, deploymentId: f.active.id });
    const { data: result } = await operations.configureRuntimeRoles(f.ctx, f.project.id, f.input);
    const dep = (await repos.deployment.findById(result.deploymentId))!;
    expect(dep.meta).toMatchObject({
      handoverAppImage: imageId,
      roles: f.input.roles,
      roleConfiguration: { sourceDeploymentId: f.active.id, webContainerId: "web", imageId },
    });
    expect(dep.envVars).toEqual(f.active.envVars);
    expect(dep.url).toBe(f.active.url);
    expect(await repos.deployment.findBuildSessionByDeploymentId(dep.id)).toMatchObject({
      status: "queued",
    });
    expect((await repos.project.findById(f.project.id))?.roles).toMatchObject(f.input.roles);
    expect(await configureRuntimeRoles(f.ctx, f.project.id, f.input)).toEqual(result);
    expect(
      (await repos.deployment.listInFlightByProject(f.project.id)).map((row) => row.id),
    ).toEqual([dep.id]);
  });
  it("supports a headless Docker primary process using the same workload classification as deployment", async () => {
    const f = await fixture();
    await repos.deployment.updateStatus(f.active.id, "ready", {
      meta: {
        ...(f.active.meta as Record<string, unknown>),
        hasServer: false,
        workload: "worker",
      },
    });
    expect((await getRoleConfiguration(f.project.id, f.org.organizationId)).supported).toBe(true);
    expect((await configureRuntimeRoles(f.ctx, f.project.id, f.input)).deploymentId).toBeTruthy();
  });
  it("resolves a release recorded before runtimeMode existed the same way its runtime does", async () => {
    const f = await fixture();
    const { runtimeMode: _recorded, ...legacy } = f.active.meta as Record<string, unknown>;
    await repos.deployment.updateStatus(f.active.id, "ready", { meta: legacy });
    expect((await getRoleConfiguration(f.project.id, f.org.organizationId)).supported).toBe(true);
    expect((await configureRuntimeRoles(f.ctx, f.project.id, f.input)).deploymentId).toBeTruthy();
    await initPlatform({ target: "selfhosted", runtime: "bare" });
    try {
      expect((await getRoleConfiguration(f.project.id, f.org.organizationId)).supported).toBe(
        false,
      );
    } finally {
      await initPlatform({ target: "selfhosted", runtime: "docker" });
    }
  });
  it.each([
    { managedWorkspaceId: "workspace" },
    {
      managedServer: {
        projectId: "cloud-project",
        workspaceId: "workspace",
        ownerWorkspaceId: "owner",
      },
    },
  ])("rejects legacy managed Cloud releases without an explicit target: %j", async (binding) => {
    const f = await fixture();
    const {
      runtimeMode: _runtime,
      deployTarget: _target,
      ...legacy
    } = f.active.meta as Record<string, unknown>;
    await repos.deployment.updateStatus(f.active.id, "ready", {
      meta: { ...legacy, ...binding },
    });
    expect(await getRoleConfiguration(f.project.id, f.org.organizationId)).toMatchObject({
      supported: false,
      reason: expect.stringContaining("single-app Docker"),
    });
    await expect(configureRuntimeRoles(f.ctx, f.project.id, f.input)).rejects.toThrow(
      "single-app Docker",
    );
    expect(await repos.deployment.listInFlightByProject(f.project.id)).toEqual([]);
    expect(h.start).not.toHaveBeenCalled();
  });
  it("rejects a legacy release using Desktop's default Cloud target", async () => {
    const f = await fixture();
    const {
      runtimeMode: _runtime,
      deployTarget: _target,
      ...legacy
    } = f.active.meta as Record<string, unknown>;
    await repos.deployment.updateStatus(f.active.id, "ready", { meta: legacy });
    await initPlatform({ target: "desktop" });
    try {
      expect((await getRoleConfiguration(f.project.id, f.org.organizationId)).supported).toBe(
        false,
      );
      await expect(configureRuntimeRoles(f.ctx, f.project.id, f.input)).rejects.toThrow(
        "single-app Docker",
      );
      expect(await repos.deployment.listInFlightByProject(f.project.id)).toEqual([]);
      expect(h.start).not.toHaveBeenCalled();
    } finally {
      await initPlatform({ target: "selfhosted", runtime: "docker" });
    }
  });
  it.each([
    { deployTarget: "cluster" },
    { deployTarget: "server", clusterId: "cluster" },
    { deployTarget: "server", runtimeMode: "bare" },
  ])("rejects unsupported active release metadata before queueing work: %j", async (target) => {
    const f = await fixture();
    const { runtimeMode: _runtime, ...legacy } = f.active.meta as Record<string, unknown>;
    await repos.deployment.updateStatus(f.active.id, "ready", {
      meta: { ...legacy, ...target },
    });
    expect((await getRoleConfiguration(f.project.id, f.org.organizationId)).supported).toBe(false);
    await expect(configureRuntimeRoles(f.ctx, f.project.id, f.input)).rejects.toThrow(
      "single-app Docker",
    );
    expect(await repos.deployment.listInFlightByProject(f.project.id)).toEqual([]);
    expect(h.start).not.toHaveBeenCalled();
  });
  it("uses the deployment topology rules for primary records and disabled sidecars", async () => {
    const f = await fixture();
    await seedService(f.project.id, { name: "primary", kind: "app", enabled: true });
    const sidecar = await seedService(f.project.id, {
      name: "database",
      kind: "compose",
      enabled: false,
    });
    expect((await getRoleConfiguration(f.project.id, f.org.organizationId)).supported).toBe(true);
    await db.update(schema.service).set({ enabled: true }).where(eq(schema.service.id, sidecar.id));
    expect((await getRoleConfiguration(f.project.id, f.org.organizationId)).supported).toBe(false);
    await expect(configureRuntimeRoles(f.ctx, f.project.id, f.input)).rejects.toThrow(
      "single-app Docker",
    );
    await db
      .update(schema.service)
      .set({ enabled: false })
      .where(eq(schema.service.id, sidecar.id));
    expect((await configureRuntimeRoles(f.ctx, f.project.id, f.input)).deploymentId).toBeTruthy();
  });
  it("keeps roles available after the last attached service is removed (#1308)", async () => {
    const f = await fixture();
    await repos.project.update(f.project.id, { framework: "node", startCommand: "exec app" });
    const app = await seedService(f.project.id, {
      name: f.project.slug,
      kind: "monorepo",
      sortOrder: -1,
      enabled: true,
    });
    const sidecar = await seedService(f.project.id, {
      name: "database",
      kind: "compose",
      image: "postgres:16-alpine",
      enabled: true,
      exposed: false,
    });
    expect((await getRoleConfiguration(f.project.id, f.org.organizationId)).supported).toBe(true);
    await repos.service.remove(sidecar.id);
    const config = await getRoleConfiguration(f.project.id, f.org.organizationId);
    expect(config.supported, config.reason ?? "").toBe(true);
    const result = await configureRuntimeRoles(f.ctx, f.project.id, {
      ...f.input,
      expectedUpdatedAt: config.updatedAt,
    });
    expect((await repos.deployment.findById(result.deploymentId))?.meta).toMatchObject({
      handoverAppImage: imageId,
      roles: f.input.roles,
    });
    expect(await repos.service.findById(app.id)).not.toBeNull();
  });
  it("rejects stale edits, unavailable images, unsupported Cloud and foreign organizations before creating work", async () => {
    const f = await fixture();
    await expect(
      configureRuntimeRoles(f.ctx, f.project.id, { ...f.input, expectedDeploymentId: "stale" }),
    ).rejects.toMatchObject({ code: "ROLE_CONFIGURATION_CHANGED" });
    f.runtime.inspectContainer = async () => null;
    await expect(configureRuntimeRoles(f.ctx, f.project.id, f.input)).rejects.toMatchObject({
      code: "ROLE_CONFIGURATION_UNAVAILABLE",
    });
    await expect(
      configureRuntimeRoles({ ...f.ctx, organizationId: "foreign" }, f.project.id, f.input),
    ).rejects.toThrow();
    const cloud = await fixture("cloud");
    expect(cloud.config.supported).toBe(false);
    await expect(configureRuntimeRoles(cloud.ctx, cloud.project.id, cloud.input)).rejects.toThrow(
      "single-app Docker",
    );
    expect(h.start).not.toHaveBeenCalled();
  });
});

it("configures roles for one inherited source app with a private image service and drops a prior service scope", async () => {
  const f = await fixture();
  await db.update(schema.project).set({ framework: "node", startCommand: "exec app", rootDirectory: "." })
    .where(eq(schema.project.id, f.project.id));
  const database = await repos.service.create({ projectId: f.project.id, name: "database", kind: "compose",
    image: "postgres:16-alpine", enabled: true, exposed: false });
  await repos.service.create({ projectId: f.project.id, name: f.project.slug, kind: "monorepo",
    rootDirectory: ".", sortOrder: -1, enabled: true });
  await repos.deployment.updateStatus(f.active.id, "ready", { meta: {
    ...(f.active.meta as Record<string, unknown>), targetServiceIds: [database.id],
    refreshServiceIds: [database.id], strictServiceScope: true,
  } });
  const config = await getRoleConfiguration(f.project.id, f.org.organizationId);
  expect(config.supported).toBe(true);
  const queued = await configureRuntimeRoles(f.ctx, f.project.id, {
    ...f.input, expectedUpdatedAt: config.updatedAt,
  });
  const snapshot = (await repos.deployment.findById(queued.deploymentId))!.meta as Record<string, unknown>;
  expect(snapshot.targetServiceIds).toBeUndefined();
  expect(snapshot.refreshServiceIds).toBeUndefined();
  expect(snapshot.strictServiceScope).toBeUndefined();
  expect(snapshot.roles).toEqual(f.input.roles);
});
