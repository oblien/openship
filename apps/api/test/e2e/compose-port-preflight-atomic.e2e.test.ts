/**
 * A full compose redeploy must reserve every routed host port before replacing
 * the first service. This is the real-daemon regression for the production
 * failure where Postgres and Redis were replaced, then a stale API container id
 * made its locked 20008 route look unavailable and the deployment aborted.
 */

import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createServer } from "node:net";
import { BuildLogger, DockerRuntime, NoopInfraProvider, createHostExecutor } from "@repo/adapters";
import { repos } from "@repo/db";
import { LOCAL_HOST_PORT_TARGET } from "@repo/platform/engine/lib/host-port-target";
import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";
import {
  seedDeployment,
  seedOrg,
  seedProject,
  seedService,
  seedServiceDeployment,
  setActive,
} from "../helpers/seed";

const IMAGE = "busybox:latest";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("test port listener did not expose an address"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

describeDockerE2E("compose full-deploy host-port preflight", () => {
  let runtime: DockerRuntime;
  let projectId = "";
  let projectSlug = "";
  let foreignClaimPort = 0;
  let apiServiceId = "";
  let ready = false;

  beforeAll(async () => {
    await requireDocker();
    runtime = await DockerRuntime.create({ transport: "socket" });
    try {
      await runtime.pullImage(IMAGE);
    } catch {
      return;
    }
    ready = true;
  }, 120_000);

  afterAll(async () => {
    if (projectId) {
      for (const id of await runtime.listProjectContainerIds(projectId).catch(() => [])) {
        await runtime.destroy(id).catch(() => undefined);
      }
      if (projectSlug) await runtime.removeNetwork(projectSlug).catch(() => undefined);
    }
    if (foreignClaimPort) {
      await repos.hostPortClaim
        .releaseHostPortClaim({
          targetKey: LOCAL_HOST_PORT_TARGET.targetKey,
          port: foreignClaimPort,
          projectId: "foreign-project",
          serviceId: "foreign-service",
          containerPort: 3000,
        })
        .catch(() => undefined);
      await repos.hostPortClaim
        .releaseQuarantinedHostPortClaim({
          targetKey: LOCAL_HOST_PORT_TARGET.targetKey,
          port: foreignClaimPort,
        })
        .catch(() => undefined);
      if (projectId && apiServiceId) {
        await repos.hostPortClaim
          .releaseHostPortClaim({
            targetKey: LOCAL_HOST_PORT_TARGET.targetKey,
            port: foreignClaimPort,
            projectId,
            serviceId: apiServiceId,
            containerPort: 3000,
          })
          .catch(() => undefined);
      }
    }
    await runtime?.dispose().catch(() => undefined);
  }, 120_000);

  it("relocates a real conflict and preserves verified ports across stale and stopped state", async () => {
    expect(ready, "daemon unusable or base image unavailable").toBe(true);

    const org = await seedOrg();
    const project = await seedProject(org.organizationId, {
      framework: "docker",
      hasBuild: false,
      hasServer: true,
      runtimeMode: "docker",
      routeStrategy: "loopback-port",
    });
    projectId = project.id;
    projectSlug = project.slug;
    const postgres = await seedService(project.id, {
      name: "postgres",
      image: IMAGE,
      command: "sleep 600",
      ports: [],
      dependsOn: [],
    });
    const redis = await seedService(project.id, {
      name: "redis",
      image: IMAGE,
      command: "sleep 600",
      ports: [],
      dependsOn: [],
    });
    const api = await seedService(project.id, {
      name: "api",
      image: IMAGE,
      command: "httpd -f -p 3000 -h /",
      ports: ["3000"],
      dependsOn: ["postgres", "redis"],
      exposed: true,
      exposedPort: "3000",
      domainType: "custom",
      customDomain: "api.atomic-e2e.example.test",
    });
    apiServiceId = api.id;
    const active = await seedDeployment(project, {
      createdAt: new Date(Date.now() - 60_000),
      imageRef: "compose",
      containerId: "compose",
      meta: { runtimeMode: "docker", deployTarget: "local" },
    });
    await setActive(project.id, active.id);

    const group = await runtime.ensureServiceGroup({
      deploymentId: active.id,
      projectId: project.id,
      slug: project.slug,
    });
    const apiPort = await freePort();
    foreignClaimPort = apiPort;
    const launch = (service: typeof postgres, ports: string[]) =>
      runtime.deployServiceWorkload(group, {
        deploymentId: active.id,
        projectId: project.id,
        slug: project.slug,
        serviceName: service.name,
        image: IMAGE,
        ports,
        environment: {},
        volumes: [],
        namespaceVolumes: true,
        command: service.name === "api" ? "httpd -f -p 3000 -h /" : "sleep 600",
        imageAlreadyPrepared: true,
      });
    const oldPostgres = await launch(postgres, []);
    const oldRedis = await launch(redis, []);
    const oldApi = await launch(api, [`127.0.0.1:${apiPort}:3000`]);

    await seedServiceDeployment(active.id, postgres, {
      containerId: oldPostgres.containerId,
      imageRef: IMAGE,
    });
    await seedServiceDeployment(active.id, redis, {
      containerId: oldRedis.containerId,
      imageRef: IMAGE,
    });
    await seedServiceDeployment(active.id, api, {
      // Deliberately stale: live identity must recover oldApi before allocation.
      containerId: "0".repeat(64),
      imageRef: IMAGE,
      hostPort: apiPort,
      hostPorts: { 3000: apiPort },
    });
    await repos.hostPortClaim.reserveHostPortClaim({
      targetKey: LOCAL_HOST_PORT_TARGET.targetKey,
      port: apiPort,
      projectId: "foreign-project",
      serviceId: "foreign-service",
      containerPort: 3000,
    });

    const observedPorts = new Set([apiPort]);
    vi.doMock("@repo/adapters", async (importOriginal) => {
      const actual = (await importOriginal()) as Record<string, unknown>;
      return {
        ...actual,
        edgeProxyFor: () => ({
          listLoopbackUpstreamPortsStrict: async () => new Set(observedPorts),
        }),
      };
    });
    const { deployComposeServices } =
      await import("@repo/platform/engine/modules/deployments/compose/deploy.service");
    const next = await seedDeployment(project, {
      imageRef: "compose",
      containerId: "compose",
      meta: { runtimeMode: "docker", deployTarget: "local" },
    });
    const currentProject = (await repos.project.findById(project.id))!;
    const logger = new BuildLogger(() => undefined);
    const routing = new NoopInfraProvider();
    vi.spyOn(routing, "registerRoute").mockImplementation(async (route) => {
      if (!route.targetUrl) return;
      const routedPort = Number(new URL(route.targetUrl).port);
      if (!Number.isSafeInteger(routedPort) || routedPort < 1) return;
      observedPorts.clear();
      observedPorts.add(routedPort);
    });

    const conflictResult = await deployComposeServices(currentProject, next, runtime, logger, {
      preparedLocalImages: new Map([
        [postgres.id, IMAGE],
        [redis.id, IMAGE],
        [api.id, IMAGE],
      ]),
      routing,
      ssl: new NoopInfraProvider(),
      usesManagedRouting: false,
      executor: createHostExecutor(),
      localHost: true,
      hostPortTarget: LOCAL_HOST_PORT_TARGET,
    });

    expect(conflictResult.status).toBe("ready");
    expect(conflictResult.summary).toMatchObject({ successful: 3, failed: 0, indeterminate: 0 });
    const conflictRows = await repos.service.listByDeployment(next.id);
    expect(conflictRows).toHaveLength(3);
    const conflictApi = conflictRows.find((row) => row.serviceId === api.id)!;
    expect(conflictApi.hostPort).not.toBe(apiPort);
    expect(conflictApi.hostPorts).toEqual({ 3000: conflictApi.hostPort });
    await expect(runtime.getContainerInfo(conflictApi.containerId!)).resolves.toMatchObject({
      status: "running",
      hostPortByContainerPort: { 3000: conflictApi.hostPort },
    });
    expect(observedPorts).toEqual(new Set([conflictApi.hostPort!]));
    for (const previousId of [oldPostgres.containerId, oldRedis.containerId, oldApi.containerId]) {
      await expect(runtime.getContainerInfo(previousId)).resolves.toMatchObject({
        status: "missing",
      });
    }
    expect(await repos.hostPortClaim.listHostPortClaims(LOCAL_HOST_PORT_TARGET.targetKey)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          port: apiPort,
          projectId: "foreign-project",
          serviceId: "foreign-service",
        }),
        expect.objectContaining({
          port: conflictApi.hostPort,
          projectId: project.id,
          serviceId: api.id,
          containerPort: 3000,
        }),
      ]),
    );

    // The first half proves a genuinely conflicting owner causes safe
    // relocation. Now model the production state: the edge still routes the
    // replacement's live binding, but
    // reconciliation quarantined it because the stored container id was stale.
    // A second redeploy must prove ownership from Docker, replace quarantine
    // atomically, and keep the API on the exact same host port.
    expect(
      await repos.hostPortClaim.releaseHostPortClaim({
        targetKey: LOCAL_HOST_PORT_TARGET.targetKey,
        port: apiPort,
        projectId: "foreign-project",
        serviceId: "foreign-service",
        containerPort: 3000,
      }),
    ).toBe(true);
    const relocatedPort = conflictApi.hostPort!;
    await setActive(project.id, next.id);
    expect(
      await repos.hostPortClaim.releaseHostPortClaim({
        targetKey: LOCAL_HOST_PORT_TARGET.targetKey,
        port: relocatedPort,
        projectId: project.id,
        serviceId: api.id,
        containerPort: 3000,
      }),
    ).toBe(true);
    await repos.hostPortClaim.reserveQuarantinedHostPortClaim({
      targetKey: LOCAL_HOST_PORT_TARGET.targetKey,
      port: relocatedPort,
    });
    await repos.service.updateServiceDeployment(conflictApi.id, {
      containerId: "1".repeat(64),
    });

    const retry = await seedDeployment(project, {
      imageRef: "compose",
      containerId: "compose",
      meta: { runtimeMode: "docker", deployTarget: "local" },
    });
    const projectWithRelocatedActive = (await repos.project.findById(project.id))!;
    const retryResult = await deployComposeServices(
      projectWithRelocatedActive,
      retry,
      runtime,
      logger,
      {
        preparedLocalImages: new Map([
          [postgres.id, IMAGE],
          [redis.id, IMAGE],
          [api.id, IMAGE],
        ]),
        routing,
        ssl: new NoopInfraProvider(),
        usesManagedRouting: false,
        executor: createHostExecutor(),
        localHost: true,
        hostPortTarget: LOCAL_HOST_PORT_TARGET,
      },
    );

    expect(retryResult.status).toBe("ready");
    expect(retryResult.summary).toMatchObject({ successful: 3, failed: 0, indeterminate: 0 });
    const retryRows = await repos.service.listByDeployment(retry.id);
    expect(retryRows).toHaveLength(3);
    const retryApi = retryRows.find((row) => row.serviceId === api.id);
    expect(retryApi).toMatchObject({ status: "success", hostPort: relocatedPort });
    expect(retryApi?.hostPorts).toEqual({ 3000: relocatedPort });
    await expect(runtime.getContainerInfo(retryApi!.containerId!)).resolves.toMatchObject({
      containerId: retryApi!.containerId,
      status: "running",
      hostPortByContainerPort: { 3000: relocatedPort },
    });
    expect(
      await repos.hostPortClaim.listHostPortClaims(LOCAL_HOST_PORT_TARGET.targetKey),
    ).toContainEqual(
      expect.objectContaining({
        port: relocatedPort,
        projectId: project.id,
        serviceId: api.id,
        containerPort: 3000,
      }),
    );

    // Docker's list endpoint can omit the publish rows after a container stops,
    // while full inspect retains HostConfig.PortBindings. Reproduce that exact
    // production shape against a real daemon: preflight must inspect only the
    // incomplete container, replace quarantine with its verified owner, and
    // reserve the same free port before touching any service.
    await setActive(project.id, retry.id);
    await runtime.stop(retryApi!.containerId!);
    await expect(runtime.getContainerInfo(retryApi!.containerId!)).resolves.toMatchObject({
      status: "stopped",
      hostPortByContainerPort: { 3000: relocatedPort },
    });
    expect(
      await repos.hostPortClaim.releaseHostPortClaim({
        targetKey: LOCAL_HOST_PORT_TARGET.targetKey,
        port: relocatedPort,
        projectId: project.id,
        serviceId: api.id,
        containerPort: 3000,
      }),
    ).toBe(true);
    await repos.hostPortClaim.reserveQuarantinedHostPortClaim({
      targetKey: LOCAL_HOST_PORT_TARGET.targetKey,
      port: relocatedPort,
    });

    const listAllContainers = runtime.listAllContainers.bind(runtime);
    const inventory = vi
      .spyOn(runtime, "listAllContainers")
      .mockImplementation(async () =>
        (await listAllContainers()).map((container) =>
          container.id === retryApi!.containerId ? { ...container, ports: [] } : container,
        ),
      );
    const inspect = vi.spyOn(runtime, "getContainerInfo");
    const stoppedRetry = await seedDeployment(project, {
      imageRef: "compose",
      containerId: "compose",
      meta: { runtimeMode: "docker", deployTarget: "local" },
    });
    const projectWithStoppedActive = (await repos.project.findById(project.id))!;
    const stoppedRetryResult = await deployComposeServices(
      projectWithStoppedActive,
      stoppedRetry,
      runtime,
      logger,
      {
        preparedLocalImages: new Map([
          [postgres.id, IMAGE],
          [redis.id, IMAGE],
          [api.id, IMAGE],
        ]),
        routing,
        ssl: new NoopInfraProvider(),
        usesManagedRouting: false,
        executor: createHostExecutor(),
        localHost: true,
        hostPortTarget: LOCAL_HOST_PORT_TARGET,
      },
    );
    inventory.mockRestore();

    expect(stoppedRetryResult.status).toBe("ready");
    expect(inspect).toHaveBeenCalledWith(retryApi!.containerId!);
    const stoppedRetryApi = (await repos.service.listByDeployment(stoppedRetry.id)).find(
      (row) => row.serviceId === api.id,
    );
    expect(stoppedRetryApi).toMatchObject({ status: "success", hostPort: relocatedPort });
    expect(stoppedRetryApi?.hostPorts).toEqual({ 3000: relocatedPort });
    await expect(runtime.getContainerInfo(stoppedRetryApi!.containerId!)).resolves.toMatchObject({
      status: "running",
      hostPortByContainerPort: { 3000: relocatedPort },
    });
  }, 180_000);
});
