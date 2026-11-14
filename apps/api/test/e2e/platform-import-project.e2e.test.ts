import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { once } from "node:events";
import {
  BuildLogger,
  CommandSourceBackupExecutor,
  CloudDockerRuntime,
  DockerRuntime,
  type CommandExecutor,
} from "@repo/adapters";
import { CloudServerConnection } from "../../../../packages/adapters/src/runtime/cloud/server-connection";
import { CloudWorkspaceExecutor } from "../../../../packages/adapters/src/runtime/cloud/workspace-executor";
import { db, repos, schema } from "@repo/db";
import type { ExecutionContext } from "@repo/platform";
import type { ProviderInventory } from "@repo/platform/engine/modules/migration/providers/types";
import { encrypt, decryptEnvMap } from "@repo/platform/engine/lib/encryption";
import { deployComposeServices } from "@repo/platform/engine/modules/deployments/compose/deploy.service";
import { projectServicesToDeployableServices } from "@repo/platform/engine/modules/deployments/compose/project-services";
import { seedDeployment, seedOrg, setActive } from "../helpers/seed";
import { describeDockerE2E, requireDocker, dockerSocketPath } from "../helpers/docker-e2e";

// Substitute Railway's control/SSH boundary and the asynchronous build queue.
// Review, project creation, encrypted environments, migration checkpoints,
// volume transfer and the ordinary Compose deployment engine remain real.
const h = vi.hoisted(() => ({
  discover: vi.fn(),
  prepare: vi.fn(),
  assertStopped: vi.fn(),
  openSource: vi.fn(),
  runtime: vi.fn(),
  deploy: vi.fn(),
}));
vi.mock("@repo/platform/engine/modules/credentials/connection-authorization", () => ({
  getProviderAccess: async () => ({ provider: "railway", publicFields: {}, secrets: {} }),
}));
vi.mock("@repo/platform/engine/modules/migration/providers/railway", () => ({
  railwayMigrationProvider: { discover: h.discover },
}));
vi.mock("@repo/platform/engine/modules/migration/providers/railway-project-transfer", () => ({
  prepareRailwayProjectTransfer: h.prepare,
  assertRailwayExportOnly: h.assertStopped,
  restoreRailwayProjectTransfer: async () => {},
}));
vi.mock("@repo/platform/engine/modules/migration/providers/railway-data", () => ({
  openRailwayDataSource: h.openSource,
}));
vi.mock("@repo/platform/engine/modules/migration/migration-runtime", async (original) => ({
  ...(await original<object>()),
  createMigrationDockerRuntime: h.runtime,
}));
vi.mock("@repo/platform/engine/modules/deployments/build.service", () => ({
  triggerDeployment: h.deploy,
}));
import {
  discoverPlatform,
  reviewPlatform,
  loadReviewedImport,
} from "@repo/platform/engine/modules/migration/platform-import-plan";
import { executePlatformImport } from "@repo/platform/engine/modules/migration/platform-import-worker";

