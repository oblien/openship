import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCAL_HOST_PORT_TARGET } from "@repo/platform/engine/lib/host-port-target";
import { buildBackgroundContext } from "@repo/platform/engine/lib/background-context";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { DockerRuntime, NoopInfraProvider, createHostExecutor } from "@repo/adapters";
import { parseOpenshipConfig, SYSTEM } from "@repo/core";
import { repos, type Project, type Deployment } from "@repo/db";
import { encrypt } from "@repo/platform/engine/lib/encryption";
import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";
import { seedOrg, seedProject, seedDeployment } from "../helpers/seed";

// Mock platform location only. SQL, release commands, service readiness, role
// handover, activation, retention and Docker all use production implementations.
let runtime: DockerRuntime;
let project: Project;
let source = "";
let image = "";
let dbId = "";
let appId = "";
let hostname = "";
let owner: Awaited<ReturnType<typeof seedOrg>>;
let firstFailed: Deployment;
let registrations: ReturnType<typeof vi.spyOn>;
let loopbackRouting = false;
const attempts = new Set<string>();
let pipeline: typeof import("@repo/platform/engine/modules/deployments/build-pipeline");
const databaseImage = "postgres:16-alpine";
const resources = { cpuCores: 0, memoryMb: 0, diskMb: 0 };
const sql = "psql -h database -U app -d app -v ON_ERROR_STOP=1";
const roles = parseOpenshipConfig({
  roles: [
    {
      name: "queue",
      kind: "worker" as const,
      replicas: 1,
      command: `${sql} -At -c 'SELECT 1' || exit 1; trap 'exit 0' TERM; while :; do sleep 1 & wait $!; done`,
    },
    {
      name: "scheduler",
      kind: "scheduler" as const,
      command: "trap 'exit 0' TERM; while :; do sleep 1 & wait $!; done",
    },
  ],
}).config!.roles!;
async function current() {
  return (await repos.project.findById(project.id))!;
}
async function deploy(
  commands: string[],
  trigger = "manual",
  overrides: Record<string, unknown> = {},
  cancelWhen?: string,
) {
  const dep = await seedDeployment(project, {
    status: "queued",
    trigger,
    envVars: { PGPASSWORD: encrypt("test-only") },
    meta: {
      framework: "docker",
      hasBuild: true,
      hasServer: true,
      port: 8080,
      source: "git",
      build: "dockerfile",
      workload: "web",
      rootDirectory: ".",
      localPath: source,
      deployTarget: "local",
      runtimeMode: "docker",
      buildStrategy: "server",
      resources,
      serviceDeploymentMode: "services",
      handoverAppImage: image,
      startCommand:
        "mkdir -p /tmp/www; echo live > /tmp/www/index.html; exec /usr/local/bin/busybox httpd -f -p 8080 -h /tmp/www",
      releaseCommands: commands,
      roles,
      ...overrides,
    } as never,
  });
  attempts.add(dep.id);
  await repos.deployment.createBuildSession({
    deploymentId: dep.id,
    projectId: project.id,
    status: "queued",
  });
  await pipeline.kickoffBuild(await current(), dep);
  return settle(dep, cancelWhen);
}
async function settle(dep: Pick<Deployment, "id">, cancelWhen?: string) {
  if (cancelWhen) {
    const sessions = await import("@repo/platform/engine/modules/deployments/session-manager");
    await expect
      .poll(
        () => sessions.getSession(dep.id)?.logs.some((entry) => entry.message.includes(cancelWhen)),
        { timeout: 60_000, interval: 100 },
      )
      .toBe(true);
    const { requestDeploymentCancellation } =
      await import("@repo/platform/engine/modules/deployments/deployment-cancellation");
    expect(requestDeploymentCancellation(dep.id)).toBe(true);
  }
  await expect
    .poll(async () => (await repos.deployment.findById(dep.id))?.status, {
      timeout: 90_000,
      interval: 200,
    })
    .not.toMatch(/^(queued|building|deploying)$/);
  await (
    await import("@repo/platform/engine/modules/deployments/deployment-cancellation")
  ).drainDeploymentExecutions();
  const done = (await repos.deployment.findById(dep.id))!;
  if (done.status !== "ready") {
    const session = await repos.deployment.findBuildSessionByDeploymentId(dep.id);
    console.error(done.errorMessage, JSON.stringify(session?.logs).slice(-8000));
  }
  return done;
}
async function dbRow(dep: Deployment) {
  return (await repos.service.listByDeployment(dep.id)).find((row) => row.serviceId === dbId)!;
}
async function query(containerId: string, query: string) {
  return (
    await (await runtime.inContainerExecutor(containerId)).exec(`${sql} -At -c '${query}'`)
  ).trim();
}
let live: Deployment;
let firstDatabaseId: string;
describeDockerE2E("primary source app with attached infrastructure (#1312)", () => {
  beforeAll(async () => {
    await requireDocker();
    runtime = await DockerRuntime.create({ transport: "socket" });
    await runtime.pullImage(databaseImage);
    owner = await seedOrg({ ownsHost: true });
    source = await mkdtemp(join(tmpdir(), "openship-primary-infra-"));
    await writeFile(
      join(source, "Dockerfile"),
      `FROM ${databaseImage}\nCOPY --from=busybox:1.37-musl /bin/busybox /usr/local/bin/busybox\n`,
    );
    project = await seedProject(owner.organizationId, {
      framework: "docker",
      gitProvider: "local",
      localPath: source,
      rootDirectory: ".",
      hasBuild: true,
      hasServer: true,
      port: 8080,
      runtimeMode: "docker",
      routeStrategy: "container-ip",
      readiness: { stabilization: true, stabilizationSeconds: 1, onFailure: "fail" },
    });
    image = `openship/primary-infra-e2e:${project.id}`;
    const stream = await runtime.docker.buildImage(
      { context: source, src: ["Dockerfile"] },
      { t: image },
    );
    await new Promise<void>((resolve, reject) =>
      runtime.docker.modem.followProgress(stream, (error: Error | null) =>
        error ? reject(error) : resolve(),
      ),
    );
    const database = await repos.service.create({
      projectId: project.id,
      name: "database",
      kind: "compose",
      image: databaseImage,
      exposed: false,
      enabled: true,
      environment: { POSTGRES_USER: "app", POSTGRES_DB: "app", POSTGRES_PASSWORD: "test-only" },
      volumes: ["pgdata:/var/lib/postgresql/data"],
      advanced: {
        healthcheck: {
          test: ["CMD", "pg_isready", "-h", "127.0.0.1", "-U", "app"],
          interval: "1s",
          retries: 30,
        },
      },
    });
    dbId = database.id;
    const app = await repos.service.create({
      projectId: project.id,
      name: project.slug,
      kind: "monorepo",
      rootDirectory: ".",
      sortOrder: -1,
      enabled: true,
      exposed: true,
      exposedPort: "8080",
      customDomain: `${project.slug}.example.test`,
      domainType: "custom",
      publicEndpoints: [
        { port: 8080, domainType: "custom", customDomain: `${project.slug}.example.test` },
      ],
    });
    appId = app.id;
    hostname = `${project.slug}.example.test`;
    await repos.domain.create({
      projectId: project.id,
      ownerType: "project",
      hostname,
      domainType: "custom",
      serviceId: app.id,
      targetPort: 8080,
      verified: true,
      externalIngress: true,
      status: "active",
    });
    const { primaryAppWithInfrastructure } =
      await import("@repo/platform/engine/modules/deployments/compose/project-services");
    expect(
      primaryAppWithInfrastructure(project, await repos.service.listByProject(project.id)),
      JSON.stringify(app),
    ).not.toBeNull();
    const routing = new NoopInfraProvider();
    registrations = vi.spyOn(routing, "registerRoute");
    const located = {
      platform: {
        target: "selfhosted",
        runtime,
        routing,
        ssl: new NoopInfraProvider(),
        system: null,
        executor: createHostExecutor(),
      },
      effectiveTarget: "local",
      runtimeMode: "docker",
      usesManagedRouting: false,
      serverId: null,
      hostPortTarget: LOCAL_HOST_PORT_TARGET,
    };
    vi.doMock("@repo/platform/engine/lib/platform-config", async (original) => ({
      ...(await original<Record<string, unknown>>()),
      platform: () => located.platform,
    }));
    vi.doMock("@repo/platform/engine/lib/deployment-runtime", async (original) => ({
      ...(await original<Record<string, unknown>>()),
      resolveDeploymentPlatform: async () => ({ ...located, usesManagedRouting: loopbackRouting }),
      resolveDeploymentRuntime: async () => ({ runtime, serverId: null }),
      resolveDeploymentRuntimeForRead: async () => ({
        runtime: await DockerRuntime.create({ transport: "socket" }),
        serverId: null,
        hostPortTarget: LOCAL_HOST_PORT_TARGET,
      }),
      withDeploymentRuntime: async (_dep: unknown, run: (r: DockerRuntime) => Promise<unknown>) =>
        run(runtime),
    }));
    // Recovery would provision a real host edge. Noop routing has no daemon;
    // the normal deployment planner/registration and domain ownership are real.
    vi.doMock(
      "@repo/platform/engine/modules/projects/project-runtime.service",
      async (original) => ({
        ...(await original<Record<string, unknown>>()),
        retryProjectRouting: async () => ({ ok: true }),
      }),
    );
    // The Noop provider has no host vhost files. Its authoritative inventory is
    // empty; durable claims and actual Docker port bindings still run normally.
    vi.doMock("@repo/adapters", async (original) => ({
      ...(await original<Record<string, unknown>>()),
      edgeProxyFor: () => ({
        listLoopbackUpstreamPortsStrict: async () => new Set<number>(),
      }),
    }));
    pipeline = await import("@repo/platform/engine/modules/deployments/build-pipeline");
  }, 180_000);
  afterAll(async () => {
    const { requestDeploymentCancellation, drainDeploymentExecutions } =
      await import("@repo/platform/engine/modules/deployments/deployment-cancellation");
    for (const id of attempts) requestDeploymentCancellation(id);
    await drainDeploymentExecutions();
    if (project && runtime) {
      for (const id of await runtime.listProjectContainerIds(project.id))
        await runtime.destroy(id).catch(() => {});
      await runtime.removeNetwork(project.slug).catch(() => {});
      await runtime.removeVolume(`openship-${project.slug}-pgdata`).catch(() => {});
      await runtime.removeImage(image).catch(() => {});
      for (const built of await runtime.listProjectImages(project.id))
        for (const tag of built.repoTags) await runtime.removeImage(tag).catch(() => {});
    }
    await runtime?.dispose();
    if (source) await rm(source, { force: true, recursive: true });
  }, 120_000);
  it("retains initially prepared infrastructure when the first app migration fails", async () => {
    const { mergeEnvVars } =
      await import("@repo/platform/engine/modules/projects/project-env.service");
    await mergeEnvVars(project.id, owner.organizationId, {
      environment: "production",
      deletes: [],
      upserts: [{ key: "PGPASSWORD", value: "test-only", isSecret: true }],
    });
    await repos.project.update(project.id, {
      startCommand:
        "mkdir -p /tmp/www; echo live > /tmp/www/index.html; exec /usr/local/bin/busybox httpd -f -p 8080 -h /tmp/www",
      releaseCommands: [
        `${sql} -c 'CREATE TABLE IF NOT EXISTS retry_attempts (value integer); INSERT INTO retry_attempts VALUES (1)'`,
        `test "$(${sql} -At -c 'SELECT count(*) FROM retry_attempts')" -ge 2`,
      ],
      roles,
    });
    const { triggerDeployment } =
      await import("@repo/platform/engine/modules/deployments/build.service");
    const result = await triggerDeployment(buildBackgroundContext(owner), {
      projectId: project.id,
      trigger: "manual",
    });
    expect(result.deployment).toBeDefined();
    attempts.add(result.deployment!.id);
    const failed = (firstFailed = await settle(result.deployment!));
    expect(failed.status).toBe("failed");
    expect((await current()).activeDeploymentId).toBeNull();
    firstDatabaseId = (await dbRow(failed)).containerId!;
    expect((await runtime.getContainerInfo(firstDatabaseId)).status).toBe("running");
    expect(failed.meta).toMatchObject({
      primaryAppServiceName: project.slug,
      composeServices: expect.arrayContaining([
        expect.objectContaining({ name: project.slug, kind: "monorepo" }),
      ]),
      completedBuildArtifacts: {
        version: 1,
        images: [expect.objectContaining({ imageId: expect.stringMatching(/^sha256:/) })],
      },
    });
  });
  it("retries the completed app through the public entry point with no source, rebuild or pull and retains its database and roles", async () => {
    const { redeployBuildSession } =
      await import("@repo/platform/engine/modules/deployments/build.service");
    const build = vi
      .spyOn(runtime, "build")
      .mockRejectedValue(new Error("A completed-image retry must not build"));
    const pull = vi
      .spyOn(runtime, "pullImage")
      .mockRejectedValue(new Error("A completed-image retry must not pull"));
    const hiddenSource = `${source}-retry-without-source`;
    await rename(source, hiddenSource);
    try {
      const result = await redeployBuildSession(buildBackgroundContext(owner), firstFailed.id, {
        reuseBuild: true,
      });
      attempts.add(result.deployment_id);
      live = await settle({ id: result.deployment_id });
      expect(live.status, live.errorMessage ?? "").toBe("ready");
      expect(live.buildDurationMs).toBe(0);
      expect(live.roleContainers).toHaveLength(2);
      const receipt = firstFailed.meta as {
        completedBuildArtifacts: { images: Array<{ imageId: string }> };
      };
      expect((await runtime.docker.getContainer(live.containerId!).inspect()).Image).toBe(
        receipt.completedBuildArtifacts.images[0]!.imageId,
      );
      expect((await dbRow(live)).containerId).toBe(firstDatabaseId);
      expect(await query(live.containerId!, "SELECT count(*) FROM retry_attempts")).toBe("2");
      expect(build).not.toHaveBeenCalled();
      expect(pull).not.toHaveBeenCalled();
    } finally {
      await rename(hiddenSource, source);
      build.mockRestore();
      pull.mockRestore();
    }
  });
  it("authenticates to PostgreSQL from the candidate before web and role activation", async () => {
    live = await deploy([
      `${sql} -c 'CREATE TABLE IF NOT EXISTS marker (value text); INSERT INTO marker VALUES (current_user)'`,
    ]);
    expect(live.status, live.errorMessage ?? "").toBe("ready");
    expect(live.roleContainers).toHaveLength(2);
    expect(registrations).toHaveBeenCalledWith(expect.objectContaining({ domain: hostname }));
    expect(await repos.domain.findByHostname(hostname)).toMatchObject({
      serviceId: appId,
      targetPort: 8080,
    });
    expect((await dbRow(live)).containerId).toBe(firstDatabaseId);
    expect(await query(live.containerId!, "SELECT value FROM marker")).toBe("app");
    expect(
      (await repos.service.listByDeployment(live.id)).find((row) => row.serviceId === appId),
    ).toMatchObject({ status: "success", containerId: live.containerId });
    expect((await runtime.getContainerInfo((await dbRow(live)).containerId!)).status).toBe(
      "running",
    );
  });
  it("keeps the database, web and roles after migration failure, then retries without restarting the database", async () => {
    const database = await dbRow(live);
    const failed = await deploy([`${sql} -c 'SELECT 1'`, "echo migration-failed >&2; exit 7"]);
    expect(failed.status).toBe("failed");
    expect((await current()).activeDeploymentId).toBe(live.id);
    for (const ref of [
      live.containerId!,
      ...live.roleContainers!.map((role) => role.containerId),
      database.containerId!,
    ])
      expect((await runtime.getContainerInfo(ref)).status).toBe("running");
    const next = await deploy([`${sql} -c 'SELECT 1'`]);
    expect(next.status, next.errorMessage ?? "").toBe("ready");
    expect((await dbRow(next)).containerId).toBe(database.containerId);
    expect(await query(next.containerId!, "SELECT value FROM marker")).toBe("app");
    for (const ref of live.roleContainers!)
      expect(["stopped", "missing"]).toContain(
        (await runtime.getContainerInfo(ref.containerId)).status,
      );
    live = next;
  });
  it("leaves the live app, database and previous roles intact after a candidate worker fails", async () => {
    const database = await dbRow(live);
    const readiness = (await current()).readiness;
    // Healthy cases use a shortened watch to keep this suite fast. A crash-loop
    // assertion needs the normal window: Docker can be between restarts at 1s,
    // before the restart count proves a loop.
    await repos.project.update(project.id, {
      readiness: {
        ...readiness,
        stabilizationSeconds: SYSTEM.DEPLOYMENTS.STABILIZE_WINDOW_MS / 1000,
      },
    });
    try {
      const failed = await deploy([`${sql} -c 'SELECT 1'`], "manual", {
        roles: [{ ...roles[0]!, command: "exit 9" }, roles[1]!],
      });
      expect(failed.status).toBe("failed");
      expect((await current()).activeDeploymentId).toBe(live.id);
      expect((await dbRow(failed)).containerId).toBe(database.containerId);
      for (const id of [
        database.containerId!,
        live.containerId!,
        ...live.roleContainers!.map((role) => role.containerId),
      ])
        expect((await runtime.getContainerInfo(id)).status).toBe("running");
    } finally {
      await repos.project.update(project.id, { readiness });
    }
  });
  it("skips release commands on rollback and preserves live infrastructure", async () => {
    const database = await dbRow(live);
    const restored = await deploy(["echo must-not-run; exit 99"], "rollback");
    expect(restored.status, restored.errorMessage ?? "").toBe("ready");
    expect((await dbRow(restored)).containerId).toBe(database.containerId);
    expect(await query(restored.containerId!, "SELECT value FROM marker")).toBe("app");
    live = restored;
  });
  it("changes only selected infrastructure and skips app release commands, web and role restarts", async () => {
    const previous = live;
    const scoped = await deploy(["echo must-not-run; exit 99"], "manual", {
      targetServiceIds: [dbId],
    });
    expect(scoped.status, scoped.errorMessage ?? "").toBe("ready");
    expect(scoped.containerId).toBe(previous.containerId);
    expect(scoped.roleContainers!.map((role) => role.containerId)).toEqual(
      previous.roleContainers!.map((role) => role.containerId),
    );
    expect(await query(scoped.containerId!, "SELECT value FROM marker")).toBe("app");
    live = scoped;
  });
  it("cancels during a release command without stopping the active app, roles or database", async () => {
    const database = await dbRow(live);
    const cancelled = await deploy(
      ["echo cancel-release-started; sleep 60"],
      "manual",
      {},
      "cancel-release-started",
    );
    expect(cancelled.status).toBe("cancelled");
    expect((await current()).activeDeploymentId).toBe(live.id);
    expect((await dbRow(cancelled)).containerId).toBe(database.containerId);
    for (const id of [
      database.containerId!,
      live.containerId!,
      ...live.roleContainers!.map((role) => role.containerId),
    ])
      expect((await runtime.getContainerInfo(id)).status).toBe("running");
  });
  it("configures runtime roles on the attached stack using the active image without rebuilding web", async () => {
    const { getRoleConfiguration, configureRuntimeRoles } =
      await import("@repo/platform/engine/modules/projects/role-configuration.service");
    const config = await getRoleConfiguration(project.id, project.organizationId);
    expect(config.supported, config.reason ?? "").toBe(true);
    const database = await dbRow(live);
    const previous = live;
    const result = await configureRuntimeRoles(
      { organizationId: project.organizationId } as never,
      project.id,
      {
        expectedDeploymentId: config.deploymentId!,
        expectedUpdatedAt: config.updatedAt,
        roles: [
          { ...roles[0]!, kind: "worker", replicas: 2 },
          { ...roles[1]!, kind: "scheduler" },
        ],
      },
    );
    await (
      await import("@repo/platform/engine/modules/deployments/deployment-cancellation")
    ).drainDeploymentExecutions();
    live = (await repos.deployment.findById(result.deploymentId))!;
    expect(live.status, live.errorMessage ?? "").toBe("ready");
    expect(live.containerId).toBe(previous.containerId);
    expect((await dbRow(live)).containerId).toBe(database.containerId);
    expect(live.roleContainers!.filter((role) => role.role === "queue")).toHaveLength(2);
    expect(live.roleContainers!.find((role) => role.role === "scheduler")!.containerId).toBe(
      previous.roleContainers!.find((role) => role.role === "scheduler")!.containerId,
    );
  });
  it("keeps routed host-port claims owned by the primary service through a loopback redeploy", async () => {
    if (!live) live = await deploy([`${sql} -c 'CREATE TABLE IF NOT EXISTS marker (value text)'`]);
    await repos.project.update(project.id, { routeStrategy: "loopback-port" });
    loopbackRouting = true;
    const database = await dbRow(live);
    const routed = await deploy([`${sql} -c 'SELECT 1'`]);
    expect(routed.status, routed.errorMessage ?? "").toBe("ready");
    const primary = (await repos.service.listByDeployment(routed.id)).find(
      (row) => row.serviceId === appId,
    )!;
    expect(primary.hostPort).toBeGreaterThan(0);
    const claims = await repos.hostPortClaim.listHostPortClaims(LOCAL_HOST_PORT_TARGET.targetKey);
    expect(claims.find((claim) => claim.port === primary.hostPort)).toMatchObject({
      projectId: project.id,
      serviceId: appId,
      containerPort: 8080,
    });
    expect((await dbRow(routed)).containerId).toBe(database.containerId);
    expect(await repos.domain.findByHostname(hostname)).toMatchObject({ serviceId: appId });
    live = routed;
    const again = await deploy([`${sql} -c 'SELECT 1'`]);
    expect(again.status, again.errorMessage ?? "").toBe("ready");
    expect(
      (await repos.service.listByDeployment(again.id)).find((row) => row.serviceId === appId)
        ?.hostPort,
    ).toBe(primary.hostPort);
    live = again;
  });
  it("restores an older primary service image pin without cloning or rebuilding it", async () => {
    if (!live)
      live = await deploy([
        `${sql} -c 'CREATE TABLE marker (value text); INSERT INTO marker VALUES (current_user)'`,
      ]);
    const database = await dbRow(live);
    const build = vi.spyOn(runtime, "build").mockImplementation(async () => {
      throw new Error("A retained primary image must not be rebuilt");
    });
    try {
      const restored = await deploy(["echo must-not-run; exit 99"], "rollback", {
        handoverAppImage: undefined,
        handoverImages: { [project.slug]: image },
      });
      expect(restored.status, restored.errorMessage ?? "").toBe("ready");
      expect(build).not.toHaveBeenCalled();
      expect((await dbRow(restored)).containerId).toBe(database.containerId);
      expect(await query(restored.containerId!, "SELECT value FROM marker")).toBe("app");
      live = restored;
    } finally {
      build.mockRestore();
    }
  });
  it("can configure roles and deploy after deleting the last attached service (#1308)", async () => {
    if (!live) live = await deploy([]);
    const { deleteService } = await import("@repo/platform/engine/modules/services/service.service");
    const { getRoleConfiguration, configureRuntimeRoles } =
      await import("@repo/platform/engine/modules/projects/role-configuration.service");
    const ctx = buildBackgroundContext(owner);
    const previous = live;
    await deleteService(ctx, project.id, dbId);
    expect(await repos.service.findById(dbId)).toBeUndefined();
    expect((await runtime.getContainerInfo(previous.containerId!)).status).toBe("running");
    const config = await getRoleConfiguration(project.id, project.organizationId);
    expect(config.supported, config.reason ?? "").toBe(true);
    const nextRoles = [
      {
        ...roles[0]!,
        kind: "worker" as const,
        command: "trap 'exit 0' TERM; while :; do sleep 1 & wait $!; done",
      },
      { ...roles[1]!, kind: "scheduler" as const },
    ];
    const result = await configureRuntimeRoles(ctx, project.id, {
      expectedDeploymentId: config.deploymentId!,
      expectedUpdatedAt: config.updatedAt,
      roles: nextRoles,
    });
    attempts.add(result.deploymentId);
    live = await settle({ id: result.deploymentId });
    expect(live.status, live.errorMessage ?? "").toBe("ready");
    expect(live.containerId).toBe(previous.containerId);
    expect(live.roleContainers!.find((role) => role.role === "scheduler")!.containerId).toBe(
      previous.roleContainers!.find((role) => role.role === "scheduler")!.containerId,
    );
    const deployed = await deploy(["echo release-after-service-removal"], "manual", {
      roles: nextRoles,
    });
    expect(deployed.status, deployed.errorMessage ?? "").toBe("ready");
    expect((await repos.service.listByDeployment(deployed.id)).map((row) => row.serviceId)).toEqual([
      appId,
    ]);
    expect((await repos.service.listByProject(project.id)).map((row) => row.id)).toEqual([appId]);
    expect(await repos.domain.findByHostname(hostname)).toMatchObject({ serviceId: appId });
    expect((await runtime.getContainerInfo(deployed.containerId!)).status).toBe("running");
    const session = await repos.deployment.findBuildSessionByDeploymentId(deployed.id);
    expect(JSON.stringify(session?.logs)).toContain("release-after-service-removal");
    live = deployed;
  });
});
