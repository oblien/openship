import { repos, seedOwner, installFakeRunner } from "../modules/jobs/_harness";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type Dockerode from "dockerode";
import { DockerRuntime } from "@repo/adapters";
import { ENV_MASK } from "@repo/core";
import { OpenshipClient } from "@repo/sdk/client";
import { encrypt } from "@repo/platform/engine/lib/encryption";
import * as deploymentRuntime from "@repo/platform/engine/lib/deployment-runtime";
import { resolveStaleEnvKeysForService } from "@repo/platform/engine/modules/deployments/env-drift";
import { buildConfigSnapshot, createQueuedDeployment } from "@repo/platform/engine/modules/deployments/build.service";
import { serviceRoutes } from "../../src/modules/services/service.routes";
import { healthRoutes } from "../../src/modules/health/health.routes";
import { handleApiError } from "../../src/middleware/error-handler";
import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";
import { seedDeployment, seedProject, seedService, seedServiceDeployment, setActive } from "../helpers/seed";

installFakeRunner();
const app = new Hono().onError(handleApiError)
  .route("/api/health", healthRoutes)
  .route("/api/projects/:id/services", serviceRoutes);

async function exec(container: Dockerode.Container, command: string[]): Promise<string> {
  const session = await container.exec({ Cmd: command, AttachStdout: true, AttachStderr: true, Tty: true });
  const stream = await session.start({ Tty: true });
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const status = await session.inspect();
  if (status.ExitCode !== 0) throw new Error(`Test probe failed (${status.ExitCode}): ${Buffer.concat(chunks).toString()}`);
  return Buffer.concat(chunks).toString().trim();
}