describeDockerE2E("Railway projects retain native service boundaries", () => {
  const tag = `import-groups-${randomUUID().slice(0, 8)}`;
  const containers = new Set<string>();
  const volumes = new Set<string>();
  const projects: Array<{ id: string; slug: string }> = [];
  const sources = new Map<string, { container: string; exporter: string }>();
  let runtime: DockerRuntime;
  const exec = async (id: string, command: string) =>
    (await (await runtime.inContainerExecutor(id)).exec(command)).trim();

  beforeAll(async () => {
    await requireDocker();
    runtime = await DockerRuntime.create({ transport: "socket" });
    await runtime.pullImage("redis:7-alpine");
    await runtime.pullImage("alpine:3");
    const host = await runtime.docker.createContainer({
      Image: "alpine:3",
      Cmd: ["sleep", "infinity"],
      Labels: { "openship.test": tag },
      HostConfig: { NetworkMode: "host" },
    });
    containers.add(host.id);
    await host.start();
    vi.spyOn(CloudServerConnection.prototype, "connectDocker").mockImplementation(async () => {
      const socket = createConnection(dockerSocketPath);
      await once(socket, "connect");
      return socket;
    });
    vi.spyOn(CloudServerConnection.prototype, "ensureDocker").mockResolvedValue();
    vi.spyOn(CloudServerConnection.prototype, "publishedPorts").mockResolvedValue([]);
    vi.spyOn(CloudWorkspaceExecutor.prototype, "exec").mockImplementation((command) =>
      exec(host.id, command),
    );
  });
  afterAll(async () => {
    if (!runtime) return;
    for (const project of projects) {
      for (const id of await runtime.listProjectContainerIds(project.id)) containers.add(id);
    }
    for (const id of containers) {
      const container = runtime.docker.getContainer(id);
      for (const mount of (await container.inspect()).Mounts) {
        if (mount.Type === "volume" && mount.Name) volumes.add(mount.Name);
      }
      await container.remove({ force: true });
    }
    for (const project of projects) await runtime.removeNetwork(project.slug);
    for (const volume of (await runtime.docker.listVolumes()).Volumes ?? []) {
      if (projects.some((project) => volume.Labels?.["openship.project"] === project.id))
        volumes.add(volume.Name);
    }
    for (const name of volumes) await runtime.docker.getVolume(name).remove();
    await runtime.dispose();
    vi.restoreAllMocks();
  });

  async function start(image: string, volume: string, command: string[]) {
    const container = await runtime.docker.createContainer({
      Image: image,
      Cmd: command,
      Labels: { "openship.test": tag },
      HostConfig: { Binds: [`${volume}:/data`] },
    });
    containers.add(container.id);
    await container.start();
    return container.id;
  }

  it.each(["socket", "cloud"] as const)(
    "imports two three-service projects through %s, isolating DNS, env and persisted data",
    async (transport) => {
      const owner = await seedOrg({ ownsHost: true });
      const ctx = {
        ...owner,
        role: "owner",
        user: { id: owner.userId, name: "Test", email: "test@example.test" },
        sessionKind: "cookie",
      } as ExecutionContext;
      const serverId = `${tag}-${transport}`;
      await db.insert(schema.servers).values({
        id: serverId,
        organizationId: owner.organizationId,
        isLocal: true,
        sshHost: "localhost",
        sshUser: "root",
        sshAuthMethod: "key",
      });
      const openRuntime = () =>
        DockerRuntime.create(
          transport === "socket"
            ? { transport: "socket" }
            : {
                transport: "cloud",
                // The real managed Docker transport, with only its provider tunnel
                // replaced. Host execution must never be used for copying data.
                cloudConnection: async () => {
                  const socket = createConnection(dockerSocketPath);
                  await once(socket, "connect");
                  return socket;
                },
                executor: {
                  exec: async () => {
                    throw new Error("Unexpected API-host execution");
                  },
                  dispose: async () => {},
                } as unknown as CommandExecutor,
              },
        );
      h.runtime.mockImplementation(openRuntime);
      h.prepare.mockImplementation(async (_run, plan) => {
        for (const service of plan.services) {
          const source = sources.get(service.source.id);
          if (source) await runtime.docker.getContainer(source.container).stop({ t: 10 });
        }
      });
      h.assertStopped.mockImplementation(async () => {
        for (const source of sources.values()) {
          expect(
            (await runtime.docker.getContainer(source.container).inspect()).State.Running,
          ).toBe(false);
        }
      });
      h.openSource.mockImplementation(async (_run, service) => {
        const source = sources.get(service.id)!;
        const channel = {
          rawExec: async (command: string) => {
            const child = spawn("docker", ["exec", source.exporter, "sh", "-c", command]);
            return {
              stdout: child.stdout,
              stderr: child.stderr,
              kill: () => {
                child.kill("SIGKILL");
              },
              onClose: new Promise<number>((resolve, reject) => {
                child.once("error", reject);
                child.once("close", (code) => resolve(code ?? 1));
              }),
            };
          },
        } as CommandExecutor;
        return {
          executor: new CommandSourceBackupExecutor(channel, ["/data"]),
          dispose: async () => {},
        };
      });
      h.deploy.mockImplementation(async (_ctx, input) => {
        // This isolated daemon uses its private project networks; no edge or
        // published host ports are needed for this container-IP routing fixture.
        await repos.project.update(input.projectId, { routeStrategy: "container-ip" });
        const project = (await repos.project.findById(input.projectId))!;
        const services = await repos.service.listByProject(project.id);
        const deployment = await seedDeployment(project, {
          status: "deploying",
          trigger: "manual",
          imageRef: "compose",
          containerId: "compose",
          meta: {
            runtimeMode: "docker",
            deployTarget: "local",
            composeServices: projectServicesToDeployableServices(services),
          },
        });
        const target =
          transport === "socket"
            ? await openRuntime()
            : await CloudDockerRuntime.forWorkspace(
                {
                  vms: {
                    get: async () => ({
                      id: serverId,
                      namespace: owner.organizationId,
                      status: "running",
                    }),
                  },
                } as unknown as Parameters<typeof CloudDockerRuntime.forWorkspace>[0],
                {
                  workspaceId: serverId,
                  ownerWorkspaceId: serverId,
                  projectId: project.id,
                  namespace: owner.organizationId,
                  provisionLock: { run: (work) => work() },
                  resolveRegistryAuth: async () => undefined,
                },
              );
        try {
          const result = await deployComposeServices(
            project,
            deployment,
            target,
            new BuildLogger(() => {}),
            {
              executor: null,
              localHost: false,
              preparedLocalImages: new Map(services.map((s) => [s.id, s.image!])),
              targetServiceIds: new Set(input.serviceIds),
            },
          );
          expect(result.status, JSON.stringify(result)).toBe("ready");
          await repos.deployment.updateStatus(deployment.id, "ready");
          await setActive(project.id, deployment.id);
          await result.cutover?.commit();
        } finally {
          await target.dispose();
        }
        return { deployment };
      });

      const imported: Array<{ id: string; marker: string }> = [];
      for (const projectNumber of [1, 2]) {
        const marker = `${tag}-${transport}-${projectNumber}`;
        const services: ProviderInventory["services"] = [];
        for (const name of ["db", "cache"]) {
          const id = `${marker}-${name}`;
          const volume = `${id}-source`;
          await runtime.docker.createVolume({ Name: volume });
          volumes.add(volume);
          const container = await start("redis:7-alpine", volume, [
            "redis-server",
            "--appendonly",
            "yes",
          ]);
          await expect
            .poll(() => exec(container, "redis-cli PING"), { timeout: 10_000 })
            .toBe("PONG");
          await exec(container, `redis-cli SET marker '${marker}-${name}'`);
          const exporter = await start("alpine:3", volume, ["sleep", "infinity"]);
          sources.set(id, { container, exporter });
          services.push({
            id,
            name,
            kind: "database",
            database: "redis_rdb",
            image: "redis:7-alpine",
            instanceId: container,
            privateDomain: `${name}.railway.internal`,
            port: 6379,
            env: { SERVICE_SECRET: `${marker}-${name}` },
            rawEnv: {},
            variables: [],
            volumes: [{ id: volume, mountPath: "/data" }],
            domains: [],
            warnings: [],
            blockers: [],
            startCommand: "redis-server --appendonly yes",
          });
        }
        services.push({
          id: `${marker}-worker`,
          name: "worker",
          kind: "worker",
          image: "redis:7-alpine",
          instanceId: "source-worker",
          port: 8080,
          env: {
            SERVICE_SECRET: `${marker}-worker`,
            PRIMARY_HOST: "db.railway.internal",
            CACHE_HOST: "cache.railway.internal",
            BOTH_HOSTS: "db.railway.internal,cache.railway.internal",
          },
          rawEnv: {},
          variables: [],
          volumes: [],
          domains: [
            { hostname: `${marker}.example.com`, portable: true },
            { hostname: `www.${marker}.example.com`, portable: true },
            { hostname: `${marker}.up.railway.app`, portable: false },
          ],
          warnings: [],
          blockers: [],
          startCommand:
            "sh -c 'while true; do printf \"HTTP/1.1 200 OK\\r\\nContent-Length: 6\\r\\nConnection: close\\r\\n\\r\\nready\\n\" | nc -l -p 8080; done'",
        });
        const inventory: ProviderInventory = {
          provider: "railway",
          source: { connectionId: "fixture", projectId: marker, environmentId: "production" },
          projectName: marker,
          environmentName: "Production",
          services,
          warnings: [],
        };
        h.discover.mockImplementation(async () => structuredClone(inventory));
        const discovery = await discoverPlatform(ctx, inventory.source);
        const review = await reviewPlatform(ctx, {
          draftId: discovery.draftId,
          targetServerId: serverId,
          services: discovery.services.map((s) => ({ id: s.id, name: s.name, data: "copy" })),
        });
        expect(review.ready, JSON.stringify(review)).toBe(true);
        const plan = await loadReviewedImport(ctx, review.planId);
        const runId = `${marker}-run`;
        await repos.dockerMigrationRun.create({
          id: runId,
          organizationId: owner.organizationId,
          targetServerId: serverId,
          projectName: marker,
          mode: "provider_import",
          status: "adopting",
          inputSnapshot: { provider: "railway", source: inventory.source },
          recovery: {
            providerImport: {
              planId: plan.id,
              planEnc: encrypt(JSON.stringify(plan)),
              connectionId: "fixture",
              projects: {},
              completed: [],
              cleanupPending: true,
            },
          },
        });
        try {
          await executePlatformImport(ctx, runId, plan, {
            signal: new AbortController().signal,
            log: () => {},
            progress: () => {},
            phase: async () => {},
            wait: async (id) => (await repos.deployment.findById(id))?.status === "ready",
          });
        } finally {
          const saved = await repos.project.listByOrganization(owner.organizationId);
          for (const p of saved.rows)
            if (!projects.some((known) => known.id === p.id)) projects.push(p);
        }
        const checkpoint = (await repos.dockerMigrationRun.findById(runId))!.recovery
          .providerImport!;
        const ids = [...new Set(Object.values(checkpoint.projects))];
        expect(ids).toHaveLength(1);
        const id = ids[0];
        expect(await repos.service.listByProject(id)).toHaveLength(3);
        expect(checkpoint.completed).toHaveLength(3);
        expect((await repos.project.listByOrganization(owner.organizationId)).total).toBe(
          projectNumber,
        );
        expect(await repos.project.getEnvMap(id, "production", null)).toEqual({});
        imported.push({ id, marker });
      }

      // Check both projects AFTER the second import: duplicate service names
      // must not redirect the first project's DNS or overwrite its storage.
      for (const { id, marker } of imported) {
        const project = (await repos.project.findById(id))!;
        const rows = await repos.service.listByProject(id);
        const deployed = await repos.service.listByDeployment(project.activeDeploymentId!);
        for (const service of rows) {
          const env = decryptEnvMap(await repos.project.getEnvMap(id, "production", service.id));
          expect(env.SERVICE_SECRET).toBe(`${marker}-${service.name}`);
          const container = deployed.find((r) => r.serviceId === service.id)!.containerId!;
          expect(await exec(container, 'printf %s "$SERVICE_SECRET"')).toBe(env.SERVICE_SECRET);
          if (service.name === "worker") {
            expect(service.exposed).toBe(true);
            expect(service.publicEndpoints).toEqual([
              expect.objectContaining({ port: 8080, customDomain: `${marker}.example.com` }),
            ]);
            const domains = await repos.domain.listByProject(id);
            expect(domains.map((domain) => domain.hostname).sort()).toEqual(
              [`${marker}.example.com`, `www.${marker}.example.com`].sort(),
            );
            expect(
              domains.every(
                (domain) =>
                  domain.serviceId === service.id && domain.targetPort === 8080 && !domain.verified,
              ),
            ).toBe(true);
            expect(await exec(container, "wget -qO- http://127.0.0.1:8080")).toBe("ready");
            expect(await exec(container, 'printf %s "$BOTH_HOSTS"')).toBe("db,cache");
            expect(await exec(container, 'redis-cli -h "$PRIMARY_HOST" GET marker')).toBe(
              `${marker}-db`,
            );
            expect(await exec(container, 'redis-cli -h "$CACHE_HOST" GET marker')).toBe(
              `${marker}-cache`,
            );
          } else {
            expect(await exec(container, "redis-cli GET marker")).toBe(`${marker}-${service.name}`);
            await exec(container, "redis-cli SET new-write survives");
            await runtime.docker.getContainer(container).restart({ t: 10 });
            await expect
              .poll(() => exec(container, "redis-cli GET marker"), { timeout: 10_000 })
              .toBe(`${marker}-${service.name}`);
            expect(await exec(container, "redis-cli GET new-write")).toBe("survives");
          }
        }
      }
    },
  );
});
