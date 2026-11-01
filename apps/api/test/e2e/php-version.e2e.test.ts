/** Only platform location and GitHub reporting are replaced. Docker, Composer,
 * saved settings, deployment admission and retained-image rollback remain real. */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerRuntime, NoopInfraProvider, createHostExecutor } from "@repo/adapters";
import { repos, type Project, type Deployment } from "@repo/db";
import { LOCAL_HOST_PORT_TARGET } from "@repo/platform/engine/lib/host-port-target";
import { buildBackgroundContext } from "@repo/platform/engine/lib/background-context";
import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";
import { seedOrg, seedProject } from "../helpers/seed";

describeDockerE2E("PHP selection through build, deploy and rollback (#937)", () => {
  let runtime: DockerRuntime;
  let project: Project;
  let nodeProject: Project;
  let nodeDirectory = "";
  const customImageRefs: string[] = [];
  let directory = "";
  let owner: Awaited<ReturnType<typeof seedOrg>>;
  let builds: typeof import("@repo/platform/engine/modules/deployments/build.service");
  let rollback: typeof import("@repo/platform/engine/modules/deployments/rollback/rollback-orchestrator");
  let projects: typeof import("@repo/platform/engine/modules/projects/project-crud.service");

  async function terminal(id: string, timeout = 900_000): Promise<Deployment> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const row = await repos.deployment.findById(id);
      if (row && ["failed", "cancelled"].includes(row.status)) return row;
      if (
        row?.status === "ready" &&
        !(await repos.deployment.listInFlightByProject(project.id)).length
      )
        return row;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const session = await repos.deployment.findBuildSessionByDeploymentId(id);
    throw new Error(`PHP deployment ${id} timed out: ${JSON.stringify(session?.logs)}`);
  }
  async function ready(id: string) {
    const row = await terminal(id);
    if (row.status !== "ready") {
      const session = await repos.deployment.findBuildSessionByDeploymentId(id);
      throw new Error(`${row.errorMessage}: ${JSON.stringify(session?.logs)}`);
    }
    return row;
  }
  async function check(row: Deployment, version: string) {
    const executor = await runtime.inContainerExecutor(row.containerId!);
    await vi.waitFor(
      async () => {
        expect((await executor.exec("curl -fsS http://127.0.0.1:8000")).trim()).toBe(version);
      },
      { timeout: 30_000, interval: 500 },
    );
    expect(
      (await executor.exec("php -r 'echo PHP_MAJOR_VERSION . \".\" . PHP_MINOR_VERSION;'")).trim(),
    ).toBe(version);
    expect((await runtime.docker.getContainer(row.containerId!).inspect()).State.Running).toBe(
      true,
    );
    expect((row.meta as { runtimeVersion: string }).runtimeVersion).toBe(version);
    expect((await runtime.getUsage(row.containerId!)).memoryMb).toBeGreaterThan(0);
  }

  beforeAll(async () => {
    await requireDocker();
    runtime = await DockerRuntime.create({ transport: "socket" });
    owner = await seedOrg();
    directory = await mkdtemp(join(tmpdir(), "openship-php-937-"));
    await mkdir(join(directory, "public"));
    await writeFile(
      join(directory, "public/index.php"),
      '<?php echo PHP_MAJOR_VERSION . "." . PHP_MINOR_VERSION;',
    );
    await writeFile(
      join(directory, "composer.json"),
      JSON.stringify({ require: { php: ">=8.3 <8.5", "ext-intl": "*", "ext-pdo_pgsql": "*" } }),
    );
    project = await seedProject(owner.organizationId, {
      gitProvider: "local",
      localPath: directory,
      framework: "laravel",
      packageManager: "composer",
      runtimeVersion: "8.3",
      buildImage: "php:8.3-cli-bookworm",
      installCommand: "composer install --no-dev --no-plugins --no-scripts --no-interaction",
      buildCommand: "",
      outputDirectory: "public",
      startCommand:
        'SERVER_NAME=":$PORT" exec frankenphp run --config /etc/frankenphp/Caddyfile --adapter caddyfile',
      port: 8000,
      hasBuild: true,
      hasServer: true,
      runtimeMode: "docker",
      routeStrategy: "loopback-port",
      volumes: [],
    });
    const platform = {
      target: "selfhosted" as const,
      runtime,
      routing: new NoopInfraProvider(),
      ssl: new NoopInfraProvider(),
      system: null,
      executor: createHostExecutor(),
    };
    const resolved = {
      platform,
      effectiveTarget: "local" as const,
      runtimeMode: "docker" as const,
      usesManagedRouting: false,
      serverId: null,
      hostPortTarget: LOCAL_HOST_PORT_TARGET,
    };
    vi.doMock("@repo/platform/engine/lib/deployment-runtime", async (original) => ({
      ...(await original<Record<string, unknown>>()),
      resolveDeploymentRuntime: async () => ({ runtime, serverId: null }),
      resolveDeploymentPlatform: async () => resolved,
      resolveServerExecutor: async () => ({
        id: "local",
        executor: createHostExecutor(),
        conn: { host: "127.0.0.1", port: 22, user: "root" },
        isLocal: true,
        ssh: null,
      }),
    }));
    vi.doMock("@repo/platform/engine/lib/platform-config", async (original) => ({
      ...(await original<Record<string, unknown>>()),
      platform: () => platform,
    }));
    vi.doMock("@repo/adapters", async (original) => ({
      ...(await original<Record<string, unknown>>()),
      getPlatform: () => platform,
      edgeProxyFor: () => ({ listLoopbackUpstreamPortsStrict: async () => new Set<number>() }),
    }));
    vi.doMock("@repo/platform/engine/modules/deployments/service-checks", async (original) => ({
      ...(await original<Record<string, unknown>>()),
      emitInitialServiceChecks: async () => {},
      emitServiceCheckResults: async () => {},
      emitDeploymentCheck: async () => {},
      completeDeploymentCheck: async () => {},
    }));
    builds = await import("@repo/platform/engine/modules/deployments/build.service");
    rollback =
      await import("@repo/platform/engine/modules/deployments/rollback/rollback-orchestrator");
    projects = await import("@repo/platform/engine/modules/projects/project-crud.service");
  });
  afterAll(async () => {
    await (
      await import("@repo/platform/engine/modules/deployments/deployment-cancellation")
    ).drainDeploymentExecutions();
    if (runtime) {
      for (const fixture of [project, nodeProject].filter(Boolean)) {
        for (const id of await runtime.listProjectContainerIds(fixture.id))
          await runtime.destroy(id);
        for (const image of await runtime.listProjectImages(fixture.id))
          for (const tag of image.repoTags) await runtime.removeImage(tag);
      }
      for (const ref of customImageRefs) await runtime.removeImage(ref);
    }
    await runtime?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
    if (nodeDirectory) await rm(nodeDirectory, { recursive: true, force: true });
  }, 180_000);

  it("runs both versions, rejects incompatible Composer requirements, and rolls back without rebuilding", async () => {
    const ctx = buildBackgroundContext(owner);
    const first = await builds.triggerDeployment(ctx, { projectId: project.id, trigger: "manual" });
    const initial83 = await ready(first.deployment.id);
    await check(initial83, "8.3");
    const custom83 = `openship-runtime-test/php:${project.id}-83`;
    // BuildKit's FROM cache does not populate Docker's image store for tagging.
    await runtime.pullImage("dunglas/frankenphp:1-php8.3-bookworm");
    await runtime.docker
      .getImage("dunglas/frankenphp:1-php8.3-bookworm")
      .tag({ repo: "openship-runtime-test/php", tag: `${project.id}-83` });
    customImageRefs.push(custom83);
    await projects.updateOptions(project.id, { runtimeImage: custom83 }, owner.organizationId);
    const custom = await builds.triggerDeployment(ctx, {
      projectId: project.id,
      trigger: "manual",
    });
    const v83 = await ready(custom.deployment.id);
    await check(v83, "8.3");
    expect(v83.meta).toMatchObject({ runtimeImage: custom83, runtimeImageOverride: true });
    await projects.updateOptions(
      project.id,
      { runtimeVersion: "8.4", runtimeImage: null },
      owner.organizationId,
    );
    const second = await builds.triggerDeployment(ctx, {
      projectId: project.id,
      trigger: "manual",
    });
    const v84 = await ready(second.deployment.id);
    await check(v84, "8.4");
    expect(v83.meta).toMatchObject({
      buildImage: "php:8.3-cli-bookworm",
      runtimeImage: custom83,
    });
    await projects.updateOptions(project.id, { runtimeImage: custom83 }, owner.organizationId);
    const wrongBase = await builds.triggerDeployment(ctx, {
      projectId: project.id,
      trigger: "manual",
    });
    expect((await terminal(wrongBase.deployment.id)).status).toBe("failed");
    expect((await repos.project.findById(project.id))?.activeDeploymentId).toBe(v84.id);
    await check(v84, "8.4");
    await projects.updateOptions(project.id, { runtimeImage: null }, owner.organizationId);
    // Neither a fake platform nor --ignore-platform-reqs may bypass the check.
    await writeFile(
      join(directory, "composer.json"),
      JSON.stringify({ require: { php: ">=9.0" }, config: { platform: { php: "9.0.0" } } }),
    );
    await projects.updateOptions(
      project.id,
      {
        installCommand:
          "composer install --ignore-platform-reqs --no-dev --no-plugins --no-scripts --no-interaction",
      },
      owner.organizationId,
    );
    const incompatible = await builds.triggerDeployment(ctx, {
      projectId: project.id,
      trigger: "manual",
    });
    const failed = await terminal(incompatible.deployment.id);
    expect(failed.status).toBe("failed");
    const session = await repos.deployment.findBuildSessionByDeploymentId(failed.id);
    expect(JSON.stringify(session?.logs)).toMatch(/php.*9\.0|9\.0.*php/i);
    expect((await repos.project.findById(project.id))?.activeDeploymentId).toBe(v84.id);
    await check(v84, "8.4");
    const before = new Set(
      (await repos.deployment.listByProject(project.id, { perPage: 100 })).rows.map(
        (row) => row.id,
      ),
    );
    const buildSpy = vi.spyOn(runtime, "build");
    await rollback.rollback(v83.id);
    let restored: Deployment | undefined;
    await vi.waitFor(
      async () => {
        restored = (await repos.deployment.listByProject(project.id, { perPage: 100 })).rows.find(
          (row) => !before.has(row.id),
        );
        expect(restored).toBeDefined();
      },
      { timeout: 30_000 },
    );
    const v83Restored = await ready(restored!.id);
    expect(v83Restored.imageRef).toBe(v83.imageRef);
    expect(buildSpy).not.toHaveBeenCalled();
    await check(v83Restored, "8.3");
    expect((await repos.project.findById(project.id))?.runtimeVersion).toBe("8.4");
    expect(v83Restored.meta).toMatchObject({ runtimeImage: custom83, runtimeImageOverride: true });
    expect((await repos.project.findById(project.id))?.runtimeImage).toBeNull();
  }, 1_800_000);
  it("uses a custom Node base and refuses an incompatible actual ABI before activation", async () => {
    nodeDirectory = await mkdtemp(join(tmpdir(), "openship-runtime-node-"));
    await writeFile(
      join(nodeDirectory, "server.js"),
      `require("http").createServer((req, res) => res.end(process.versions.node)).listen(process.env.PORT || 8000, "0.0.0.0");`,
    );
    const customNode = `openship-runtime-test/node:${project.id}`;
    await runtime.pullImage("node:22-bookworm-slim");
    await runtime.docker
      .getImage("node:22-bookworm-slim")
      .tag({ repo: "openship-runtime-test/node", tag: project.id });
    customImageRefs.push(customNode);
    nodeProject = await seedProject(owner.organizationId, {
      gitProvider: "local",
      localPath: nodeDirectory,
      framework: "node",
      packageManager: "npm",
      buildImage: "node:22-bookworm-slim",
      runtimeImage: customNode,
      installCommand: "true",
      buildCommand: "",
      startCommand: "node server.js",
      port: 8000,
      hasBuild: true,
      hasServer: true,
      runtimeMode: "docker",
      routeStrategy: "loopback-port",
      volumes: [],
    });
    const ctx = buildBackgroundContext(owner);
    const first = await builds.triggerDeployment(ctx, {
      projectId: nodeProject.id,
      trigger: "manual",
    });
    const active = await ready(first.deployment.id);
    const executor = await runtime.inContainerExecutor(active.containerId!);
    expect((await executor.exec("node -e 'fetch(\"http://127.0.0.1:8000\").then(r => r.text()).then(t => console.log(t))'")).trim()).toMatch(/^22\./);
    await projects.updateOptions(
      nodeProject.id,
      { runtimeImage: "node:20-alpine" },
      owner.organizationId,
    );
    const wrong = await builds.triggerDeployment(ctx, {
      projectId: nodeProject.id,
      trigger: "manual",
    });
    expect((await terminal(wrong.deployment.id)).status).toBe("failed");
    const session = await repos.deployment.findBuildSessionByDeploymentId(wrong.deployment.id);
    expect(JSON.stringify(session?.logs)).toContain("runtime image is incompatible");
    expect((await repos.project.findById(nodeProject.id))?.activeDeploymentId).toBe(active.id);
    expect((await executor.exec("node -e 'fetch(\"http://127.0.0.1:8000\").then(r => r.text()).then(t => console.log(t))'")).trim()).toMatch(/^22\./);
  }, 1_800_000);
});
