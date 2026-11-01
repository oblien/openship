/** Real host preparation, private cluster setup, shared files and database data.
 * Only the machines are disposable: SSH, systemd, API, controllers and disks run. */
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { serve, type ServerType } from "@hono/node-server";
import { randomUUID } from "node:crypto";
import { db, repos, schema } from "@repo/db";
import {
  k3sTools,
  installDocker,
  DockerRuntime,
  KubernetesRuntime,
  patchKubernetesObject,
  type KubernetesApi,
  type KubernetesObject,
} from "@repo/adapters";
import {
  allocateClusterRuntimeRanges,
  type ClusterRuntime,
  type ClusterVolumeSnapshot,
  type ClusterVolume,
} from "@repo/core";
import type { ClusterStorage, DeploymentEvent } from "@repo/contracts";
import { OpenshipClient } from "@repo/sdk/client";
import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";
import { seedOrg, seedProject } from "../helpers/seed";
import { ClusterHostLab } from "../helpers/cluster-host-lab";
import { eventually } from "../helpers/scaling-lab";
import { scalingBackupStore } from "../helpers/scaling-backup-store";

vi.hoisted(() => {
  process.env.BETTER_AUTH_SECRET =
    "823159e33cd862ddceade630ead029d1c7f5e8f3d31c69d1648d71116865f4ab9";
  process.env.CLOUD_MODE = "false";
  process.env.DEPLOY_MODE = "docker";
  process.env.OPENSHIP_AUTH_MODE = "local";
  process.env.OPENSHIP_JOB_RUNNER = "in-process";
});
vi.mock("../../src/app", () => ({ app: { fetch: vi.fn() } }));

async function finalSnapshot<T extends { status: string }>(
  events: AsyncIterable<DeploymentEvent>,
  terminal: string[],
): Promise<T> {
  const seen = new Set<string>();
  for await (const event of events) {
    if (event.event === "error") throw new Error(event.data);
    if (event.event !== "snapshot") continue;
    const { run } = JSON.parse(event.data) as {
      run: T & {
        error?: string;
        progress?: { logs?: Array<{ timestamp: string; message: string }> };
        plan?: {
          hosts: Array<{ name: string; logs: Array<{ timestamp: string; message: string }> }>;
        };
      };
    };
    const logs = [
      ...(run.progress?.logs ?? []),
      ...(run.plan?.hosts.flatMap((host) =>
        host.logs.map((log) => ({ ...log, message: `${host.name}: ${log.message}` })),
      ) ?? []),
    ].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    for (const log of logs) {
      const key = `${log.timestamp}:${log.message}`;
      if (!seen.has(key)) {
        seen.add(key);
        console.info(`[stateful-e2e] ${log.message}`);
      }
    }
    if (terminal.includes(run.status)) {
      if (["failed", "interrupted"].includes(run.status))
        console.error(
          JSON.stringify(
            {
              error: run.error,
              progress: run.progress,
              hosts: run.plan?.hosts.map((host) => ({ name: host.name, logs: host.logs })),
            },
            null,
            2,
          ),
        );
      return run;
    }
  }
  throw new Error("The progress stream ended without a terminal snapshot.");
}

