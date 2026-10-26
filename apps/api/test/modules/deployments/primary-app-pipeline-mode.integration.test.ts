import { expect, it, vi } from "vitest";
import { repos } from "@repo/db";
import { seedOrg, seedProject } from "../../helpers/seed";
import { resolveServicePipelineMode } from "@repo/platform/engine/modules/deployments/build-pipeline";
import type { DeploymentConfigSnapshot } from "@repo/platform/engine/modules/deployments/build.service";

it("shares one bounded topology decision across full, service-scoped and explicit single-app deployments", async () => {
  const owner = await seedOrg();
  const project = await seedProject(owner.organizationId, {
    framework: "laravel",
    rootDirectory: ".",
    startCommand: "php artisan serve",
    hasBuild: true,
    hasServer: true,
  });
  const app = await repos.service.create({
    projectId: project.id,
    name: project.slug,
    kind: "monorepo",
    sortOrder: -1,
    rootDirectory: ".",
    enabled: true,
  });
  const database = await repos.service.create({
    projectId: project.id,
    name: "db",
    kind: "compose",
    image: "postgres:16-alpine",
    enabled: true,
    exposed: false,
  });
  const snapshot = {
    framework: "laravel",
    startCommand: project.startCommand,
    rootDirectory: ".",
    runtimeMode: "docker",
    deployTarget: "local",
    workload: "web",
    hasServer: true,
    hasBuild: true,
    serviceDeploymentMode: "services",
  } as DeploymentConfigSnapshot;
  expect(await resolveServicePipelineMode(project, snapshot)).toMatchObject({
    useServicePipeline: false,
    primaryApp: { app: { id: app.id }, infrastructure: [{ id: database.id }] },
  });
  expect(
    await resolveServicePipelineMode(project, { ...snapshot, targetServiceIds: [database.id] }),
  ).toHaveProperty("primaryApp.app.id", app.id);
  expect(
    await resolveServicePipelineMode(project, { ...snapshot, targetServiceIds: [app.id] }),
  ).toMatchObject({ useServicePipeline: true });
  expect(
    await resolveServicePipelineMode(project, { ...snapshot, targetServiceIds: ["foreign"] }),
  ).not.toHaveProperty("primaryApp");
  expect(
    await resolveServicePipelineMode(project, { ...snapshot, serviceDeploymentMode: "single" }),
  ).toMatchObject({
    useSingleAppPipeline: true,
    useServicePipeline: false,
    servicePreflightServices: [],
  });
  for (const unsupported of [
    { deployTarget: "cloud" },
    { clusterId: "cluster" },
    { managedWorkspaceId: "workspace" },
    { source: "image", releaseImageRef: "app:latest" },
    { workload: "static" },
  ]) {
    expect(
      await resolveServicePipelineMode(project, {
        ...snapshot,
        ...unsupported,
      } as DeploymentConfigSnapshot),
    ).not.toHaveProperty("primaryApp");
  }
  expect(
    await resolveServicePipelineMode({ ...project, workspaceId: "managed" }, snapshot),
  ).not.toHaveProperty("primaryApp");

  // Removing the last attached service must not strand the inherited app in
  // the general service pipeline, which cannot run its release commands/roles.
  await repos.service.remove(database.id);
  expect(await resolveServicePipelineMode(project, snapshot)).toMatchObject({
    useServicePipeline: false,
    primaryApp: { app: { id: app.id }, infrastructure: [] },
  });
  expect(await repos.service.findById(app.id)).not.toBeNull();
});

it("uses one service topology per decision and observes later edits on the next decision", async () => {
  const owner = await seedOrg();
  const project = await seedProject(owner.organizationId, {
    framework: "laravel",
    startCommand: "php artisan serve",
  });
  const app = await repos.service.create({
    projectId: project.id,
    name: project.slug,
    kind: "monorepo",
    sortOrder: -1,
    enabled: true,
  });
  const database = await repos.service.create({
    projectId: project.id,
    name: "db",
    kind: "compose",
    image: "postgres:16-alpine",
    enabled: true,
    exposed: false,
  });
  const snapshot = {
    framework: "laravel",
    startCommand: project.startCommand,
    runtimeMode: "docker",
    deployTarget: "local",
    workload: "web",
    hasServer: true,
    serviceDeploymentMode: "services",
  } as DeploymentConfigSnapshot;
  const listByProject = repos.service.listByProject.bind(repos.service);
  const read = vi.spyOn(repos.service, "listByProject").mockImplementationOnce(async (id) => {
    const rows = await listByProject(id);
    // An operator saves a service override after the topology has been read.
    await repos.service.update(app.id, { environment: { CUSTOM: "preserve" } });
    return rows;
  });
  try {
    expect(await resolveServicePipelineMode(project, snapshot)).toMatchObject({
      useServicePipeline: false,
      primaryApp: { app: { id: app.id }, infrastructure: [{ id: database.id }] },
      servicePreflightServices: expect.arrayContaining([
        expect.objectContaining({ name: project.slug, environment: {} }),
      ]),
    });
  } finally {
    read.mockRestore();
  }
  const next = await resolveServicePipelineMode(project, snapshot);
  expect(next).toMatchObject({
    useServicePipeline: true,
    servicePreflightServices: expect.arrayContaining([
      expect.objectContaining({ name: project.slug, environment: { CUSTOM: "preserve" } }),
    ]),
  });
  expect(next).not.toHaveProperty("primaryApp");
  await expect(
    resolveServicePipelineMode(project, {
      ...snapshot,
      primaryAppServiceName: app.name,
      retryBuildFromDeploymentId: "completed-build",
      handoverAppImage: `sha256:${"a".repeat(64)}`,
    }),
  ).rejects.toMatchObject({ code: "DEPLOYMENT_RETRY_TOPOLOGY_CHANGED" });
});

it("keeps frozen Cloud services independent of a live topology read", async () => {
  const owner = await seedOrg();
  const project = await seedProject(owner.organizationId);
  const services = [{ kind: "compose" as const, name: "db", image: "postgres:16-alpine" }];
  const read = vi.spyOn(repos.service, "listByProject").mockRejectedValue(new Error("unavailable"));
  try {
    expect(
      await resolveServicePipelineMode(project, {
        deployTarget: "cloud",
        composeServices: services,
      } as DeploymentConfigSnapshot),
    ).toEqual({
      useSingleAppPipeline: false,
      useServicePipeline: true,
      servicePreflightServices: services,
    });
  } finally {
    read.mockRestore();
  }
});
