/** Swarm lives only inside two disposable DinD containers, never on the test host. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import Dockerode from "dockerode";
import { repos } from "@repo/db";
import { seedOrg, seedProject, seedDeployment, seedService, setActive } from "../helpers/seed";
import net from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DockerRuntime,
  NoopInfraProvider,
  SwarmRuntime,
  runDeployPipeline,
  BuildLogger,
  type DeployEnvironment,
} from "@repo/adapters";
import type { DeployConfig, MultiServiceDeployConfig } from "@repo/adapters";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { inspectDockerSwarm, type CommandExecutor } from "@repo/adapters";
import { probeEdge, freeEdgeTargets } from "../../../../packages/adapters/src/system/proxy/detect";
import { describeDockerE2E, dockerSocketPath, requireDocker } from "../helpers/docker-e2e";

const exec = promisify(execFile);
const image = "docker:28.5.2-dind";
const docker = async (args: string[], timeout = 30_000) =>
  (
    await exec("docker", ["--host", `unix://${dockerSocketPath}`, ...args], {
      timeout,
      maxBuffer: 2 * 1024 * 1024,
    })
  ).stdout.trim();

describeDockerE2E("Swarm inspection and ownership on independent Docker daemons", () => {
  const network = `openship-swarm-test-${randomUUID()}`;
  const containers: string[] = [];
  let networkCreated = false;
  let manager: Dockerode, worker: Dockerode;
  let managerContainer: string;
  const inside = (command: string) => docker(["exec", managerContainer, "sh", "-c", command]);

  beforeAll(async () => {
    await requireDocker();
    await docker(["pull", image], 120_000);
    await docker(["network", "create", "--label", "openship.test=swarm-inspection", network]);
    networkCreated = true;
    const registry = await docker(
      [
        "create",
        "--network",
        network,
        "--network-alias",
        "registry",
        "--label",
        "openship.test=swarm-inspection",
        "registry:2.8.3",
      ],
      120_000,
    );
    containers.push(registry);
    await docker(["start", registry]);
    const createNode = async () => {
      const container = await docker([
        "create",
        "--privileged",
        "--network",
        network,
        "--label",
        "openship.test=swarm-inspection",
        "--env",
        "DOCKER_TLS_CERTDIR=",
        "--publish",
        "127.0.0.1::2375",
        image,
        "--insecure-registry=registry:5000",
      ]);
      containers.push(container);
      await docker(["start", container]);
      const inspect = JSON.parse(await docker(["inspect", container]))[0];
      const node = new Dockerode({
        host: "127.0.0.1",
        port: Number(inspect.NetworkSettings.Ports["2375/tcp"][0].HostPort),
        timeout: 5000,
      });
      await vi.waitFor(async () => expect(String(await node.ping())).toBe("OK"), {
        timeout: 40_000,
        interval: 500,
      });
      return {
        node,
        container,
        address: inspect.NetworkSettings.Networks[network].IPAddress as string,
      };
    };
    const m = await createNode(),
      w = await createNode();
    manager = m.node;
    worker = w.node;
    managerContainer = m.container;
    await manager.swarmInit({ ListenAddr: "0.0.0.0:2377", AdvertiseAddr: m.address });
    const swarm = await manager.swarmInspect();
    await worker.swarmJoin({
      ListenAddr: "0.0.0.0:2377",
      AdvertiseAddr: w.address,
      RemoteAddrs: [`${m.address}:2377`],
      JoinToken: swarm.JoinTokens.Worker,
    });
    // Exercise a real stack, including ingress on a manager with NO local task.
    const compose = JSON.stringify({
      version: "3.8",
      services: {
        web: {
          image: "busybox:1.37",
          command: ["sleep", "600"],
          environment: { TEST_PASSWORD: "test-only-private-value" },
          deploy: { replicas: 1, placement: { constraints: ["node.role == worker"] } },
          ports: [{ target: 8080, published: 80 }],
          volumes: ["data:/data"],
        },
      },
      volumes: { data: {} },
    });
    // JSON is also valid YAML; pass the fixture as an argv value, never shell interpolation.
    await docker([
      "exec",
      managerContainer,
      "sh",
      "-c",
      'printf "%s" "$1" | docker stack deploy --resolve-image never -c - sample',
      "fixture",
      compose,
    ]);
    await vi.waitFor(
      async () =>
        expect(
          (await inspectDockerSwarm(manager, true)).inventory?.stacks[0]?.services[0]?.runningTasks,
        ).toBe(1),
      { timeout: 120_000, interval: 1000 },
    );
  }, 360_000);

  afterAll(async () => {
    const cleanup = await Promise.allSettled(
      containers.map((id) => docker(["rm", "--force", "--volumes", id])),
    );
    if (networkCreated) await docker(["network", "rm", network]);
    for (const result of cleanup) if (result.status === "rejected") throw result.reason;
  }, 60_000);

  it("reads the stack from its manager, preserves it during takeover refusal, and guides workers", async () => {
    const result = await inspectDockerSwarm(manager, true);
    expect(result).toMatchObject({
      state: "active",
      role: "manager",
      nodeCount: 2,
      inventory: {
        nodes: expect.arrayContaining([
          expect.objectContaining({ role: "worker", state: "ready" }),
        ]),
        stacks: [
          {
            name: "sample",
            services: [
              {
                name: "sample_web",
                desiredTasks: 1,
                runningTasks: 1,
                ports: [expect.objectContaining({ published: 80, target: 8080 })],
                mounts: [{ type: "volume", target: "/data", readOnly: false }],
              },
            ],
          },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain("test-only-private-value");
    expect(await inspectDockerSwarm(worker, true)).toMatchObject({
      role: "worker",
      inventory: null,
    });
    const servicesBefore = (await manager.listServices()).map((service) => ({
      id: service.ID,
      version: service.Version?.Index,
    }));
    expect(servicesBefore).toEqual([expect.objectContaining({ version: expect.any(Number) })]);
    expect(
      await inside("docker ps -q --filter label=com.docker.swarm.service.name=sample_web"),
    ).toBe("");
    const executor = { exec: inside } as unknown as CommandExecutor;
    expect(await probeEdge(executor)).toMatchObject({
      canProceedClean: false,
      // DinD may lack host listener tools for unrelated ports. The Swarm port
      // must still be identified from the manager, without a local service task.
      occupants: expect.arrayContaining([
        expect.objectContaining({ port: 80, swarmService: "sample_web" }),
      ]),
    });
    await expect(
      freeEdgeTargets(executor, [{ unit: "nginx.service", port: 80 }], () => {}),
    ).rejects.toMatchObject({ code: "SWARM_SERVICE_OWNED" });
    expect(
      (await manager.listServices()).map((service) => ({
        id: service.ID,
        version: service.Version?.Index,
      })),
    ).toEqual(servicesBefore);
    expect(
      (await inspectDockerSwarm(manager, true)).inventory?.stacks[0]?.services[0]?.runningTasks,
    ).toBe(1);
  }, 30_000);

  it("deploys across nodes, uses shared rollback, preserves data and deletes only owned resources", async () => {
    const foreign = (await manager.listServices()).map((item) => ({
      id: item.ID,
      version: item.Version?.Index,
    }));
    const observed = await inspectDockerSwarm(manager);
    const temp = await mkdtemp(join(tmpdir(), "opsh-swarm-"));
    // Only transport location is substituted. The real Docker builder and Swarm
    // adapter operate against disposable daemons, never the test host's Swarm.
    const sockets = new Set<net.Socket>();
    const proxy = net.createServer((socket) => {
      const upstream = net.connect({ host: "127.0.0.1", port: Number(manager.modem.port) });
      for (const peer of [socket, upstream]) {
        sockets.add(peer);
        peer.on("error", () => {
          socket.destroy();
          upstream.destroy();
        });
        peer.on("close", () => sockets.delete(peer));
      }
      socket.pipe(upstream).pipe(socket);
    });
    const socketPath = join(temp, "docker.sock");
    await new Promise<void>((resolve) => proxy.listen(socketPath, resolve));
    const builder = await DockerRuntime.create({
      transport: "socket",
      dockerSocketPath: socketPath,
    });
    const runtimeOptions = {
      projectId: "swarm-e2e",
      runtimeId: "runtime-e2e",
      clusterUid: observed.clusterId!,
      managerNodeId: observed.nodeId!,
      config: { replicas: 2, imageRepository: "registry:5000/openship/swarm-e2e" },
      builder: async () => builder,
      resolveRegistryAuth: async () => undefined,
      gatewayImage: "openresty/openresty:1.27.1.2-0-alpine",
    };
    let runtime = new SwarmRuntime(runtimeOptions);
    const logger = new BuildLogger(() => {});
    const service = (
      release: string,
      extra: Partial<MultiServiceDeployConfig> = {},
    ): MultiServiceDeployConfig => ({
      projectId: "swarm-e2e",
      deploymentId: release,
      slug: "swarm-e2e",
      serviceName: "web",
      image: "busybox:1.37",
      ports: ["8080"],
      publicPort: 8080,
      volumes: [],
      namespaceVolumes: true,
      environment: { SETTING: release },
      advanced: { files: [{ path: "/run/test-message", content: "private-file" }] },
      commandArgv: [
        "sh",
        "-c",
        'mkdir -p /www; printf "%s:" "$SETTING" > /www/index.html; cat /run/test-message >> /www/index.html; echo started; exec httpd -f -p 8080 -h /www',
      ],
      ...extra,
    });
    const cfg = (release: string): DeployConfig => ({
      deploymentId: release,
      projectId: "swarm-e2e",
      buildSessionId: release,
      environment: "production",
      port: 8080,
      envVars: {},
      resources: { cpuCores: 0, memoryMb: 0, diskMb: 0 },
    });
    const group = await runtime.ensureServiceGroup({
      projectId: "swarm-e2e",
      deploymentId: "one",
      slug: "swarm-e2e",
    });
    const env = (definition: MultiServiceDeployConfig): DeployEnvironment => ({
      canOverlap: false,
      preflight: () => runtime.prepareServiceWorkload(definition),
      activate: async (_config, log) => runtime.deployServiceWorkload(group, definition, log),
      healthCheck: async (id) => {
        await read(id);
      },
      deactivate: (id) => runtime.destroy(id),
      deactivateRetaining: (id) => runtime.stop(id),
      reactivatePrevious: (id) => runtime.start(id),
      retireRetainedPrevious: (id) => runtime.destroy(id),
      stopActivated: (id) => runtime.stop(id),
    });
    const read = async (ref: string) => {
      // Scheduler task readiness and overlay/IPVS convergence are asynchronous.
      // Probe actual HTTP with a deadline, just as an application readiness gate
      // would, rather than assuming a single immediate request must succeed.
      console.info(`[swarm-e2e] Checking HTTP for ${ref}`);
      return vi.waitFor(
        async () => inside(`wget -T 3 -qO- http://${await runtime.getContainerIp(ref)}:8080`),
        { timeout: 20_000, interval: 500 },
      );
    };
    try {
      await writeFile(
        join(temp, "Dockerfile"),
        'FROM busybox:1.37\nCOPY message /www/index.html\nCMD ["httpd", "-f", "-p", "8080", "-h", "/www"]\n',
      );
      await writeFile(join(temp, "message"), "source-built-release");
      await writeFile(join(temp, ".dockerignore"), "docker.sock\n");
      const built = await runtime.build(
        {
          sessionId: "source-build",
          projectId: "swarm-e2e",
          slug: "swarm-e2e",
          repoUrl: "",
          branch: "main",
          localPath: temp,
          stack: "docker",
          dockerfilePath: "Dockerfile",
          buildImage: "busybox:1.37",
          runtimeImage: "busybox:1.37",
          packageManager: "none",
          installCommand: "",
          buildCommand: "",
          outputDirectory: ".",
          port: 8080,
          envVars: {},
          hasServer: true,
          resources: { cpuCores: 0, memoryMb: 0, diskMb: 0 },
        },
        logger,
      );
      expect(built.status, built.errorMessage).toBe("deploying");
      expect(built.imageRef).toMatch(/^registry:5000\/openship\/swarm-e2e@sha256:[a-f0-9]{64}$/);
      const source = service("source", {
        serviceName: "source",
        image: built.imageRef!,
        advanced: {},
        commandArgv: undefined,
      });
      const sourceRelease = await runDeployPipeline(
        env(source),
        { config: cfg("source"), domains: [] },
        logger,
      );
      expect(sourceRelease.status, sourceRelease.error).toBe("ready");
      expect(await read(sourceRelease.containerId!)).toBe("source-built-release");
      expect(
        new Set((await runtime.status(sourceRelease.containerId!)).pods.map((pod) => pod.nodeName))
          .size,
      ).toBe(2);
      await runtime.destroy(sourceRelease.containerId!);

      const first = await runDeployPipeline(
        env(service("one")),
        { config: cfg("one"), domains: [] },
        logger,
      );
      expect(first.status, first.error).toBe("ready");
      const original = first.containerId!;
      expect(await read(original)).toBe("one:private-file");
      const status = await runtime.status(original);
      expect(status).toMatchObject({ desired: 2, ready: 2 });
      expect(new Set(status.pods.map((pod) => pod.nodeName)).size).toBe(2);
      const created = await manager.getService(original.split(":").at(-1)!).inspect();
      expect(created.Endpoint?.Ports ?? []).toEqual([]); // No cluster-wide public ingress.
      expect(
        (await runtime.getRuntimeLogs(original)).some((entry) => entry.message.includes("started")),
      ).toBe(true);

      // A failed health gate goes through the SAME pipeline as Docker/Kubernetes.
      const broken = service("bad", { previousContainerId: original });
      const failed = await runDeployPipeline(
        {
          ...env(broken),
          healthCheck: async () => {
            throw new Error("intentional failed readiness");
          },
        },
        { config: cfg("bad"), domains: [], previousContainerId: original },
        logger,
      );
      expect(failed.status).toBe("failed");
      expect(await read(original)).toBe("one:private-file");
      const afterFailure = await runtime.listProjectContainerIds("swarm-e2e");
      expect(afterFailure).toContain(original);
      for (const ref of afterFailure.filter((id) => id !== original)) {
        expect((await runtime.status(ref)).desired).toBe(0);
        await runtime.destroy(ref);
      }
      const next = service("two", { previousContainerId: original });
      const success = await runDeployPipeline(
        env(next),
        { config: cfg("two"), domains: [], previousContainerId: original },
        logger,
      );
      expect(success.status, success.error).toBe("ready");
      expect(await read(success.containerId!)).toBe("two:private-file");
      await runtime.restart(success.containerId!);
      expect(await read(success.containerId!)).toBe("two:private-file");
      expect((await runtime.status(success.containerId!)).updated).toBe(2);
      await runtime.stop(success.containerId!);
      expect((await runtime.status(success.containerId!)).desired).toBe(0);
      await runtime.restart(success.containerId!);
      expect(await read(success.containerId!)).toBe("two:private-file");

      const data = service("data-one", {
        serviceName: "data",
        ports: [],
        publicPort: undefined,
        volumes: ["data:/data"],
        advanced: {},
        commandArgv: [
          "sh",
          "-c",
          "test -f /data/value || echo durable > /data/value; exec sleep 600",
        ],
      });
      const persisted = await runtime.deployServiceWorkload(group, data);
      expect(await runtime.status(persisted.containerId)).toMatchObject({
        desired: 1,
        ready: 1,
        pods: [expect.objectContaining({ nodeName: observed.nodeId })],
      });
      await runtime.stop(persisted.containerId);
      const data2 = {
        ...data,
        deploymentId: "data-two",
        previousContainerId: persisted.containerId,
        commandArgv: ["sh", "-c", 'test "$(cat /data/value)" = durable || exit 1; exec sleep 600'],
      };
      const restored = await runtime.deployServiceWorkload(group, data2);
      await expect(runtime.start(persisted.containerId)).rejects.toMatchObject({
        code: "CLUSTER_WORKLOAD_BUSY",
      });
      expect((await runtime.status(restored.containerId)).ready).toBe(1);
      await expect(runtime.destroy(`swarm:wrong:${created.ID}`)).rejects.toMatchObject({
        code: "CLUSTER_WORKLOAD_OWNERSHIP",
      });

      for (const ref of await runtime.listProjectContainerIds("swarm-e2e"))
        await runtime.destroy(ref);
      // Drive the real Compose orchestrator and repositories too: a config-only
      // redeploy must persist the new release and apply the shared env/file merge.
      const org = await seedOrg();
      const project = await seedProject(org.organizationId, {
        id: "swarm-e2e",
        slug: "swarm-e2e",
        framework: "docker",
        hasBuild: false,
        hasServer: true,
        runtimeMode: "docker",
        routeStrategy: "container-ip",
      });
      const authored = await seedService(project.id, {
        name: "configured",
        image: (await manager.getImage("busybox:1.37").inspect()).RepoDigests![0]!,
        ports: ["8080"],
        exposed: false,
        dependsOn: [],
        environment: { MESSAGE: "${MESSAGE:-from-compose}" },
        advanced: {
          environmentTemplateKeys: ["MESSAGE"],
          files: [{ path: "/run/message", content: "config-one" }],
        },
        commandArgv: [
          "sh",
          "-c",
          'mkdir -p /www; printf "%s:" "$MESSAGE" > /www/index.html; cat /run/message >> /www/index.html; exec httpd -f -p 8080 -h /www',
        ],
      });
      const { deployComposeServices } =
        await import("@repo/platform/engine/modules/deployments/compose/deploy.service");
      const deployCompose = async (replicas = 2) => {
        const deployment = await seedDeployment(project, {
          imageRef: "compose",
          containerId: "compose",
          meta: { runtimeMode: "docker", deployTarget: "local", clusterConfig: { replicas } },
        });
        const current = (await repos.project.findById(project.id))!;
        const result = await deployComposeServices(current, deployment, runtime, logger, {
          routing: new NoopInfraProvider(),
          ssl: new NoopInfraProvider(),
          usesManagedRouting: false,
        });
        expect(result.status, JSON.stringify(result.services)).toBe("ready");
        const rows = await repos.service.listByDeployment(deployment.id);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.status).toBe("success");
        await setActive(project.id, deployment.id);
        return rows[0]!.containerId!;
      };
      const composedOne = await deployCompose();
      expect(await read(composedOne)).toBe("from-compose:config-one");
      await repos.service.update(authored.id, {
        environment: { MESSAGE: "updated-env" },
        advanced: {
          environmentTemplateKeys: [],
          files: [{ path: "/run/message", content: "config-two" }],
        },
      });
      const composedTwo = await deployCompose();
      expect(await read(composedTwo)).toBe("updated-env:config-two");
      expect((await runtime.getContainerInfo(composedOne)).status).toBe("missing");
      await runtime.dispose();
      runtime = new SwarmRuntime({
        ...runtimeOptions,
        config: { ...runtimeOptions.config, replicas: 3 },
        builder: () => DockerRuntime.create({ transport: "socket", dockerSocketPath: socketPath }),
      });
      const composedThree = await deployCompose(3);
      expect(composedThree).not.toBe(composedTwo);
      expect((await runtime.status(composedThree)).ready).toBe(3);
      expect(await read(composedThree)).toBe("updated-env:config-two");
      await runtime.destroy(composedThree);

      await runtime.cleanupProject("swarm-e2e");
      const retained = await manager.listVolumes({
        filters: { label: ["openship.project=swarm-e2e"] },
      });
      expect(retained.Volumes?.length).toBe(1);
      await runtime.cleanupProject("swarm-e2e", { wipeVolumes: true });
      expect(
        (await manager.listVolumes({ filters: { label: ["openship.project=swarm-e2e"] } }))
          .Volumes ?? [],
      ).toEqual([]);
      expect(
        (await manager.listServices()).map((item) => ({
          id: item.ID,
          version: item.Version?.Index,
        })),
      ).toEqual(foreign);
    } finally {
      await runtime.dispose();
      sockets.forEach((socket) => socket.destroy());
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      await rm(temp, { recursive: true, force: true });
    }
  }, 360_000);
});
