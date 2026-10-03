import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { once } from "node:events";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  CloudDockerRuntime,
  CloudInfraProvider,
  DockerRuntime,
  cloudDockerProjectPaths,
  dockerProjectStorage,
  sq,
  type BuildConfig,
} from "@repo/adapters";
import { db, repos, schema, eq } from "@repo/db";
import * as deploymentTarget from "@repo/platform/engine/lib/deployment-runtime";
import * as platformConfig from "@repo/platform/engine/lib/platform-config";
import {
  collectProjectManifest,
  executeCleanup,
} from "@repo/platform/engine/modules/projects/project-cleanup.service";
import {
  appConfigHostPath,
  writeAppConfigFile,
} from "@repo/platform/engine/modules/deployments/compose/app-config-host";
import * as serviceContainer from "@repo/platform/engine/modules/services/service-container";
import {
  ensureSharedServiceNetwork,
  sharedServiceAlias,
} from "@repo/platform/engine/modules/projects/shared-service-network";
import { DockerBackupExecutor } from "../../../../packages/adapters/src/backup/executors/docker";
import type { ServiceHandle } from "../../../../packages/adapters/src/backup/types";
import type { MultiServiceDeployConfig } from "../../../../packages/adapters/src/runtime/types";
import * as transport from "../../../../packages/adapters/src/runtime/cloud/docker-transport";
import { CLOUD_DOCKER_BRIDGE_VERSION } from "../../../../packages/adapters/src/runtime/cloud/docker-bridge-source";
import { createProvisionLock } from "@repo/platform/engine/lib/provision-lock";
import { describeDockerE2E, requireDocker, dockerSocketPath } from "../helpers/docker-e2e";

const command = promisify(execFile);
const tag = randomUUID().slice(0, 8);
const ids = [`shared-${tag}-a`, `shared-${tag}-b`];
const ownerWorkspaceId = `workspace-${tag}`;
const providerVm = `vm-${tag}`;
const namespace = `namespace-${tag}`;
const organizationId = `organization-${tag}`;
const image = "busybox:1.37";

