import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BuildLogger,
  DockerRuntime,
  runDeployPipeline,
  type DeployConfig,
  type MultiServiceDeployConfig,
} from "@repo/adapters";
import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";

describeDockerE2E("image-declared data survives real Docker replacement", () => {
  let runtime: DockerRuntime;
  let context: string;
  const key = randomUUID().replaceAll("-", "").slice(0, 12);
  const images = [`openship/volume-e2e-${key}:v1`, `openship/volume-e2e-${key}:v2`];
  const projects = new Set<string>();
  const volumes = new Set<string>();

  function config(): DeployConfig {
    const projectId = `volume-e2e-${key}-${projects.size}`;
    projects.add(projectId);
    return {
      projectId,
      deploymentId: `${projectId}-v1`,
      buildSessionId: `${projectId}-build`,
      imageRef: images[0],
      runtimeName: projectId,
      slug: projectId,
      networkAlias: "app",
      environment: "production",
      envVars: {},
      port: 8000,
      portless: true,
      resources: { cpuCores: 0, memoryMb: 0, diskMb: 0 },
      restartPolicy: "no",
    };
  }

  async function remember(id: string) {
    for (const name of await runtime.inspectNamedVolumes(id)) volumes.add(name);
    return id;
  }

  async function command(id: string, cmd: string) {
    return (await (await runtime.inContainerExecutor(id)).exec(cmd)).trim();
  }

  async function legacy(cfg: DeployConfig, serviceName?: string) {
    const container = await runtime.docker.createContainer({
      name: serviceName
        ? `openship-${cfg.slug}-${serviceName}`
        : DockerRuntime.deploymentContainerName(cfg),
      Image: cfg.imageRef,
      HostConfig: { NetworkMode: "none" },
      Labels: {
        "openship.project": cfg.projectId,
        "openship.deployment": cfg.deploymentId,
        ...(serviceName ? { "openship.service": serviceName } : {}),
      },
      // Deliberately omit Binds: reproduces pre-fix image VOLUME behavior.
    });
    await container.start();
    await remember(container.id);
    await command(container.id, "printf 'customer-data' > /data/record");
    return container.id;
  }

  beforeAll(async () => {
    await requireDocker();
    runtime = await DockerRuntime.create({ transport: "socket" });
    await runtime.pullImage("busybox:1.37.0");
    context = await mkdtemp(join(tmpdir(), "openship-image-volume-e2e-"));
    for (const [index, image] of images.entries()) {
      await writeFile(
        join(context, "Dockerfile"),
        [
          "FROM busybox:1.37.0",
          `RUN echo '${index + 1}' > /version && mkdir /data && chown 1000:1000 /data`,
          'VOLUME ["/data"]',
          "USER 1000:1000",
          'CMD ["sleep", "3600"]',
          "",
        ].join("\n"),
      );
      const stream = await runtime.docker.buildImage(
        { context, src: ["Dockerfile"] },
        { t: image, networkmode: "none" },
      );
      await new Promise<void>((resolve, reject) =>
        runtime.docker.modem.followProgress(
          stream,
          (error: Error | null, output: Array<{ error?: string }>) => {
            const failure = output?.find((event) => event.error)?.error;
            if (error || failure) reject(error ?? new Error(failure));
            else resolve();
          },
        ),
      );
      await runtime.docker.getImage(image).inspect();
    }
  });

  afterAll(async () => {
    if (runtime) {
      for (const project of projects) {
        for (const id of await runtime.listProjectContainerIds(project)) {
          await remember(id);
          await runtime.docker.getContainer(id).remove({ force: true });
        }
      }
      for (const volume of volumes) await runtime.docker.getVolume(volume).remove();
      for (const project of projects) await runtime.removeNetwork(project);
      for (const image of images) {
        try {
          await runtime.docker.getImage(image).remove();
        } catch (error) {
          if ((error as { statusCode?: number }).statusCode !== 404) throw error;
        }
      }
      await runtime.dispose();
    }
    if (context) await rm(context, { recursive: true, force: true });
  });

  it("replaces the image, preserves data and reuses the same volume after removing the old container", async () => {
    const cfg = config();
    const first = await runtime.deploy(cfg);
    const id = await remember(first.containerId!);
    const names = await runtime.inspectNamedVolumes(id);
    await command(id, "printf 'saved' > /data/record");
    await runtime.destroy(id);

    // A new runtime rules out accidental persistence in a JS object/cache.
    const fresh = await DockerRuntime.create({ transport: "socket" });
    try {
      const next = await fresh.deploy({
        ...cfg,
        deploymentId: `${cfg.projectId}-v2`,
        imageRef: images[1],
      });
      await remember(next.containerId!);
      expect(await command(next.containerId!, "cat /version /data/record")).toBe("2\nsaved");
      expect(await runtime.inspectNamedVolumes(next.containerId!)).toEqual(names);
    } finally {
      await fresh.dispose();
    }
  });

  it("joins concurrent removal before recreating a stateful service", async () => {
    const cfg = config();
    const old = await legacy(cfg, "db");
    const names = await runtime.inspectNamedVolumes(old);
    const group = await runtime.ensureServiceGroup({ projectId: cfg.projectId, slug: cfg.slug! });
    const next: MultiServiceDeployConfig = {
      projectId: cfg.projectId, deploymentId: `${cfg.projectId}-v2`, slug: cfg.slug,
      serviceName: "db", image: images[1], ports: [], environment: {}, volumes: [],
      namespaceVolumes: true, previousContainerId: old, imageAlreadyPrepared: true,
    };
    await runtime.prepareServiceVolumes(next);
    await Promise.all([runtime.destroy(old), runtime.destroy(old)]);
    await expect(runtime.docker.getContainer(old).inspect()).rejects.toMatchObject({ statusCode: 404 });
    const replacement = await runtime.deployServiceWorkload(group, next);
    await remember(replacement.containerId!);
    expect(await runtime.inspectNamedVolumes(replacement.containerId!)).toEqual(names);
    expect(await command(replacement.containerId!, "cat /version /data/record")).toBe("2\ncustomer-data");
  });

  it("reuses a legacy anonymous volume for release commands, web and roles across redeploys", async () => {
    const cfg = config();
    const old = await legacy(cfg);
    const names = await runtime.inspectNamedVolumes(old);
    const next = {
      ...cfg,
      deploymentId: `${cfg.projectId}-v2`,
      imageRef: images[1],
      previousContainerId: old,
      previousDeploymentId: cfg.deploymentId,
    };
    await runtime.prepareDeploymentVolumes(next);
    await runtime.runReleaseCommand(
      next,
      'test "$(cat /data/record)" = customer-data && echo migrated > /data/migration',
      () => {},
    );
    const result = await runDeployPipeline(
      {
        activate: (config) => runtime.deploy(config),
        deactivate: (id) => runtime.destroy(id),
        deactivateRetaining: (id) => runtime.stop(id),
        retireRetainedPrevious: (id) => runtime.destroy(id),
        reactivatePrevious: (id) => runtime.start(id),
      },
      { config: next, previousContainerId: old, domains: [] },
      new BuildLogger(),
    );
    expect(result.status, result.error).toBe("ready");
    await remember(result.containerId!);
    expect(await runtime.inspectNamedVolumes(result.containerId!)).toEqual(names);
    expect(await command(result.containerId!, "cat /data/record /data/migration")).toBe(
      "customer-datamigrated",
    );
    const role = await runtime.deployRole(next, { name: "worker", command: "sleep 3600" }, 1);
    await remember(role.containerId);
    expect(await runtime.inspectNamedVolumes(role.containerId)).toEqual(names);
    // Release cleanup with v:true must not delete reattached legacy data.
    expect(await runtime.docker.getVolume(names[0]!).inspect()).toBeTruthy();
  });

  it("captures Compose mounts before the pipeline removes the old container and isolates sibling services", async () => {
    const cfg = config();
    const old = await legacy(cfg, "web");
    const names = await runtime.inspectNamedVolumes(old);
    const group = await runtime.ensureServiceGroup({ projectId: cfg.projectId, slug: cfg.slug! });
    const next: MultiServiceDeployConfig = {
      projectId: cfg.projectId,
      slug: cfg.slug!,
      deploymentId: `${cfg.projectId}-v2`,
      serviceName: "web",
      image: images[1]!,
      previousContainerId: old,
      imageAlreadyPrepared: true,
      volumes: [],
      namespaceVolumes: true,
      ports: [],
      environment: {},
    };
    const result = await runDeployPipeline(
      {
        preflight: () => runtime.prepareServiceVolumes(next),
        activate: () => runtime.deployServiceWorkload(group, next),
        deactivate: (id) => runtime.destroy(id),
      },
      { config: cfg, previousContainerId: old, domains: [] },
      new BuildLogger(),
    );
    expect(result.status, result.error).toBe("ready");
    await remember(result.containerId!);
    expect(await command(result.containerId!, "cat /data/record")).toBe("customer-data");
    expect(await runtime.inspectNamedVolumes(result.containerId!)).toEqual(names);
    const sibling = await runtime.deployServiceWorkload(group, {
      ...next,
      serviceName: "other",
      previousContainerId: undefined,
    });
    await remember(sibling.containerId);
    expect(await command(sibling.containerId, "test ! -e /data/record && echo isolated")).toBe(
      "isolated",
    );
    expect(await runtime.inspectNamedVolumes(sibling.containerId)).not.toEqual(names);
  });

  it("keeps explicit volume selection authoritative", async () => {
    const cfg = { ...config(), volumes: ["chosen:/data"] };
    const result = await runtime.deploy(cfg);
    await remember(result.containerId!);
    expect(await runtime.inspectNamedVolumes(result.containerId!)).toEqual([
      `openship-${cfg.slug}-chosen`,
    ]);
  });

  it("fails preparation without stopping a container owned by another project", async () => {
    const cfg = config();
    const old = await legacy(cfg);
    const other = { ...config(), previousContainerId: old };
    await expect(runtime.prepareDeploymentVolumes(other)).rejects.toThrow("ownership");
    expect((await runtime.docker.getContainer(old).inspect()).State.Running).toBe(true);
    expect(await command(old, "cat /data/record")).toBe("customer-data");
  });
});
