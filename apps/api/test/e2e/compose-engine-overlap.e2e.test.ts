import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { BuildLogger, DockerRuntime, NoopInfraProvider, createHostExecutor } from "@repo/adapters";
import { repos } from "@repo/db";
import { LOCAL_HOST_PORT_TARGET } from "@repo/platform/engine/lib/host-port-target";
import { deployComposeServices } from "@repo/platform/engine/modules/deployments/compose/deploy.service";
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
const resources = { cpuCores: 0.05, memoryMb: 32 };
const command = (content: string) => [
  "sh",
  "-c",
  `mkdir -p /www; echo '${content}' >/www/index.html; exec httpd -f -p 8080 -h /www`,
];

/** Real engine + database + target mutex. A mocked lock cannot catch reentry. */
describeDockerE2E("Compose engine overlap commits through its existing pipeline", () => {
  let runtime: DockerRuntime;
  let projectId = "";
  let slug = "";
  const executor = createHostExecutor();

  beforeAll(async () => {
    await requireDocker();
    runtime = await DockerRuntime.create({ transport: "socket" });
    await runtime.pullImage(IMAGE);
  }, 120_000);

  afterAll(async () => {
    if (projectId)
      for (const id of await runtime.listProjectContainerIds(projectId).catch(() => [])) {
        await runtime.destroy(id).catch(() => undefined);
      }
    if (slug) await runtime?.removeNetwork(slug).catch(() => undefined);
    await runtime?.dispose();
  });

  it("returns without nested target locks and keeps the predecessor until commit", async () => {
    const { organizationId } = await seedOrg({ ownsHost: true });
    const project = await seedProject(organizationId, {
      slug: `engine-cutover-${randomUUID().slice(0, 8)}`,
      framework: "docker-compose",
      runtimeMode: "docker",
      routeStrategy: "container-ip",
      hasBuild: false,
      hasServer: true,
    });
    projectId = project.id;
    slug = project.slug;
    const service = await seedService(project.id, {
      name: "web",
      enabled: true,
      image: IMAGE,
      build: ".",
      ports: [],
      exposed: true,
      exposedPort: "8080",
      domainType: "custom",
      customDomain: null,
      commandArgv: command("new"),
      volumes: [],
      environment: {},
      dependsOn: [],
      advanced: { resources },
    });
    const previous = await seedDeployment(project, {
      containerId: "compose",
      imageRef: "compose",
      meta: { deployTarget: "local", runtimeMode: "docker", port: 8080,
        composeServices: [{ name: service.name, enabled: true, kind: "compose",
          ports: [], exposed: true, exposedPort: "8080" }] },
    });
    const group = await runtime.ensureServiceGroup({ deploymentId: previous.id, projectId, slug });
    const old = await runtime.deployServiceWorkload(group, {
      deploymentId: previous.id,
      projectId,
      slug,
      serviceName: service.name,
      image: IMAGE,
      imageAlreadyPrepared: true,
      ports: [],
      publicPort: 8080,
      volumes: [],
      namespaceVolumes: true,
      environment: {},
      resources,
      commandArgv: command("old"),
    });
    await seedServiceDeployment(previous.id, service, {
      containerId: old.containerId,
      imageRef: IMAGE,
      ip: old.ip,
    });
    await setActive(projectId, previous.id);
    const current = (await repos.project.findById(projectId))!;
    const next = await seedDeployment(project, {
      status: "deploying",
      trigger: "manual",
      containerId: "compose",
      imageRef: "compose",
      meta: { deployTarget: "local", runtimeMode: "docker" },
    });
    const noop = new NoopInfraProvider();
    const result = await deployComposeServices(
      current,
      next,
      runtime,
      new BuildLogger(() => undefined),
      {
        executor,
        hostPortTarget: LOCAL_HOST_PORT_TARGET,
        localHost: true,
        routing: noop,
        ssl: noop,
        usesManagedRouting: false,
        builtImages: new Map([[service.id, IMAGE]]),
        preparedLocalImages: new Map([[service.id, IMAGE]]),
      },
    );
    expect(result.status, JSON.stringify(result)).toBe("ready");
    expect(result.cutover, "CI must exercise admitted overlap, not a fallback").toBeDefined();
    expect((await runtime.docker.getContainer(old.containerId).inspect()).State.Running).toBe(true);
    const candidate = result.services.find((row) => row.serviceId === service.id)!;
    expect(candidate.containerId).not.toBe(old.containerId);
    expect((await repos.service.listByDeployment(next.id))[0]?.containerId).toBe(
      candidate.containerId,
    );
    expect(
      (
        await executor.exec(`curl --fail --silent --max-time 2 http://${candidate.ip}:8080/`)
      ).trim(),
    ).toBe("new");
    expect(
      (await executor.exec(`curl --fail --silent --max-time 2 http://${old.ip}:8080/`)).trim(),
    ).toBe("old");
    await repos.deployment.updateStatus(next.id, "ready");
    await setActive(projectId, next.id);
    await result.cutover!.commit();
    await expect(runtime.docker.getContainer(old.containerId).inspect()).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(
      (
        await executor.exec(`curl --fail --silent --max-time 2 http://${candidate.ip}:8080/`)
      ).trim(),
    ).toBe("new");
  }, 60_000);
});