// Only Oblien's transport and edge APIs are simulated. Docker HTTP/exec/attach,
// the shared Cloud adapter, mount handling, environment replacement and volume
// backup/restore all run against a real daemon. No production credentials/VMs.
describeDockerE2E("multiple projects on one subscribed Docker workspace", () => {
  let local: DockerRuntime;
  let a: CloudDockerRuntime;
  let b: CloudDockerRuntime;
  let helperId: string;
  let configA: MultiServiceDeployConfig;
  let aId = "",
    bId = "";
  let groupA: Awaited<ReturnType<CloudDockerRuntime["ensureServiceGroup"]>>;
  let groupB: typeof groupA;
  let routingA: CloudInfraProvider;
  let routingB: CloudInfraProvider;
  const pages = new Map<string, any>();
  const routes = new Map<string, any>();
  const providerDelete = vi.fn();
  const providerResize = vi.fn();
  let ingress: number[] = [];
  const hostExec = async (script: string) =>
    (
      await command("docker", ["exec", helperId, "chroot", "/host", "/bin/sh", "-c", script], {
        maxBuffer: 4 * 1024 * 1024,
      })
    ).stdout;
  const exec = async (id: string, script: string) =>
    (await command("docker", ["exec", id, "sh", "-c", script])).stdout;
  const service = (runtime: CloudDockerRuntime, id: string): ServiceHandle => ({
    id: `${runtime.projectId}-api`,
    projectId: runtime.projectId,
    projectSlug: runtime.projectId,
    name: "api",
    image,
    env: {},
    volumes: ["data:/data"],
    namespaceVolumes: true,
    containerId: id,
  });

  beforeAll(async () => {
    await requireDocker();
    local = await DockerRuntime.create({ transport: "socket" });
    await local.pullImage(image);
    // Execute provider file commands on the daemon's host, including remote
    // Docker contexts (a Mac control plane must never write the Mac filesystem).
    const helper = await local.docker.createContainer({
      Image: image,
      Cmd: ["sleep", "3600"],
      Labels: { "openship.test": tag },
      HostConfig: { Binds: ["/:/host"], NetworkMode: "host", PidMode: "host" },
    });
    helperId = helper.id;
    await helper.start();
    vi.spyOn(transport, "dockerWebSocketStream").mockImplementation(async () => {
      const socket = createConnection(dockerSocketPath);
      await once(socket, "connect");
      return socket;
    });
    const providerRuntime = {
      proxy: () => ({
        fetch: async () => new Response(CLOUD_DOCKER_BRIDGE_VERSION),
        ws: () => ({}),
      }),
      files: {
        write: async ({ fullPath, content }: { fullPath: string; content: string }) => {
          await hostExec(
            `printf '%s' ${sq(Buffer.from(content).toString("base64"))} | base64 -d > ${sq(fullPath)}`,
          );
          return { success: true };
        },
        read: async ({ filePath }: { filePath: string }) => ({
          success: true,
          content: await hostExec(`cat ${sq(filePath)}`),
        }),
        delete: async ({ path }: { path: string }) => {
          await hostExec(`rm -f -- ${sq(path)}`);
          return { success: true };
        },
      },
      exec: {
        kill: async () => ({ success: true }),
        run: async (args: string[]) => ({
          stdout: await hostExec(args.map(sq).join(" ")),
          exit_code: 0,
        }),
        stream: async function* (args: string[]) {
          try {
            const result = await hostExec(args.map(sq).join(" "));
            yield { event: "stdout", data: Buffer.from(result).toString("base64") };
            yield { event: "exit", exit_code: 0 };
          } catch (error) {
            const failed = error as { stdout?: string; stderr?: string; code?: number };
            if (failed.stdout)
              yield { event: "stdout", data: Buffer.from(failed.stdout).toString("base64") };
            if (failed.stderr)
              yield { event: "stderr", data: Buffer.from(failed.stderr).toString("base64") };
            yield { event: "exit", exit_code: failed.code ?? 1 };
          }
        },
      },
    };
    const vm = { id: providerVm, namespace, status: "running" };
    const provider = {
      workspaces: {
        get: async () => vm,
        create: () => {
          throw new Error("Project operation attempted to create a second host");
        },
      },
      workspace: () => ({
        get: async () => vm,
        runtime: async () => providerRuntime,
        workloads: { list: async () => [] },
        delete: providerDelete,
        resources: { update: providerResize },
        network: {
          get: async () => ({ ingress_ports: ingress }),
          update: async (input: { ingress_ports: number[] }) => {
            ingress = input.ingress_ports;
            return { success: true };
          },
        },
      }),
      pages: {
        get: async (slug: string) => {
          if (!pages.has(slug)) throw Object.assign(new Error("missing"), { status: 404 });
          return { page: pages.get(slug) };
        },
        list: async () => ({ pages: [...pages.values()] }),
        create: async (input: any) => {
          const page = {
            id: pages.size + 1,
            slug: input.slug,
            domain: "opsh.io",
            url: `https://${input.slug}.opsh.io`,
            namespace,
            source_workspace_id: input.workspace_id,
            exported_path: input.path,
          };
          pages.set(input.slug, page);
          return { page };
        },
        connectDomain: async (slug: string, { domain }: { domain: string }) => {
          pages.get(slug).custom_domain = domain;
          return { success: true };
        },
        enable: async () => ({ success: true }),
        disable: async () => ({ success: true }),
        delete: async (slug: string) => {
          pages.delete(slug);
          routes.delete(`${slug}.opsh.io`);
          return { success: true };
        },
      },
      routes: {
        set: async (hostname: string, input: any) => {
          routes.set(hostname, input);
          return { success: true };
        },
      },
      domain: {
        routes: async () => ({
          data: [...pages.values()].map((page) => ({
            hostname: `${page.slug}.${page.domain}`,
            namespace,
            owner_type: "page",
            owner_id: page.id,
          })),
        }),
      },
    };
    const lock = createProvisionLock(`cloud-docker-e2e:${tag}`);
    [a, b] = await Promise.all(
      ids.map((projectId) =>
        CloudDockerRuntime.forWorkspace(provider as never, {
          projectId,
          workspaceId: providerVm,
          ownerWorkspaceId,
          namespace,
          provisionLock: lock,
          resolveRegistryAuth: async () => undefined,
        }),
      ),
    );
    [routingA, routingB] = [a, b].map((runtime) => new CloudInfraProvider(provider as never, {
      namespace, scope: runtime.routingScope(),
    })) as [CloudInfraProvider, CloudInfraProvider];
    await db.insert(schema.organization).values({
      id: organizationId,
      name: "Shared host test",
      slug: organizationId,
      createdAt: new Date(),
    });
    await db
      .insert(schema.cloudWorkspace)
      .values({ id: ownerWorkspaceId, organizationId, name: "Production", namespace });
    await db.insert(schema.servers).values({ organizationId, workspaceId: ownerWorkspaceId, name: "Production", sshHost: null });
    for (const id of ids) {
      const group = await repos.projectGroup.create({ organizationId, name: id, slug: id });
      await repos.project.create({
        id,
        organizationId,
        groupId: group.id,
        serverId: (await repos.server.findByWorkspace(ownerWorkspaceId, organizationId))!.id,
        name: id,
        slug: id,
      });
    }
    await repos.cloudDockerWorkspace.reserve(
      {
        ownerWorkspaceId,
        namespace,
        image: "oblien/docker:29",
        resources: { cpuCores: 4, memoryMb: 6144, diskMb: 32768 },
      },
      organizationId,
    );
    await repos.cloudDockerWorkspace.attach(
      { ownerWorkspaceId },
      organizationId,
      namespace,
      providerVm,
    );
    [groupA, groupB] = await Promise.all(
      [a, b].map((runtime) =>
        runtime.ensureServiceGroup({
          projectId: runtime.projectId,
          slug: runtime.projectId,
          deploymentId: "first",
        }),
      ),
    );
    configA = {
      projectId: ids[0]!,
      slug: ids[0]!,
      deploymentId: "first",
      serviceName: "api",
      image,
      imageAlreadyPrepared: true,
      volumes: ["data:/data"],
      namespaceVolumes: true,
      ports: [],
      environment: { VERSION: "one" },
      commandArgv: [
        "sh",
        "-c",
        "mkdir -p /data/www; printf '%s' \"$VERSION\" > /data/www/index.html; exec httpd -f -p 8080 -h /data/www",
      ],
      publicPort: 8080,
      cloudEndpoints: [{ hostname: `${ids[0]}.opsh.io`, port: 8080, custom: false }],
      resources: { cpuCores: 0.25, memoryMb: 128 },
    };
    const first = await a.deployServiceWorkload(groupA, configA);
    const second = await b.deployServiceWorkload(groupB, {
      ...configA,
      projectId: ids[1]!,
      slug: ids[1]!,
      environment: { VERSION: "sibling" },
      cloudEndpoints: [{ hostname: `${ids[1]}.opsh.io`, port: 8080, custom: false }],
    });
    aId = first.containerId;
    bId = second.containerId;
    expect(first.routeWarnings).toBeUndefined();
    expect(second.routeWarnings).toBeUndefined();
    for (const [runtime, infra, containerId] of [[a, routingA, aId], [b, routingB, bId]] as const) {
      const port = (await runtime.getContainerInfo(containerId)).hostPortByContainerPort![8080]!;
      await infra.publishRoute(`${runtime.projectId}.opsh.io`, port, false);
    }
  });
  afterAll(async () => {
    if (local) {
      for (const projectId of ids) {
        for (const row of await local.docker.listContainers({
          all: true,
          filters: { label: [`openship.project=${projectId}`] },
        }))
          await local.docker.getContainer(row.Id).remove({ force: true, v: true });
        await local.removeNetwork(projectId).catch(() => {});
        const volumes = await local.docker.listVolumes({
          filters: { label: [`openship.project=${projectId}`] },
        });
        for (const volume of volumes.Volumes ?? [])
          await local.docker.getVolume(volume.Name).remove();
        if (helperId) {
          const paths = cloudDockerProjectPaths(projectId, ownerWorkspaceId);
          await hostExec(`rm -rf -- ${sq(paths.mounts)} ${sq(paths.routes)}`);
        }
      }
      if (helperId) await local.docker.getContainer(helperId).remove({ force: true });
    }
    await a?.dispose();
    await b?.dispose();
    await local?.dispose();
    vi.restoreAllMocks();
  });

  it("serves separate routes/ports with independent volumes and enforceable Micro container caps", async () => {
    const [first, second] = await Promise.all([a.getContainerInfo(aId), b.getContainerInfo(bId)]);
    expect(first.hostPortByContainerPort?.[8080]).not.toBe(second.hostPortByContainerPort?.[8080]);
    expect(await exec(aId, "wget -qO- http://127.0.0.1:8080")).toBe("one");
    expect(await exec(bId, "wget -qO- http://127.0.0.1:8080")).toBe("sibling");
    const info = await a.docker.getContainer(aId).inspect();
    expect(info.HostConfig.NanoCpus).toBe(250_000_000);
    expect(info.HostConfig.Memory).toBe(128 * 1024 * 1024);
    const aVolume = info.Mounts.find((mount) => mount.Destination === "/data")!.Name!;
    expect((await local.docker.getVolume(aVolume).inspect()).Labels["openship.project"]).toBe(
      a.projectId,
    );
    expect((await a.listAllContainers()).map((row) => row.id)).toEqual([aId]);
    expect(routes.get(`${ids[0]}.opsh.io`).routes[0].action).toMatchObject({
      workspace: providerVm,
      port: first.hostPortByContainerPort?.[8080],
    });
  });
  it("rejects foreign containers, routes, mounts, network groups and backup sources", async () => {
    await expect(a.stop(bId)).rejects.toMatchObject({ code: "CONTAINER_NOT_FOUND" });
    await expect(a.getContainerInfo(bId)).rejects.toMatchObject({ code: "CONTAINER_NOT_FOUND" });
    await expect(
      a.deployServiceWorkload(groupB, { ...configA, serviceName: "foreign-network" }),
    ).rejects.toMatchObject({ code: "CLOUD_NETWORK_CONFLICT" });
    await expect(
      a.deployServiceWorkload(groupA, {
        ...configA,
        volumes: ["/var/run/docker.sock:/var/run/docker.sock"],
      }),
    ).rejects.toThrow("Shared Cloud mounts");
    const otherPort = (await b.getContainerInfo(bId)).hostPortByContainerPort![8080]!;
    await expect(routingA.publishRoute(`${ids[0]}.opsh.io`, otherPort, false)).rejects.toThrow(/belong|owned/);
    const backups = new DockerBackupExecutor(a);
    await expect(
      backups.readContainerEnv({ ...service(a, aId), containerId: bId }),
    ).rejects.toMatchObject({ code: "CONTAINER_NOT_FOUND" });
    const volume = (await local.docker.getContainer(bId).inspect()).Mounts.find(
      (mount) => mount.Destination === "/data",
    )!.Name!;
    await expect(
      backups.listSources({
        ...service(a, aId),
        containerId: null,
        namespaceVolumes: false,
        volumes: [`${volume}:/data`],
      }),
    ).rejects.toMatchObject({ code: "CLOUD_STORAGE_FORBIDDEN" });
    expect((await b.getContainerInfo(bId)).status).toBe("running");
  });
  it("keeps stopped service bindings owned and restores routing without restarting them", async () => {
    const port = (await a.getContainerInfo(aId)).hostPortByContainerPort![8080]!;
    await a.stop(aId);
    try {
      await routingA.publishRoute(`${ids[0]}.opsh.io`, port, false);
      await expect(routingB.publishRoute(`${ids[1]}.opsh.io`, port, false)).rejects.toThrow(/belong|owned/);
      expect((await a.getContainerInfo(aId)).status).toBe("stopped");
      expect((await b.getContainerInfo(bId)).status).toBe("running");
    } finally {
      await a.start(aId);
    }
  });
  it("reapplies environment, restores volume bytes and replays an image without touching the sibling host", async () => {
    await exec(aId, "printf retained-data > /data/sentinel");
    const updated = await a.applyEnvironment(
      aId,
      { VERSION: "two", PASSWORD: "test-only-secret" },
      { projectId: a.projectId, serviceName: "api", onReplaced: async () => {} },
    );
    aId = updated.containerId;
    expect(await exec(aId, "cat /data/sentinel")).toBe("retained-data");
    expect((await a.docker.getContainer(aId).inspect()).Config.Env).toContain("VERSION=two");
    const backup = new DockerBackupExecutor(a);
    const handle = service(a, aId);
    const source = (await backup.listSources(handle)).find((item) => item.target === "/data")!;
    const capture = await backup.streamPath(handle, source.id, { compression: "gzip" });
    const chunks: Buffer[] = [];
    for await (const chunk of capture.stdout) chunks.push(Buffer.from(chunk));
    expect((await capture.awaitExit).code).toBe(0);
    await exec(aId, "rm /data/sentinel");
    await backup.receiveStream(handle, source.id, Readable.from(Buffer.concat(chunks)), {
      compression: "gzip",
    });
    expect(await exec(aId, "cat /data/sentinel")).toBe("retained-data");
    const restored = await a.deployServiceWorkload(groupA, {
      ...configA,
      deploymentId: "rollback",
      environment: { VERSION: "one" },
    });
    aId = restored.containerId;
    expect(await exec(aId, "cat /data/sentinel")).toBe("retained-data");
    expect(await exec(bId, "wget -qO- http://127.0.0.1:8080")).toBe("sibling");
    expect(providerDelete).not.toHaveBeenCalled();
    expect(providerResize).not.toHaveBeenCalled();
  });
  it("mounts generated app config and repository files on the workspace, preserving writable data", async () => {
    const source: BuildConfig = {
      projectId: a.projectId,
      sessionId: `source-${tag}`,
      repoUrl: "",
      branch: "main",
      stack: "docker",
      buildImage: image,
      runtimeImage: image,
      packageManager: "none",
      installCommand: "",
      buildCommand: "",
      outputDirectory: ".",
      port: 8080,
      envVars: {},
      inlineSourceFiles: [
        { path: "config/message.txt", content: "repository-config" },
        { path: "seed/original.txt", content: "initial-data" },
      ],
    };
    await a.prepareComposeSource(source);
    const configPath = appConfigHostPath(
      a.projectId,
      "catalog",
      "/etc/catalog.conf",
      ownerWorkspaceId,
    );
    await writeAppConfigFile(
      a.executor,
      configPath,
      "generated-config",
      "catalog",
      "/etc/catalog.conf",
    );
    const input = {
      ...configA,
      serviceName: "catalog",
      publicPort: undefined,
      cloudEndpoints: [],
      volumes: [
        `${configPath}:/etc/catalog.conf:ro`,
        "./config/message.txt:/etc/repository.conf:ro",
        "./seed:/persistent",
      ],
      commandArgv: ["sleep", "3600"],
    };
    let instance = await a.deployServiceWorkload(groupA, input);
    expect(await exec(instance.containerId, "cat /etc/catalog.conf")).toBe("generated-config");
    expect(await exec(instance.containerId, "cat /etc/repository.conf")).toBe("repository-config");
    await exec(instance.containerId, "printf live-data > /persistent/original.txt");
    await writeAppConfigFile(
      a.executor,
      configPath,
      "updated-config",
      "catalog",
      "/etc/catalog.conf",
    );
    // Atomic replacement leaves the current bind inode unchanged until deploy.
    expect(await exec(instance.containerId, "cat /etc/catalog.conf")).toBe("generated-config");
    instance = await a.deployServiceWorkload(groupA, { ...input, deploymentId: "config-update" });
    expect(await exec(instance.containerId, "cat /etc/catalog.conf")).toBe("updated-config");
    expect(await exec(instance.containerId, "cat /persistent/original.txt")).toBe("live-data");
    expect((await b.getContainerInfo(bId)).status).toBe("running");
  });
  it("resolves the source project's adapter for a private service link on the shared host", async () => {
    const source = (await repos.project.findById(a.projectId))!;
    const targetService = await repos.service.create({
      projectId: source.id,
      name: "api",
      kind: "compose",
      image,
      enabled: true,
    });
    const deployment = await repos.deployment.create({
      projectId: source.id,
      organizationId,
      branch: "main",
      status: "ready",
      meta: {
        deployTarget: "cloud",
        managedWorkspaceId: ownerWorkspaceId,
        managedServer: { projectId: a.projectId, workspaceId: providerVm, ownerWorkspaceId },
        composeServices: [{ name: "api", containerId: aId }],
      },
    });
    const sourceRuntime = vi.spyOn(serviceContainer, "resolveServicePlatform").mockResolvedValue({
      platform: { runtime: a, executor: a.executor },
      owned: false,
      serverId: null,
    } as never);
    // Keep the fixture's long-lived adapters alive when the engine disposes
    // the temporary platform it resolved for the source service.
    const dispose = vi.spyOn(deploymentTarget, "disposePlatform").mockImplementation(() => {});
    const alias = sharedServiceAlias(targetService.id);
    try {
      await ensureSharedServiceNetwork(source, targetService.id, b, deployment.id);
      expect(sourceRuntime).toHaveBeenCalledWith(
        source,
        expect.objectContaining({ id: deployment.id }),
      );
      await b.attachToExternalNetworks(b.projectId, [`openship-${alias}`], [], {
        onlyContainerIds: [bId],
        strict: true,
      });
      expect(await exec(bId, `wget -qO- http://${alias}:8080`)).toBe("one");
      await b.leaveServiceGroupContainers(alias, [bId]);
      expect(
        (await local.docker.getContainer(bId).inspect()).NetworkSettings.Networks,
      ).not.toHaveProperty(`openship-${alias}`);
    } finally {
      await a.leaveServiceGroupContainers(alias, [aId]);
      await a.removeNetwork(alias);
      sourceRuntime.mockRestore();
      dispose.mockRestore();
    }
  });
  it("runs a single app and a worker on the project network, then removes only that project's containers", async () => {
    const base = {
      projectId: a.projectId,
      slug: a.projectId,
      buildSessionId: "built",
      imageRef: image,
      environment: "production",
      envVars: {},
      port: 8080,
      volumes: [],
      resources: { cpuCores: 0.25, memoryMb: 128, diskMb: 25600 },
    };
    const single = await a.deploy({
      ...base,
      deploymentId: "single",
      startCommand: "mkdir -p /www; echo single > /www/index.html; exec httpd -f -p 8080 -h /www",
    });
    const worker = await a.deploy({
      ...base,
      deploymentId: "worker",
      portless: true,
      startCommand: "exec sleep 3600",
    });
    const network = (await local.docker.getContainer(worker.containerId).inspect()).HostConfig
      .NetworkMode;
    expect(network).toBe(groupA.id);
    expect((await a.getContainerInfo(worker.containerId)).hostPortByContainerPort ?? {}).toEqual(
      {},
    );
    expect(single.containerId).not.toBe(worker.containerId);
    const inventory = await local.docker.df();
    const storage = dockerProjectStorage(
      inventory,
      ids.map((id) => ({ id, slug: id })),
    );
    const measurements = {
      storage,
      containers: inventory.Containers?.filter((container) =>
        ids.includes(container.Labels?.["openship.project"] ?? ""),
      ).map((container) => ({
        project: container.Labels?.["openship.project"],
        bytes: container.SizeRw,
      })),
      volumes: inventory.Volumes?.filter((volume) =>
        ids.includes(volume.Labels?.["openship.project"] ?? ""),
      ).map((volume) => ({
        project: volume.Labels?.["openship.project"],
        usage: volume.UsageData,
      })),
    };
    expect(
      storage.every((row) => row.bytes !== null && row.bytes > 0),
      JSON.stringify(measurements),
    ).toBe(true);
    // Exercise the same manifest and cleanup engine as Delete project, including
    // orphans with no deployment row. Only target transport selection is supplied
    // by the fixture; ownership repositories and every Docker action are real.
    const bound = {
      target: "cloud",
      runtime: a,
      routing: routingA,
      ssl: routingA,
      executor: a.executor,
      localHost: false,
      system: null,
    } as const;
    vi.spyOn(platformConfig, "platform").mockReturnValue({
      ...bound,
      runtime: { name: "cloud" },
    } as never);
    vi.spyOn(deploymentTarget, "resolveDeploymentPlatform").mockImplementation(async (meta) => {
      expect(meta?.managedServer).toMatchObject({
        projectId: a.projectId,
        workspaceId: providerVm,
        ownerWorkspaceId,
      });
      return { platform: bound, owned: true, serverId: null } as never;
    });
    await repos.deployment.create({
      projectId: a.projectId,
      organizationId,
      branch: "main",
      status: "ready",
      containerId: worker.containerId,
      meta: {
        deployTarget: "cloud",
        managedWorkspaceId: ownerWorkspaceId,
        managedServer: { projectId: a.projectId, workspaceId: providerVm, ownerWorkspaceId },
      },
    });
    const project = (await repos.project.findById(a.projectId))!;
    const siblingPort = (await b.getContainerInfo(bId)).hostPortByContainerPort![8080]!;
    const manifest = await collectProjectManifest(project, { wipeVolumes: true });
    expect(manifest.resources.some((resource) => resource.type === "cloud_workspace")).toBe(false);
    expect(
      manifest.resources
        .filter((resource) => resource.type === "container")
        .map((resource) => resource.ref),
    ).toContain(worker.containerId);
    const cleanup = await executeCleanup(manifest);
    expect(cleanup.failed).toEqual([]);
    expect(await routingA.listProjectRouteHostnames()).toEqual([]);
    expect(routes.has(`${ids[0]}.opsh.io`)).toBe(false);
    expect(routes.has(`${ids[1]}.opsh.io`)).toBe(true);
    // Provider network settings belong to the host; deleting an application
    // removes its route and listener without resetting the server's allowlist.
    expect(ingress).toContain(siblingPort);
    expect(
      await local.docker.listContainers({
        all: true,
        filters: { label: [`openship.project=${a.projectId}`] },
      }),
    ).toEqual([]);
    expect(
      (await local.docker.listVolumes({ filters: { label: [`openship.project=${a.projectId}`] } }))
        .Volumes,
    ).toEqual([]);
    await db.delete(schema.project).where(eq(schema.project.id, a.projectId));
    expect(
      (await repos.cloudDockerWorkspace.find({ ownerWorkspaceId }, organizationId))?.workspaceId,
    ).toBe(providerVm);
    expect(pages.has(`${ids[0]}`)).toBe(false);
    expect(pages.has(`${ids[1]}`)).toBe(true);
    expect((await b.getContainerInfo(bId)).status).toBe("running");
    expect(await exec(bId, "cat /data/www/index.html")).toBe("sibling");
    expect(providerDelete).not.toHaveBeenCalled();
    expect(providerResize).not.toHaveBeenCalled();
  });
});