describeDockerE2E("service environment apply through the HTTP API and real Docker", () => {
  let runtime: DockerRuntime;
  let owner: Awaited<ReturnType<typeof seedOwner>>;
  let client: OpenshipClient;
  let project: Awaited<ReturnType<typeof seedProject>>;
  let service: Awaited<ReturnType<typeof seedService>>;
  let sibling: Awaited<ReturnType<typeof seedService>>;
  let deployment: Awaited<ReturnType<typeof seedDeployment>>;
  let network: Dockerode.Network;
  let original: Dockerode.Container;
  let probe: Dockerode.Container;
  let before: Dockerode.ContainerInspectInfo;
  let imageTag: string;
  const volumes = new Set<string>();

  beforeAll(async () => {
    await requireDocker();
    runtime = await DockerRuntime.create({ transport: "socket" });
    await runtime.pullImage("busybox:latest");
    owner = await seedOwner();
    project = await seedProject(owner.orgId, { framework: "docker-compose", runtimeMode: "docker" });
    service = await seedService(project.id, { name: "api", build: ".", image: null, exposedPort: "3000", environment: { INLINE: "compose" } });
    sibling = await seedService(project.id, { name: "worker", image: "busybox:latest" });
    deployment = await seedDeployment(project, {
      createdAt: new Date(Date.now() - 60_000), containerId: "compose",
      meta: { deployTarget: "local", runtimeMode: "docker", untouched: "retain this" },
      envVars: { OLD_RELEASE_ONLY: encrypt("must not be replayed") },
    });
    await setActive(project.id, deployment.id);
    project = (await repos.project.findById(project.id))!;
    imageTag = `openship/env-apply-e2e:bld_${project.id}`;
    await runtime.docker.getImage("busybox:latest").tag({ repo: "openship/env-apply-e2e", tag: `bld_${project.id}` });
    network = await runtime.docker.createNetwork({ Name: `env-apply-${project.id}`, Driver: "bridge" });
    const volumeName = `env-apply-${project.id}`;
    await runtime.docker.createVolume({ Name: volumeName });
    volumes.add(volumeName);
    original = await runtime.docker.createContainer({
      name: `openship-${project.slug}-api`, Image: imageTag, Hostname: "api",
      Env: ["VALUE=old", "REMOVE=old", "TOKEN=unchanged-secret", "PORT=3000"],
      Cmd: ["sh", "-c", '[ "$FAIL_START" != "1" ] || exit 9; mkdir -p /www; printf "%s" "$VALUE" > /www/index.html; trap \'echo stopped >> /data/stops; exit 0\' TERM; httpd -f -p 3000 -h /www & wait "$!"'],
      Labels: { "openship.project": project.id, "openship.service": service.name, "openship.deployment": deployment.id },
      Volumes: { "/cache": {} },
      ExposedPorts: { "3000/tcp": {} },
      HostConfig: {
        NetworkMode: network.id, Binds: [`${volumeName}:/data`],
        PortBindings: { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "0" }] },
        Memory: 128 * 1024 ** 2, NanoCpus: 500_000_000, RestartPolicy: { Name: "unless-stopped" },
      },
      NetworkingConfig: { EndpointsConfig: { [network.id]: { Aliases: ["api", "api-alias"] } } },
    });
    await original.start();
    before = await original.inspect();
    for (const mount of before.Mounts ?? []) if (mount.Type === "volume" && mount.Name) volumes.add(mount.Name);
    await exec(original, ["sh", "-c", "echo persistent > /data/keep; echo anonymous > /cache/keep"]);
    const ip = Object.values(before.NetworkSettings.Networks)[0]!.IPAddress;
    await seedServiceDeployment(deployment.id, service, { containerId: original.id, imageRef: imageTag, ip,
      allocatedResources: { containerId: original.id, cpuCores: 0.5, memoryMb: 128 } });
    await repos.deployment.setContainerId(deployment.id, original.id);
    probe = await runtime.docker.createContainer({
      name: `openship-${project.slug}-worker`, Image: "busybox:latest", Cmd: ["sleep", "600"],
      Labels: { "openship.project": project.id, "openship.service": sibling.name, "openship.deployment": deployment.id },
      HostConfig: { NetworkMode: network.id },
    });
    await probe.start();
    await seedServiceDeployment(deployment.id, sibling, { containerId: probe.id, imageRef: "busybox:latest" });
    vi.spyOn(deploymentRuntime, "resolveDeploymentRuntimeForRead").mockResolvedValue({ runtime, serverId: null } as never);
    vi.spyOn(runtime, "dispose").mockResolvedValue();
    client = new OpenshipClient({ baseUrl: "http://openship.test", token: owner.token, organizationId: owner.orgId,
      fetch: ((url, init) => app.request(url as string, init)) as typeof fetch });
    await client.services.setEnvVars(project.id, service.id, { environment: "production", vars: [
      { key: "VALUE", value: "old" }, { key: "REMOVE", value: "old" },
      { key: "TOKEN", value: "unchanged-secret", isSecret: true },
    ] });
  });

  afterAll(async () => {
    if (project) {
      const containers = await runtime.docker.listContainers({ all: true, filters: JSON.stringify({ label: [`openship.project=${project.id}`] }) });
      for (const container of containers) await runtime.docker.getContainer(container.Id).remove({ force: true }).catch(() => {});
    }
    await network?.remove().catch(() => {});
    for (const volume of volumes) await runtime.docker.getVolume(volume).remove().catch(() => {});
    if (imageTag) await runtime.docker.getImage(imageTag).remove().catch(() => {});
    vi.restoreAllMocks();
    await runtime?.dispose();
  });

  it("applies saved env with a missing local build tag, preserving data, networking, limits and sibling uptime", async () => {
    const siblingBefore = await probe.inspect();
    await runtime.docker.getImage(imageTag).remove({ force: true });
    await expect(runtime.docker.getImage(imageTag).inspect()).rejects.toMatchObject({ statusCode: 404 });
    await repos.project.bulkSetEnvVars(project.id, "production", [{ key: "SHARED", value: encrypt("new shared") }], null);
    await client.services.setEnvVars(project.id, service.id, { environment: "production", vars: [
      { key: "VALUE", value: "new" }, { key: "TOKEN", value: ENV_MASK, isSecret: true }, { key: "EMPTY", value: "" },
    ] });
    const pull = vi.spyOn(runtime.docker, "pull");
    const build = vi.spyOn(runtime.docker, "buildImage");
    const result = await client.services.applyEnvironment(project.id, service.id);
    expect(result.success).toBe(true);
    expect(result.containerId).not.toBe(original.id);
    const current = runtime.docker.getContainer(result.containerId);
    const after = await current.inspect();
    expect(after.Image).toBe(before.Image);
    expect(after.Config.Env).toEqual(expect.arrayContaining(["VALUE=new", "TOKEN=unchanged-secret", "SHARED=new shared", "INLINE=compose", "EMPTY="]));
    expect(after.Config.Env.some(value => value.startsWith("REMOVE=") || value.startsWith("OLD_RELEASE_ONLY="))).toBe(false);
    expect(after.HostConfig.PortBindings).toEqual(before.HostConfig.PortBindings);
    expect(after.HostConfig.Memory).toBe(before.HostConfig.Memory);
    expect(after.HostConfig.NanoCpus).toBe(before.HostConfig.NanoCpus);
    expect(after.Config.Cmd).toEqual(before.Config.Cmd);
    expect(Object.values(after.NetworkSettings.Networks)[0]!.IPAddress).toBe(Object.values(before.NetworkSettings.Networks)[0]!.IPAddress);
    expect(await exec(current, ["cat", "/data/keep"])).toBe("persistent");
    expect(await exec(current, ["cat", "/cache/keep"])).toBe("anonymous");
    expect(await exec(current, ["cat", "/data/stops"])).toBe("stopped");
    expect(await exec(probe, ["wget", "-qO-", "http://api-alias:3000"])).toBe("new");
    expect((await probe.inspect()).State.StartedAt).toBe(siblingBefore.State.StartedAt);
    expect(pull).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
    expect((await repos.deployment.listByProject(project.id)).total).toBe(1);
    expect(await repos.deployment.findBuildSessionByDeploymentId(deployment.id)).toBeUndefined();
    const active = (await repos.deployment.findById(deployment.id))!;
    expect(active.containerId).toBe(result.containerId);
    expect(active.meta).toMatchObject({ untouched: "retain this", serviceEnvironmentApplied: { [service.id]: { containerId: result.containerId } } });
    const rows = await repos.service.listByDeployment(deployment.id);
    expect(rows.find(item => item.serviceId === service.id)?.allocatedResources?.containerId).toBe(result.containerId);
    await expect(resolveStaleEnvKeysForService(project, "production", service.id)).resolves.toEqual([]);
    await expect(resolveStaleEnvKeysForService(project, "production", sibling.id)).resolves.toEqual(["SHARED"]);
    await expect(original.inspect()).rejects.toMatchObject({ statusCode: 404 });
  });

  it("holds deployment admission until the new service identity is committed", async () => {
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const atCommit = new Promise<void>(resolve => { entered = resolve; });
    const record = repos.service.recordEnvironmentApply.bind(repos.service);
    const spy = vi.spyOn(repos.service, "recordEnvironmentApply").mockImplementation(async input => {
      entered(); await blocked; return record(input);
    });
    let queued: Awaited<ReturnType<typeof createQueuedDeployment>> | undefined;
    const applying = client.services.applyEnvironment(project.id, service.id);
    await atCommit;
    let admitted = false;
    const queue = createQueuedDeployment({
      projectId: project.id, organizationId: owner.orgId, branch: "main", environment: "production",
      framework: "docker-compose", meta: buildConfigSnapshot(project), envVars: null,
    }).then(result => { admitted = true; queued = result; return result; });
    try {
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(admitted).toBe(false);
      expect(await repos.deployment.listInFlightByProject(project.id)).toEqual([]);
      release();
      await applying;
      await queue;
      expect(admitted).toBe(true);
      // An explicitly queued deploy now blocks Apply, before touching Docker.
      const row = (await repos.service.listByDeployment(deployment.id)).find(item => item.serviceId === service.id)!;
      const startedAt = (await runtime.docker.getContainer(row.containerId!).inspect()).State.StartedAt;
      await expect(client.services.applyEnvironment(project.id, service.id)).rejects.toMatchObject({ code: "DEPLOYMENT_IN_PROGRESS" });
      expect((await runtime.docker.getContainer(row.containerId!).inspect()).State.StartedAt).toBe(startedAt);
    } finally {
      release();
      await Promise.allSettled([applying, queue]);
      spy.mockRestore();
      if (queued) await repos.deployment.deleteDeployment(queued.id);
    }
  });

  it("restores the runtime if committing its new database identity fails", async () => {
    const old = (await repos.service.listByDeployment(deployment.id)).find(item => item.serviceId === service.id)!;
    const parentBefore = (await repos.deployment.findById(deployment.id))!;
    const record = repos.service.recordEnvironmentApply.bind(repos.service);
    const spy = vi.spyOn(repos.service, "recordEnvironmentApply").mockImplementationOnce(input =>
      record({ ...input, expectedContainerId: "stale-container-id" }));
    try {
      await expect(client.services.applyEnvironment(project.id, service.id)).rejects.toMatchObject({ code: "SERVICE_ENVIRONMENT_APPLY_FAILED" });
      expect((await repos.service.listByDeployment(deployment.id)).find(item => item.serviceId === service.id)?.containerId).toBe(old.containerId);
      expect((await repos.deployment.findById(deployment.id))?.meta).toEqual(parentBefore.meta);
      expect((await runtime.docker.getContainer(old.containerId!).inspect()).State.Running).toBe(true);
      expect(await exec(probe, ["wget", "-qO-", "http://api-alias:3000"])).toBe("new");
    } finally { spy.mockRestore(); }
  });

  it("restores the current container and leaves changes pending when the new env crashes the process", async () => {
    const old = (await repos.service.listByDeployment(deployment.id)).find(item => item.serviceId === service.id)!;
    await client.services.setEnvVars(project.id, service.id, { environment: "production", vars: [
      { key: "VALUE", value: "broken" }, { key: "FAIL_START", value: "1" }, { key: "TOKEN", value: ENV_MASK, isSecret: true },
    ] });
    await expect(client.services.applyEnvironment(project.id, service.id)).rejects.toMatchObject({ code: "SERVICE_ENVIRONMENT_APPLY_FAILED" });
    const current = (await repos.service.listByDeployment(deployment.id)).find(item => item.serviceId === service.id)!;
    expect(current.containerId).toBe(old.containerId);
    expect((await runtime.docker.getContainer(old.containerId!).inspect()).State.Running).toBe(true);
    expect(await exec(probe, ["wget", "-qO-", "http://api-alias:3000"])).toBe("new");
    expect(await resolveStaleEnvKeysForService(project, "production", service.id)).toContain("FAIL_START");
    expect((await repos.deployment.listByProject(project.id)).total).toBe(1);
  });

  it("refuses a different customer's service without stopping it", async () => {
    const other = await seedOwner();
    const response = await app.request(`http://openship.test/api/projects/${project.id}/services/${service.id}/apply-env`, {
      method: "POST", headers: { Authorization: `Bearer ${other.token}` },
    });
    expect(response.status).toBe(404);
    expect(await exec(probe, ["wget", "-qO-", "http://api:3000"])).toBe("new");
  });
});