describeDockerE2E.sequential("stateful scaling through real Linux hosts", () => {
  const lab = new ClusterHostLab();
  let org: Awaited<ReturnType<typeof seedOrg>>;
  let client: OpenshipClient;
  let server: ServerType | undefined;
  let clusterId: string;
  let revision: number;
  let runtime: ClusterRuntime;
  let storage: ClusterStorage;
  let api: KubernetesApi | undefined;
  let store: Awaited<ReturnType<typeof scalingBackupStore>>;
  let destinationId: string;
  let project: Awaited<ReturnType<typeof seedProject>>;
  let application: KubernetesRuntime | undefined;
  let builder: DockerRuntime | undefined;
  let release: string;
  let savedBackup: string;

  async function volumeStatus(
    name: string,
    accepts: (volume: ClusterVolume) => boolean,
    timeout = 600_000,
  ) {
    for await (const event of client.projects.streamClusterVolumeEvents(project.id, {
      signal: AbortSignal.timeout(timeout),
    })) {
      if (event.event === "error") throw new Error(event.data);
      if (event.event !== "snapshot") continue;
      const { run } = JSON.parse(event.data) as { run: ClusterVolumeSnapshot };
      const volume = run.volumes.find((item) => item.name === name);
      if (volume && accepts(volume)) return volume;
    }
    throw new Error(`No accepted status for ${name}`);
  }
  const kubectl = (...args: string[]) =>
    lab.exec(0, ["/usr/local/bin/k3s", "kubectl", "--request-timeout=15s", ...args], 45);
  const appPods = () =>
    api!.request<{ items: KubernetesObject[] }>(
      "GET",
      `/api/v1/namespaces/${application!.namespace}/pods`,
    );

  beforeAll(async () => {
    await requireDocker();
    await lab.start();
    org = await seedOrg();
    const { encryptSecretField } = await import("@repo/platform/engine/lib/credential-encryption");
    store = await scalingBackupStore((options) => lab.container(options), lab.networkName);
    destinationId = randomUUID();
    await repos.backupDestination.create({
      id: destinationId,
      organizationId: org.organizationId,
      name: "Scaling archives",
      kind: "s3_compatible",
      endpoint: store.endpoint,
      bucket: store.bucket,
      region: "us-east-1",
      accessKeyIdEnc: encryptSecretField(store.accessKeyId),
      secretAccessKeyEnc: encryptSecretField(store.secretAccessKey),
    });
    for (const node of lab.nodes)
      await db
        .insert(schema.servers)
        .values({
          id: node.id,
          name: node.name,
          organizationId: org.organizationId,
          sshHost: "127.0.0.1",
          sshPort: node.sshPort,
          sshUser: "root",
          sshAuthMethod: "key",
          sshPrivateKey: encryptSecretField(lab.privateKey),
        });
    // A forwarded fixture SSH port is a remote host. Explicitly prevent the
    // convenience loopback detector from ever executing on the developer's OS.
    vi.doMock("@repo/platform/engine/lib/box-org", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@repo/platform/engine/lib/box-org")>()),
      isLocalHostRow: async (row: { id?: string }) => {
        if (!lab.nodes.some((node) => node.id === row.id))
          throw new Error("The host lab cannot execute outside its disposable servers.");
        return false;
      },
    }));
    vi.spyOn(k3sTools, "resolveVersion").mockResolvedValue("v1.36.4+k3s1");
    const network = await repos.serverCluster.create(
      org.organizationId,
      {
        name: lab.id,
        network: { mode: "native", cidrs: lab.networkCidrs, mtu: 1400, probePort: 51821 },
        members: lab.nodes.map((node) => ({
          serverId: node.id,
          privateIp: node.privateIp,
          providerId: "custom" as const,
        })),
      },
      randomUUID(),
      lab.id,
    );
    const cluster = await repos.computeCluster.create(
      org.organizationId,
      { name: lab.id, networkId: network.id, serverIds: lab.nodes.map((node) => node.id) },
      randomUUID(),
      lab.id,
    );
    clusterId = cluster.id;
    revision = cluster.revision;
    const { serverManagementRoutes } =
      await import("../../src/modules/system/server-management.routes");
    const { projectRoutes } = await import("../../src/modules/projects/project.routes");
    const { healthRoutes } = await import("../../src/modules/health/health.routes");
    const { permissionsRoutes } = await import("../../src/modules/permissions/permissions.routes");
    const { handleApiError } = await import("../../src/middleware/error-handler");
    const { clientIpMiddleware } = await import("../../src/middleware/client-ip");
    const { mintPatToken } = await import("@repo/platform/engine/lib/pat");
    const pat = mintPatToken();
    await repos.personalAccessToken.create({
      userId: org.userId,
      organizationId: org.organizationId,
      name: "Stateful scaling E2E",
      tokenPrefix: pat.tokenPrefix,
      tokenHash: pat.tokenHash,
      readOnly: false,
      scoped: false,
      expiresAt: null,
    });
    const app = new Hono()
      .onError(handleApiError)
      .use("*", clientIpMiddleware)
      .route("/api/health", healthRoutes)
      .route("/api/permissions", permissionsRoutes)
      .route("/api/system", serverManagementRoutes)
      .route("/api/projects", projectRoutes);
    const port = await new Promise<number>((resolve) => {
      server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (address) =>
        resolve(address.port),
      );
    });
    client = new OpenshipClient({
      baseUrl: `http://127.0.0.1:${port}`,
      token: pat.token,
      organizationId: org.organizationId,
    });
  }, 600_000);

  afterEach(async (context) => {
    console.info(`[stateful-e2e] ${context.task.result?.state}: ${context.task.name}`);
    if (context.task.result?.state === "fail") await lab.diagnostics();
  });
  afterAll(async () => {
    await application?.dispose();
    if (!application) await builder?.dispose();
    store?.client.destroy();
    await api?.dispose();
    const { stopNetworkSetups } =
      await import("@repo/platform/engine/modules/system/network-setup-lifecycle");
    await stopNetworkSetups();
    const { sshManager } = await import("@repo/platform/engine/lib/ssh-manager");
    for (const node of lab.nodes) await sshManager.invalidate(node.id);
    if (server && "closeAllConnections" in server) server.closeAllConnections();
    if (server)
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      );
    await lab.close();
    vi.restoreAllMocks();
  }, 300_000);

  it("enables scaling over SSH while preserving an existing Docker application", async () => {
    // A fresh host without Docker cannot reproduce #960. Use a real daemon on
    // one member, including its built-in host/none networks with no IPAM ranges.
    const { resolveServerExecutor } = await import("@repo/platform/engine/lib/deployment-runtime");
    const { executor } = await resolveServerExecutor(lab.nodes[0]!.id, org.organizationId);
    const docker = await installDocker(executor, (entry) =>
      console.info(`[stateful-e2e:docker] ${entry.message}`),
    );
    expect(docker.success, docker.error).toBe(true);
    // Occupy the range a clean cluster would choose to exercise conflict detection.
    const dockerSubnet = allocateClusterRuntimeRanges(lab.networkCidrs).podCidr;
    await lab.exec(0, [
      "docker",
      "network",
      "create",
      "--subnet",
      dockerSubnet,
      "existing-docker-app",
    ]);
    await lab.exec(
      0,
      [
        "docker",
        "run",
        "--detach",
        "--name",
        "existing-docker-app",
        "--network",
        "existing-docker-app",
        "--publish",
        "127.0.0.1:18080:8080",
        "busybox:1.37.0",
        "sh",
        "-ec",
        "mkdir /www\nprintf %s existing-docker-app > /www/index.html\nexec httpd -f -p 8080 -h /www",
      ],
      180,
    );
    const dockerReply = () =>
      lab.exec(0, [
        "curl",
        "--fail",
        "--silent",
        "--show-error",
        "--max-time",
        "5",
        "http://127.0.0.1:18080/",
      ]);
    await eventually(
      "the existing Docker application",
      dockerReply,
      (reply) => reply === "existing-docker-app",
      30_000,
    );

    const requestId = randomUUID();
    runtime = await client.servers.setupClusterRuntime({ clusterId, revision, requestId });
    const duplicate = await client.servers.setupClusterRuntime({ clusterId, revision, requestId });
    expect(duplicate.id).toBe(runtime.id);
    runtime = await finalSnapshot<ClusterRuntime>(
      client.servers.clusterRuntimeEvents(clusterId, { signal: AbortSignal.timeout(20 * 60_000) }),
      ["ready", "failed", "interrupted"],
    );
    expect(runtime.error).toBeNull();
    expect(runtime.status).toBe("ready");
    expect(runtime.plan.hosts.every((host) => host.ready && host.installed)).toBe(true);
    expect([runtime.plan.podCidr, runtime.plan.serviceCidr]).not.toContain(dockerSubnet);
    expect(await dockerReply()).toBe("existing-docker-app");
    const { openClusterApi } = await import("@repo/platform/engine/lib/cluster-deployment-target");
    api = (await openClusterApi(org.organizationId, clusterId, runtime.id)).api;
    expect((await api.request("GET", "/api/v1/namespaces/kube-system")).metadata.uid).toBe(
      runtime.plan.clusterUid,
    );
  }, 1_260_000);

  it("enables replicated shared files and validates writes across the servers", async () => {
    const requestId = randomUUID();
    const config = {
      replicas: 2,
      disks: lab.nodes.map((node) => ({
        serverId: node.id,
        path: "/var/lib/openship/storage",
        reservedGiB: 1,
      })),
      backupDestinationId: destinationId,
    };
    storage = await client.servers.setupClusterStorage({ clusterId, requestId, config });
    const duplicate = await client.servers.setupClusterStorage({ clusterId, requestId, config });
    expect(duplicate.id).toBe(storage.id);
    storage = await finalSnapshot<ClusterStorage>(
      client.servers.clusterStorageEvents(clusterId, { signal: AbortSignal.timeout(25 * 60_000) }),
      ["ready", "failed", "interrupted"],
    );
    expect(storage.error).toBeNull();
    expect(storage.status).toBe("ready");
    expect(storage.observation?.ready).toBe(true);
    expect(
      storage.progress.logs.some((log) => log.message.includes("written and read successfully")),
    ).toBe(true);
    const storageClass = await api!.request(
      "GET",
      "/apis/storage.k8s.io/v1/storageclasses/openship-replicated",
    );
    expect(storageClass.parameters.numberOfReplicas).toBe("2");
    expect(storageClass.reclaimPolicy).toBe("Retain");
  }, 1_560_000);

  it("attaches shared files to the application and reads writes from another server", async () => {
    project = await seedProject(org.organizationId, {
      name: "Shared files acceptance",
      slug: lab.id,
      framework: "docker",
      runtimeMode: "docker",
      workloadType: "web",
      hasServer: true,
      gitProvider: "release",
      releaseSource: {
        mode: "url",
        artifactKind: "image",
        imageTemplate: "busybox:{version}",
        pinnedVersion: "1.37.0",
      },
    });
    let target = await client.projects.getClusterWorkload(project.id);
    target = await client.projects.setClusterTarget(project.id, {
      clusterId,
      config: { replicas: 2 },
      expectedUpdatedAt: target.updatedAt,
      stateless: true,
    });
    const requestId = randomUUID();
    const first = await client.projects.createClusterVolume(project.id, {
      name: "uploads",
      sizeGiB: 1,
      requestId,
    });
    expect(
      (
        await client.projects.createClusterVolume(project.id, {
          name: "uploads",
          sizeGiB: 1,
          requestId,
        })
      ).name,
    ).toBe(first.name);
    await volumeStatus("uploads", (volume) => volume.phase === "Bound");
    target = await client.projects.setClusterTarget(project.id, {
      clusterId,
      config: { replicas: 2, mounts: [{ name: "uploads", mountPath: "/app/uploads" }] },
      expectedUpdatedAt: target.updatedAt,
      stateless: true,
    });
    builder = await DockerRuntime.create({ transport: "socket" });
    await builder.pullImage("busybox:1.37.0");
    const image = (await builder.docker.getImage("busybox:1.37.0").inspect()).RepoDigests![0];
    const { openClusterApi } = await import("@repo/platform/engine/lib/cluster-deployment-target");
    const transport = await openClusterApi(org.organizationId, clusterId, runtime.id);
    application = new KubernetesRuntime({
      api: transport.api,
      projectId: project.id,
      runtimeId: runtime.id,
      edgePrivateIp: runtime.plan.hosts[0].privateIp,
      servers: runtime.plan.hosts,
      config: target.config!,
      builder: async () => builder!,
      resolveRegistryAuth: async () => undefined,
    });
    const deployed = await application.deploy(
      {
        deploymentId: randomUUID(),
        projectId: project.id,
        buildSessionId: randomUUID(),
        imageRef: image,
        port: 3000,
        environment: "production",
        envVars: {},
        resources: { cpuCores: 0.1, memoryMb: 64, diskMb: 1024 },
        startCommand: "httpd -f -p 3000 -h /app/uploads",
      },
      (entry) => console.info(`[stateful-e2e:app] ${entry.message}`),
    );
    release = deployed.containerId!;
    // Exercise the default group permissions with a non-root application user.
    const deploymentName = release.split(":").at(-1)!;
    await patchKubernetesObject(
      api!,
      `/apis/apps/v1/namespaces/${application.namespace}/deployments/${deploymentName}`,
      () => ({ spec: { template: { spec: { securityContext: { runAsUser: 1001 } } } } }),
    );
    const pods = await eventually(
      "two application instances on distinct servers",
      appPods,
      ({ items }) =>
        items.length === 2 &&
        items.every(
          (pod) =>
            !pod.metadata.deletionTimestamp &&
            pod.spec.securityContext?.runAsUser === 1001 &&
            pod.status?.conditions?.some((c: any) => c.type === "Ready" && c.status === "True"),
        ),
      300_000,
    );
    expect(new Set(pods.items.map((pod) => pod.spec.nodeName)).size).toBe(2);
    await kubectl(
      "exec",
      "-n",
      application.namespace,
      pods.items[0].metadata.name!,
      "--",
      "sh",
      "-ec",
      "printf shared-file-survives > /app/uploads/acceptance.txt; sync",
    );
    expect(
      (
        await kubectl(
          "exec",
          "-n",
          application.namespace,
          pods.items[1].metadata.name!,
          "--",
          "cat",
          "/app/uploads/acceptance.txt",
        )
      ).trim(),
    ).toBe("shared-file-survives");
    await expect(
      client.projects.removeClusterVolume(project.id, {
        name: "uploads",
        resourceVersion: (await client.projects.listClusterVolumes(project.id))[0].resourceVersion,
        confirmName: "uploads",
        deleteData: true,
      }),
    ).rejects.toThrow(/Disconnect/);
  }, 600_000);

  it("saves a real file backup, grows the volume and rebuilds a lost disk copy", async () => {
    let volume = await volumeStatus(
      "uploads",
      (value) => value.state === "attached" && value.robustness === "healthy",
    );
    await client.projects.backupClusterVolume(project.id, {
      name: volume.name,
      requestId: randomUUID(),
    });
    volume = await volumeStatus("uploads", (value) =>
      value.backups.some((backup) => backup.state === "Completed"),
    );
    savedBackup = volume.backups.find((backup) => backup.state === "Completed")!.name;
    expect((await store.keys()).some((key) => key.includes(savedBackup))).toBe(true);
    await client.projects.scheduleClusterVolumeBackups(project.id, {
      name: volume.name,
      resourceVersion: volume.resourceVersion,
      schedule: { frequency: "daily", retain: 7 },
    });
    volume = (await client.projects.listClusterVolumes(project.id)).find(
      (value) => value.name === "uploads",
    )!;
    await client.projects.resizeClusterVolume(project.id, {
      name: volume.name,
      resourceVersion: volume.resourceVersion,
      sizeGiB: 2,
    });
    await eventually(
      "the actual expanded disk",
      () =>
        api!.request(
          "GET",
          `/apis/longhorn.io/v1beta2/namespaces/longhorn-system/volumes/${volume.volumeName}`,
        ),
      (disk) => Number(disk.spec.size) === 2 * 1024 ** 3 && disk.status?.robustness === "healthy",
      300_000,
    );
    await eventually(
      "the attached application's expanded filesystem",
      async () => {
        const pods = (await appPods()).items.filter((pod) => !pod.metadata.deletionTimestamp);
        const output = await kubectl(
          "exec",
          "-n",
          application!.namespace,
          pods[0].metadata.name!,
          "--",
          "df",
          // POSIX output keeps long NFS export names on the same line as
          // their capacity. Without -P the next line's second field is Used.
          "-Pk",
          "/app/uploads",
        );
        const row = output.trim().split("\n").at(-1)!.trim().split(/\s+/);
        const blocks = Number(row[1]);
        if (row.length !== 6 || !Number.isFinite(blocks) || blocks <= 0)
          throw new Error(`Unexpected filesystem capacity output: ${output.trim()}`);
        return blocks;
      },
      (blocks) => blocks > 1.5 * 1024 ** 2,
      300_000,
    );
    const replicas = await api!.request<{ items: KubernetesObject[] }>(
      "GET",
      `/apis/longhorn.io/v1beta2/namespaces/longhorn-system/replicas?labelSelector=${encodeURIComponent(`longhornvolume=${volume.volumeName}`)}`,
    );
    expect(replicas.items.length).toBe(2);
    const removed = replicas.items[0];
    await api!.request(
      "DELETE",
      `/apis/longhorn.io/v1beta2/namespaces/longhorn-system/replicas/${removed.metadata.name}`,
      { preconditions: { uid: removed.metadata.uid } },
    );
    volume = await volumeStatus(
      "uploads",
      (value) =>
        value.robustness === "healthy" &&
        value.copies.length === 2 &&
        value.copies.every((copy) => copy.name !== removed.metadata.name && copy.state === "ready"),
      900_000,
    );
    const pods = (await appPods()).items.filter((pod) => !pod.metadata.deletionTimestamp);
    expect(
      (
        await kubectl(
          "exec",
          "-n",
          application!.namespace,
          pods[0].metadata.name!,
          "--",
          "cat",
          "/app/uploads/acceptance.txt",
        )
      ).trim(),
    ).toBe("shared-file-survives");
  }, 1_260_000);

  it("restores files after deleting the source volume and keeps archives during storage removal", async () => {
    await application!.destroy(release);
    await eventually(
      "application mounts to detach",
      appPods,
      ({ items }) => items.length === 0,
      180_000,
    );
    const target = await client.projects.getClusterWorkload(project.id);
    await client.projects.setClusterTarget(project.id, {
      clusterId,
      config: { ...target.config!, mounts: [] },
      expectedUpdatedAt: target.updatedAt,
      stateless: true,
    });
    const volume = (await client.projects.listClusterVolumes(project.id)).find(
      (value) => value.name === "uploads",
    )!;
    await client.projects.removeClusterVolume(project.id, {
      name: "uploads",
      resourceVersion: volume.resourceVersion,
      confirmName: "uploads",
      deleteData: true,
    });
    expect(
      (await client.projects.listClusterVolumeBackups(project.id)).some(
        (backup) => backup.name === savedBackup,
      ),
    ).toBe(true);
    await client.projects.createClusterVolume(project.id, {
      name: "recovered",
      sizeGiB: 2,
      requestId: randomUUID(),
      restoreFrom: { volumeName: "uploads", backupName: savedBackup },
    });
    await volumeStatus("recovered", (value) => value.phase === "Bound");
    const { runClusterJob } = await import("../../../../packages/adapters/src/cluster/job");
    const jobName = "verify-recovered-files";
    await runClusterJob(
      api!,
      {
        apiVersion: "batch/v1",
        kind: "Job",
        metadata: {
          name: jobName,
          namespace: application!.namespace,
          labels: { "openship.io/runtime": runtime.id },
        },
        spec: {
          backoffLimit: 0,
          activeDeadlineSeconds: 300,
          template: {
            spec: {
              restartPolicy: "Never",
              automountServiceAccountToken: false,
              securityContext: { runAsUser: 1001, fsGroup: 1000 },
              containers: [
                {
                  name: "check",
                  image: "busybox:1.37.0",
                  command: [
                    "sh",
                    "-ec",
                    'test "$(cat /files/acceptance.txt)" = shared-file-survives',
                  ],
                  volumeMounts: [{ name: "files", mountPath: "/files" }],
                },
              ],
              volumes: [
                { name: "files", persistentVolumeClaim: { claimName: "shared-recovered" } },
              ],
            },
          },
        },
      },
      { signal: AbortSignal.timeout(330_000), fence: async () => {} },
    );
    const jobPath = `/apis/batch/v1/namespaces/${application!.namespace}/jobs/${jobName}`;
    const job = await api!.request("GET", jobPath);
    await api!.request("DELETE", jobPath, {
      propagationPolicy: "Foreground",
      preconditions: { uid: job.metadata.uid },
    });
    await eventually(
      "the restore check to release its volume",
      appPods,
      ({ items }) => items.length === 0,
      120_000,
    );
    const restored = (await client.projects.listClusterVolumes(project.id)).find(
      (value) => value.name === "recovered",
    )!;
    await client.projects.removeClusterVolume(project.id, {
      name: restored.name,
      resourceVersion: restored.resourceVersion,
      confirmName: restored.name,
      deleteData: true,
    });
    const current = await client.servers.getClusterStorage({ clusterId });
    await client.servers.removeClusterStorage({ clusterId, sequence: current!.sequence });
    storage = await finalSnapshot<ClusterStorage>(
      client.servers.clusterStorageEvents(clusterId, { signal: AbortSignal.timeout(12 * 60_000) }),
      ["removed", "failed", "interrupted"],
    );
    expect(storage.error).toBeNull();
    expect(storage.status).toBe("removed");
    expect((await store.keys()).some((key) => key.includes(savedBackup))).toBe(true);
  }, 1_200_000);
});
