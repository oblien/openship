/** Real database operators, data, backups and recovery. Only the location of a
 * prepared cluster is substituted; every application/database call is real. */
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { serve, type ServerType } from "@hono/node-server";
import { db, repos, schema } from "@repo/db";
import { OpenshipClient } from "@repo/sdk/client";
import {
  patchKubernetesObject,
  clusterDatabaseHosts,
  clusterDatabaseNamespace,
  kubernetesProjectNamespace,
  resolveDestination,
  type KubernetesObject,
} from "@repo/adapters";
import type { ClusterRuntimePlan, ClusterDatabaseConfig } from "@repo/core";
import type { ClusterDatabase } from "@repo/contracts";
import {
  DATABASE_IMAGES,
  postgresDatabaseImage,
} from "../../../../packages/adapters/src/cluster/database";
import { runClusterJob } from "../../../../packages/adapters/src/cluster/job";
import { ScalingLab, eventually } from "../helpers/scaling-lab";
import { scalingTaskImage } from "../helpers/scaling-task-image";
import { scalingBackupStore } from "../helpers/scaling-backup-store";
import { scalingSourceDatabase } from "../helpers/scaling-source-database";
import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";
import { seedOrg, seedProject } from "../helpers/seed";

vi.hoisted(() => {
  process.env.BETTER_AUTH_SECRET =
    "21903cffb5adfba83427848d2f63a2a809535980559664842d28fe9e68280fd9b";
  process.env.CLOUD_MODE = "false";
  process.env.DEPLOY_MODE = "docker";
  process.env.OPENSHIP_AUTH_MODE = "local";
  process.env.OPENSHIP_JOB_RUNNER = "in-process";
});
vi.mock("../../src/app", () => ({ app: { fetch: vi.fn() } }));

describeDockerE2E.sequential(
  "database scaling and recovery through API and native controllers",
  () => {
    const lab = new ScalingLab();
    let store: Awaited<ReturnType<typeof scalingBackupStore>>;
    let tasks: Awaited<ReturnType<typeof scalingTaskImage>>;
    let server: ServerType | undefined;
    let client: OpenshipClient;
    let org: Awaited<ReturnType<typeof seedOrg>>;
    let project: Awaited<ReturnType<typeof seedProject>>;
    let clusterId: string;
    let destinationId: string;
    let postgres: ClusterDatabase;
    let redis: ClusterDatabase;
    const paused = new Set<number>();
    const applicationSource = {
      gitProvider: "release",
      framework: "docker",
      runtimeMode: "docker",
      workloadType: "web",
      hasServer: true,
      releaseSource: {
        mode: "url" as const,
        artifactKind: "image" as const,
        imageTemplate: "busybox:{version}",
        pinnedVersion: "1.37.0",
      },
    };

    async function finish(
      database: ClusterDatabase,
      accepted: ClusterDatabase["status"][] = ["ready", "retained", "deleted"],
    ) {
      const seen = new Set<string>();
      for await (const event of client.projects.streamClusterDatabaseEvents(database.projectId, {
        signal: AbortSignal.timeout(35 * 60_000),
      })) {
        if (event.event === "error") throw new Error(event.data);
        if (event.event !== "snapshot") continue;
        const { run } = JSON.parse(event.data) as { run: ClusterDatabase[] };
        const current =
          run.find((row) => row.id === database.id) ??
          (database.intent === "remove"
            ? await client.projects.getClusterDatabase(database.projectId, {
                databaseId: database.id,
              })
            : null);
        if (
          !current ||
          current.sequence < database.sequence ||
          current.generation < database.generation
        )
          continue;
        for (const log of current.progress.logs) {
          const key = `${log.timestamp}:${log.message}`;
          if (!seen.has(key)) {
            seen.add(key);
            console.info(`[database-e2e:${current.name}] ${log.message}`);
          }
        }
        if (!["provisioning", "deleting"].includes(current.status)) {
          if (current.status === "failed") expect(current.error).toBeTruthy();
          else expect(current.error).toBeNull();
          expect(accepted, current.error ?? undefined).toContain(current.status);
          return current;
        }
      }
      throw new Error("The database progress stream ended before completion.");
    }
    const observe = (row: ClusterDatabase) =>
      client.projects.getClusterDatabase(row.projectId, { databaseId: row.id, observe: true });
    const config = (
      engine: ClusterDatabaseConfig["engine"],
      instances = 3,
    ): ClusterDatabaseConfig => ({
      engine,
      mode: instances === 1 ? "standalone" : "cluster",
      instances,
      storageGiB: 1,
      storageClass: "openship-local",
      cpuMillis: 250,
      memoryMiB: 384,
      databaseName: "app",
      backup: { destinationId, schedule: "manual", retentionDays: 7 },
    });
    async function create(
      name: string,
      settings: ClusterDatabaseConfig,
      restoreFrom?: { databaseId: string; backupName: string },
    ) {
      const input = {
        requestId: randomUUID(),
        name,
        config: settings,
        ...(settings.engine === "redis" && settings.mode === "cluster"
          ? { clusterAwareClient: true as const }
          : {}),
        ...(restoreFrom ? { restoreFrom } : {}),
      };
      const created = await client.projects.createClusterDatabase(project.id, input);
      expect((await client.projects.createClusterDatabase(project.id, input)).id).toBe(created.id);
      return finish(created);
    }
    async function remove(row: ClusterDatabase, deleteData: boolean) {
      const current = await observe(row);
      return finish(
        await client.projects.removeClusterDatabase(row.projectId, {
          databaseId: row.id,
          expectedSequence: current.sequence,
          name: row.name,
          deleteData,
        }),
      );
    }
    async function query(
      row: ClusterDatabase,
      command: string,
      target: "write" | "read" = "write",
    ) {
      const namespace = kubernetesProjectNamespace(row.projectId);
      const name = `data-check-${randomUUID().slice(0, 8)}`;
      const password = await lab.api.request(
        "GET",
        `/api/v1/namespaces/${clusterDatabaseNamespace(row.id)}/secrets/credentials`,
      );
      const labels = {
        "openship.io/runtime": lab.runtimeId,
        "openship.io/database": row.id,
        "openship.io/database-probe": "true",
      };
      const secret = await lab.api.request("POST", `/api/v1/namespaces/${namespace}/secrets`, {
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name, namespace, labels },
        data: { password: password.data.password },
      });
      const hosts = clusterDatabaseHosts(row.id, row.config);
      const host = target === "read" ? hosts.readOnlyHost : hosts.internalHost;
      if (!host) throw new Error("This database has no reader endpoint.");
      const credential = { secretKeyRef: { name, key: "password" } };
      const env =
        row.config.engine === "postgres"
          ? [
              { name: "PGPASSWORD", valueFrom: credential },
              { name: "PGHOST", value: host },
              { name: "PGUSER", value: "app" },
              { name: "PGDATABASE", value: "app" },
              { name: "PGSSLMODE", value: "require" },
              { name: "PGCONNECT_TIMEOUT", value: "5" },
            ]
          : [
              { name: "REDISCLI_AUTH", valueFrom: credential },
              { name: "REDIS_HOST", value: host },
            ];
      // A new pod can start before its network-policy membership has reached
      // every node. Establish an authenticated connection from this same pod
      // before running the data command once; never retry a write or import.
      const ready =
        row.config.engine === "postgres"
          ? `test "$(psql -X -A -t -v ON_ERROR_STOP=1 -c 'SELECT 1')" = 1`
          : 'test "$(timeout 5 redis-cli -h "$REDIS_HOST" --raw PING)" = PONG';
      const waitForConnection = `
attempt=0
while ! (${ready}) > /tmp/openship-connection.log 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo 'The authenticated database connection did not become ready from this pod.' >&2
    cat /tmp/openship-connection.log >&2
    exit 1
  fi
  sleep 1
done
`;
      const jobPath = `/apis/batch/v1/namespaces/${namespace}/jobs/${name}`;
      try {
        const result = await runClusterJob(
          lab.api,
          {
            apiVersion: "batch/v1",
            kind: "Job",
            metadata: { name, namespace, labels },
            spec: {
              backoffLimit: 0,
              activeDeadlineSeconds: 240,
              template: {
                metadata: { labels },
                spec: {
                  automountServiceAccountToken: false,
                  restartPolicy: "Never",
                  nodeSelector: { "openship.io/runtime": lab.runtimeId },
                  containers: [
                    {
                      name: "data",
                      image:
                        row.config.engine === "postgres"
                          ? postgresDatabaseImage(row.config)
                          : DATABASE_IMAGES.redis,
                      command: ["sh", "-ec", waitForConnection + command],
                      env,
                      resources: {
                        requests: { cpu: "50m", memory: "64Mi" },
                        limits: { memory: "128Mi" },
                      },
                    },
                  ],
                },
              },
            },
          },
          { signal: AbortSignal.timeout(270000), fence: async () => {} },
        );
        return result.output.trim();
      } finally {
        const current = await lab.api.request("GET", jobPath).catch(() => null);
        if (current)
          await lab.api.request("DELETE", jobPath, {
            propagationPolicy: "Foreground",
            preconditions: { uid: current.metadata.uid },
          });
        await lab.api.request("DELETE", `/api/v1/namespaces/${namespace}/secrets/${name}`, {
          preconditions: { uid: secret.metadata.uid },
        });
      }
    }
    async function pauseNode(name: string) {
      const index = lab.nodes.findIndex((node) => node.name === name);
      expect(index).toBeGreaterThan(0);
      await lab.nodes[index].container.pause();
      paused.add(index);
      return index;
    }
    async function resume(index: number) {
      await lab.nodes[index].container.unpause();
      paused.delete(index);
    }

    beforeAll(async () => {
      await requireDocker();
      await lab.start(9, { edge: false });
      // Keep the sole disposable API node available during data-node outages.
      await patchKubernetesObject(lab.api, `/api/v1/nodes/${lab.nodes[0].name}`, () => ({
        spec: { unschedulable: true },
      }));
      tasks = await scalingTaskImage(lab);
      vi.stubEnv("OPENSHIP_CLUSTER_TASKS_IMAGE", tasks.image);
      store = await scalingBackupStore((options) => lab.container(options), lab.id);
      org = await seedOrg();
      const { encryptSecretField } =
        await import("@repo/platform/engine/lib/credential-encryption");
      destinationId = randomUUID();
      await repos.backupDestination.create({
        id: destinationId,
        organizationId: org.organizationId,
        name: "Database recovery",
        kind: "s3_compatible",
        endpoint: store.endpoint,
        bucket: store.bucket,
        region: "us-east-1",
        accessKeyIdEnc: encryptSecretField(store.accessKeyId),
        secretAccessKeyEnc: encryptSecretField(store.secretAccessKey),
      });
      const hosts: ClusterRuntimePlan["hosts"] = [];
      for (const [index, node] of lab.nodes.entries()) {
        const serverId = randomUUID();
        await db.insert(schema.servers).values({
          id: serverId,
          name: node.name,
          organizationId: org.organizationId,
          sshHost: node.privateIp,
        });
        hosts.push({
          serverId,
          name: node.name,
          address: node.privateIp,
          privateIp: node.privateIp,
          nodeName: node.name,
          role: index === 0 ? "server" : "agent",
          hostIdentity: null,
          interfaceName: "eth0",
          installed: true,
          ready: true,
          steps: [],
          logs: [],
        });
      }
      const network = await repos.serverCluster.create(
        org.organizationId,
        {
          name: lab.id,
          network: { mode: "native", cidrs: lab.networkCidrs, mtu: 1400, probePort: 51821 },
          members: hosts.map((host) => ({
            serverId: host.serverId,
            privateIp: host.privateIp,
            providerId: "custom" as const,
          })),
        },
        randomUUID(),
        lab.id,
      );
      const cluster = await repos.computeCluster.create(
        org.organizationId,
        { name: lab.id, networkId: network.id, serverIds: hosts.map((host) => host.serverId) },
        randomUUID(),
        lab.id,
      );
      clusterId = cluster.id;
      const plan: ClusterRuntimePlan = {
        networkId: network.id,
        networkRevision: network.revision,
        version: (await lab.api.request("GET", "/version")).gitVersion,
        podCidr: lab.podCidr,
        serviceCidr: lab.serviceCidr,
        clusterUid: (await lab.api.request("GET", "/api/v1/namespaces/kube-system")).metadata.uid,
        hosts,
      };
      await db.insert(schema.clusterRuntime).values({
        id: lab.runtimeId,
        organizationId: org.organizationId,
        clusterId,
        clusterRevision: cluster.revision,
        requestId: randomUUID(),
        status: "ready",
        verifiedAt: new Date(),
        plan,
      });
      vi.doMock("@repo/platform/engine/lib/cluster-deployment-target", async (importOriginal) => {
        const actual =
          await importOriginal<
            typeof import("@repo/platform/engine/lib/cluster-deployment-target")
          >();
        return {
          ...actual,
          openClusterApi: async (
            organizationId: string,
            requestedClusterId: string,
            runtimeId?: string,
          ) => {
            expect(organizationId).toBe(org.organizationId);
            expect(requestedClusterId).toBe(clusterId);
            const current = await actual.requireClusterDeploymentTarget(
              organizationId,
              requestedClusterId,
              runtimeId,
            );
            return {
              api: lab.openApi(),
              runtime: current.runtime,
              gateway: hosts[0],
              edgeSourceIps: [],
              target: { id: hosts[0].serverId, isLocal: false },
            };
          },
        };
      });
      const { projectRoutes } = await import("../../src/modules/projects/project.routes");
      const { healthRoutes } = await import("../../src/modules/health/health.routes");
      const { permissionsRoutes } =
        await import("../../src/modules/permissions/permissions.routes");
      const { handleApiError } = await import("../../src/middleware/error-handler");
      const { clientIpMiddleware } = await import("../../src/middleware/client-ip");
      const { mintPatToken } = await import("@repo/platform/engine/lib/pat");
      const pat = mintPatToken();
      await repos.personalAccessToken.create({
        userId: org.userId,
        organizationId: org.organizationId,
        name: "Database scaling E2E",
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
        .route("/api/projects", projectRoutes);
      const port = await new Promise<number>((resolve) => {
        server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (address) =>
          resolve(address.port),
        );
      });
      client = new OpenshipClient({
        baseUrl: `http://127.0.0.1:${port}`,
        organizationId: org.organizationId,
        token: pat.token,
      });
      project = await seedProject(org.organizationId, {
        name: "Stateful application",
        ...applicationSource,
      });
      const before = await client.projects.getClusterWorkload(project.id);
      await client.projects.setClusterTarget(project.id, {
        clusterId,
        expectedUpdatedAt: before.updatedAt,
        stateless: true,
        config: { replicas: 2 },
      });
    }, 1500000);

    afterEach(async (context) => {
      console.info(`[database-e2e] ${context.task.result?.state}: ${context.task.name}`);
      if (context.task.result?.state === "fail") console.error(await lab.diagnostics());
    });
    afterAll(async () => {
      for (const index of paused) await resume(index).catch(() => {});
      const { stopNetworkSetups } =
        await import("@repo/platform/engine/modules/system/network-setup-lifecycle");
      await stopNetworkSetups();
      if (server && "closeAllConnections" in server) server.closeAllConnections();
      if (server)
        await new Promise<void>((resolve, reject) =>
          server!.close((error) => (error ? reject(error) : resolve())),
        );
      store?.client.destroy();
      try {
        await tasks?.dispose();
      } finally {
        await lab.close();
      }
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }, 300000);

    it("creates PostgreSQL, connects the application and keeps committed data through growth and a server outage", async () => {
      postgres = await create("orders", config("postgres"));
      postgres = await client.projects.connectClusterDatabase(project.id, {
        databaseId: postgres.id,
        expectedSequence: postgres.sequence,
        envKey: "DATABASE_URL",
      });
      expect(postgres.envKey).toBe("DATABASE_URL");
      await query(
        postgres,
        "psql -X -v ON_ERROR_STOP=1 -c \"CREATE TABLE acceptance (id integer PRIMARY KEY, value text NOT NULL); INSERT INTO acceptance VALUES (1, 'committed-order');\"",
      );
      postgres = await finish(
        await client.projects.updateClusterDatabase(project.id, {
          databaseId: postgres.id,
          expectedSequence: postgres.sequence,
          config: { ...postgres.config, instances: 4 },
        }),
      );
      const primary = postgres.observation!.pods.find(
        (pod) => pod.name === postgres.observation!.primary,
      )!;
      const index = await pauseNode(primary.nodeName!);
      try {
        postgres = await eventually(
          "PostgreSQL to promote a surviving replica",
          () => observe(postgres),
          (row) => !!row.observation?.primary && row.observation.primary !== primary.name,
          360000,
        );
        expect(
          await query(
            postgres,
            "psql -X -A -t -v ON_ERROR_STOP=1 -c 'SELECT value FROM acceptance WHERE id = 1'",
          ),
        ).toBe("committed-order");
      } finally {
        await resume(index);
      }
      postgres = await eventually(
        "all PostgreSQL instances to recover",
        () => observe(postgres),
        (row) => !!row.observation?.ready,
        600000,
      );
    }, 1800000);

    it("enables PostgreSQL read replicas in place and keeps writer and reader bindings distinct", async () => {
      let row = await create("quick-scale-postgres", config("postgres", 1));
      const id = row.id;
      const writeHost = clusterDatabaseHosts(row.id, row.config).internalHost;
      await query(
        row,
        "psql -X -v ON_ERROR_STOP=1 -c \"CREATE TABLE quick_scale (id integer PRIMARY KEY, value text NOT NULL); INSERT INTO quick_scale VALUES (1, 'before-replication');\"",
      );
      row = await finish(
        await client.projects.updateClusterDatabase(project.id, {
          databaseId: row.id,
          expectedSequence: row.sequence,
          config: { ...row.config, mode: "cluster", instances: 3 },
        }),
      );
      expect(row.id).toBe(id);
      expect(clusterDatabaseHosts(row.id, row.config).internalHost).toBe(writeHost);
      expect(
        await query(
          row,
          "psql -X -A -t -v ON_ERROR_STOP=1 -c 'SELECT pg_is_in_recovery()'",
          "read",
        ),
      ).toBe("t");
      expect(
        await query(
          row,
          "psql -X -A -t -v ON_ERROR_STOP=1 -c 'SELECT value FROM quick_scale WHERE id=1'",
          "read",
        ),
      ).toBe("before-replication");
      row = await client.projects.connectClusterDatabase(project.id, {
        databaseId: row.id,
        expectedSequence: row.sequence,
        envKey: "QUICK_SCALE_DATABASE_URL",
        readEnvKey: "QUICK_SCALE_DATABASE_READ_URL",
      });
      expect(row.envKey).toBe("QUICK_SCALE_DATABASE_URL");
      expect(row.readEnvKey).toBe("QUICK_SCALE_DATABASE_READ_URL");
      await expect(
        client.projects.updateClusterDatabase(project.id, {
          databaseId: row.id,
          expectedSequence: row.sequence,
          config: { ...row.config, mode: "standalone", instances: 1 },
        }),
      ).rejects.toThrow();
      row = await client.projects.connectClusterDatabase(project.id, {
        databaseId: row.id,
        expectedSequence: row.sequence,
        envKey: null,
        readEnvKey: null,
      });
      row = await finish(
        await client.projects.updateClusterDatabase(project.id, {
          databaseId: row.id,
          expectedSequence: row.sequence,
          config: { ...row.config, mode: "standalone", instances: 1 },
        }),
      );
      expect(row.id).toBe(id);
      expect(
        await query(
          row,
          "psql -X -A -t -v ON_ERROR_STOP=1 -c 'SELECT value FROM quick_scale WHERE id=1'",
        ),
      ).toBe("before-replication");
      await remove(row, true);
    }, 1800000);

    it("upgrades a PostgreSQL copy, verifies its data and switches the saved connection only after review", async () => {
      postgres = await observe(postgres);
      const input = {
        requestId: randomUUID(),
        name: "orders-upgraded",
        config: { ...config("postgres", 1), version: "18" as const },
        copyFrom: { databaseId: postgres.id, expectedSequence: postgres.sequence },
      };
      const pending = await client.projects.createClusterDatabase(project.id, input);
      expect((await client.projects.createClusterDatabase(project.id, input)).id).toBe(pending.id);
      let copy = await finish(pending);
      expect(copy.envKey).toBeNull();
      // Observing saves a new revision. Keep the reviewed snapshot for the
      // explicit switch below instead of sending its now-stale predecessor.
      postgres = await observe(postgres);
      expect(postgres.envKey).toBe("DATABASE_URL");
      expect(
        await query(
          copy,
          "psql -X -A -t -v ON_ERROR_STOP=1 -c 'SELECT value FROM acceptance WHERE id = 1'",
        ),
      ).toBe("committed-order");
      expect(
        Number(await query(copy, "psql -X -A -t -v ON_ERROR_STOP=1 -c 'SHOW server_version_num'")),
      ).toBeGreaterThanOrEqual(180000);
      expect(
        Number(
          await query(postgres, "psql -X -A -t -v ON_ERROR_STOP=1 -c 'SHOW server_version_num'"),
        ),
      ).toBeLessThan(180000);
      const connection = {
        databaseId: copy.id,
        expectedSequence: copy.sequence,
        envKey: "DATABASE_URL",
      };
      await expect(
        client.projects.connectClusterDatabase(project.id, connection),
      ).rejects.toMatchObject({ code: "CLUSTER_DATABASE_CONFLICT" });
      copy = await client.projects.connectClusterDatabase(project.id, {
        ...connection,
        replace: { databaseId: postgres.id, expectedSequence: postgres.sequence },
      });
      postgres = await observe(postgres);
      expect(postgres.envKey).toBeNull();
      expect(copy.envKey).toBe("DATABASE_URL");
      expect(
        await query(
          postgres,
          "psql -X -A -t -v ON_ERROR_STOP=1 -c 'SELECT value FROM acceptance WHERE id = 1'",
        ),
      ).toBe("committed-order");
      // Reversing the connection is explicit as well; it does not remove either database.
      postgres = await client.projects.connectClusterDatabase(project.id, {
        databaseId: postgres.id,
        expectedSequence: postgres.sequence,
        envKey: "DATABASE_URL",
        replace: { databaseId: copy.id, expectedSequence: copy.sequence },
      });
      expect((await remove(copy, true)).status).toBe("deleted");
    }, 1800000);

    it("restores a verified PostgreSQL archive and checks retained-data and permanent-removal paths", async () => {
      postgres = await finish(
        await client.projects.backupClusterDatabase(project.id, {
          databaseId: postgres.id,
          expectedSequence: postgres.sequence,
        }),
      );
      const backup = postgres.observation!.backups!.find((item) => item.phase === "completed")!;
      let restored = await create("orders-recovered", config("postgres", 1), {
        databaseId: postgres.id,
        backupName: backup.name,
      });
      expect(
        await query(
          restored,
          "psql -X -A -t -v ON_ERROR_STOP=1 -c 'SELECT value FROM acceptance WHERE id = 1'",
        ),
      ).toBe("committed-order");
      restored = await remove(restored, false);
      expect(restored.status).toBe("retained");
      expect(restored.observation!.volumes.length).toBeGreaterThan(0);
      expect((await remove(restored, true)).status).toBe("deleted");
      postgres = await client.projects.connectClusterDatabase(project.id, {
        databaseId: postgres.id,
        expectedSequence: postgres.sequence,
        envKey: null,
      });
      expect((await remove(postgres, true)).status).toBe("deleted");
      expect((await store.keys()).length).toBeGreaterThan(0);
    }, 1800000);

    it("replicates Redis without sharding, preserves numbered databases and fails over through Sentinel", async () => {
      let original = await create("sessions-original", config("redis", 1));
      await query(
        original,
        'redis-cli --raw -h "$REDIS_HOST" -n 1 SET session:accepted original-value; redis-cli --raw -h "$REDIS_HOST" SET session:main main-value',
      );
      // Redis uses different operator resources for standalone and replication.
      // Conversion must preserve the original and use a verified copy.
      await expect(
        client.projects.updateClusterDatabase(project.id, {
          databaseId: original.id,
          expectedSequence: original.sequence,
          config: { ...original.config, mode: "replication", instances: 3 },
        }),
      ).rejects.toMatchObject({ code: "CLUSTER_DATABASE_IMMUTABLE" });
      original = await finish(
        await client.projects.backupClusterDatabase(project.id, {
          databaseId: original.id,
          expectedSequence: original.sequence,
        }),
      );
      const firstBackup = original.observation!.backups!.find(
        (item) => item.phase === "completed",
      )!;
      let replicated = await create(
        "sessions-replicated",
        { ...config("redis"), mode: "replication" },
        {
          databaseId: original.id,
          backupName: firstBackup.name,
        },
      );
      expect(replicated.observation?.pods.filter((pod) => pod.role === "primary")).toHaveLength(1);
      expect(replicated.observation?.pods.filter((pod) => pod.role === "replica")).toHaveLength(2);
      expect(replicated.observation?.pods.filter((pod) => pod.role === "sentinel")).toHaveLength(3);
      expect(
        await query(replicated, 'redis-cli --raw -h "$REDIS_HOST" -n 1 GET session:accepted'),
      ).toBe("original-value");
      expect(
        await query(
          replicated,
          'redis-cli --raw -h "$REDIS_HOST" -n 1 GET session:accepted',
          "read",
        ),
      ).toBe("original-value");
      expect(
        await query(replicated, 'redis-cli --raw -h "$REDIS_HOST" SET forbidden:reader 1', "read"),
      ).toContain("READONLY");
      expect(
        await query(
          replicated,
          'printf "SELECT 1\\nSET session:after-recovery new-live-value\\nWAIT 2 10000\\n" | redis-cli --raw -h "$REDIS_HOST"',
        ),
      ).toBe("OK\nOK\n2");
      expect((await remove(original, true)).status).toBe("deleted");
      replicated = await finish(
        await client.projects.updateClusterDatabase(project.id, {
          databaseId: replicated.id,
          expectedSequence: replicated.sequence,
          config: { ...replicated.config, instances: 4 },
        }),
      );
      expect(replicated.observation?.pods.filter((pod) => pod.role === "replica")).toHaveLength(3);
      expect(
        await query(replicated, 'redis-cli --raw -h "$REDIS_HOST" -n 1 GET session:accepted'),
      ).toBe("original-value");
      expect(
        await query(replicated, 'redis-cli --raw -h "$REDIS_HOST" -n 1 GET session:after-recovery'),
      ).toBe("new-live-value");
      await expect(
        client.projects.updateClusterDatabase(project.id, {
          databaseId: replicated.id,
          expectedSequence: replicated.sequence,
          config: { ...replicated.config, instances: 3 },
        }),
      ).rejects.toMatchObject({ code: "CLUSTER_DATABASE_IMMUTABLE" });
      const primary = replicated.observation!.pods.find(
        (pod) => pod.name === replicated.observation!.primary,
      )!;
      const index = await pauseNode(primary.nodeName!);
      try {
        replicated = await eventually(
          "Redis Sentinel to elect a surviving primary",
          () => observe(replicated),
          (row) => !!row.observation?.primary && row.observation.primary !== primary.name,
          360000,
        );
        expect(
          await query(replicated, 'redis-cli --raw -h "$REDIS_HOST" -n 1 GET session:accepted'),
        ).toBe("original-value");
        expect(
          await query(
            replicated,
            'redis-cli --raw -h "$REDIS_HOST" -n 1 GET session:after-recovery',
          ),
        ).toBe("new-live-value");
        expect(
          await query(
            replicated,
            'test "$(redis-cli --raw -h "$REDIS_HOST" SET session:after-failover survived)" = OK; test "$(redis-cli --raw -h "$REDIS_HOST" WAIT 1 10000)" -ge 1; redis-cli --raw -h "$REDIS_HOST" GET session:after-failover',
          ),
        ).toBe("survived");
      } finally {
        await resume(index);
      }
      replicated = await eventually(
        "all Redis replication members and Sentinel voters to recover",
        () => observe(replicated),
        (row) => !!row.observation?.ready,
        600000,
      );
      replicated = await finish(
        await client.projects.backupClusterDatabase(project.id, {
          databaseId: replicated.id,
          expectedSequence: replicated.sequence,
        }),
      );
      const replicatedBackup = replicated.observation!.backups!.find(
        (item) => item.phase === "completed",
      )!;
      const recovered = await create("sessions-recovered", config("redis", 1), {
        databaseId: replicated.id,
        backupName: replicatedBackup.name,
      });
      expect(
        await query(recovered, 'redis-cli --raw -h "$REDIS_HOST" -n 1 GET session:accepted'),
      ).toBe("original-value");
      expect(
        await query(recovered, 'redis-cli --raw -h "$REDIS_HOST" -n 1 GET session:after-recovery'),
      ).toBe("new-live-value");
      expect(
        await query(recovered, 'redis-cli --raw -h "$REDIS_HOST" GET session:after-failover'),
      ).toBe("survived");
      expect((await remove(recovered, true)).status).toBe("deleted");
      expect((await remove(replicated, false)).status).toBe("retained");
      expect((await remove(replicated, true)).status).toBe("deleted");
    }, 2400000);

    it("scales Redis data partitions in both directions without losing keys, then recovers a failed primary", async () => {
      redis = await create("cache", config("redis"));
      await query(
        redis,
        'i=0; while [ "$i" -lt 128 ]; do redis-cli -c -h "$REDIS_HOST" SET "acceptance:$i" "value:$i" >/dev/null; i=$((i+1)); done; redis-cli -c -h "$REDIS_HOST" SET acceptance:expires expiring PX 86400000',
      );
      for (const instances of [4, 3]) {
        const dataPodsPath = `/api/v1/namespaces/${clusterDatabaseNamespace(redis.id)}/pods?labelSelector=${encodeURIComponent(`openship.io/database=${redis.id},redis_setup_type=cluster`)}`;
        const before = await lab.api.request<{ items: KubernetesObject[] }>("GET", dataPodsPath);
        redis = await finish(
          await client.projects.updateClusterDatabase(project.id, {
            databaseId: redis.id,
            expectedSequence: redis.sequence,
            config: { ...redis.config, instances },
            confirmRedisRebalance: true,
          }),
        );
        const after = await lab.api.request<{ items: KubernetesObject[] }>("GET", dataPodsPath);
        const remaining = after.items.filter((pod) => !pod.metadata.deletionTimestamp);
        expect(remaining).toHaveLength(instances * 2);
        // Changing the partition count must retain the existing data instances.
        // A management annotation must not trigger parallel leader/follower
        // rollouts while the operator is moving slots between servers.
        for (const pod of before.items) {
          const ordinal = Number(pod.metadata.name!.split("-").at(-1));
          if (ordinal < instances)
            expect(
              remaining.find((current) => current.metadata.name === pod.metadata.name)?.metadata
                .uid,
            ).toBe(pod.metadata.uid);
        }
        expect(
          await query(
            redis,
            'i=0; while [ "$i" -lt 128 ]; do test "$(redis-cli -c -h "$REDIS_HOST" --raw GET "acceptance:$i")" = "value:$i"; i=$((i+1)); done; echo all-data-present',
          ),
        ).toBe("all-data-present");
      }
      const output = await query(
        redis,
        'redis-cli -h "$REDIS_HOST" --raw CLUSTER KEYSLOT acceptance:0; redis-cli -h "$REDIS_HOST" --json CLUSTER SLOTS',
      );
      const [slotText, ...json] = output.split("\n");
      const slot = Number(slotText),
        slots = JSON.parse(json.join("\n")) as Array<
          [number, number, [string, number, string], ...unknown[]]
        >;
      const address = slots.find(([start, end]) => slot >= start && slot <= end)![2][0];
      const pods = await lab.api.request<{ items: KubernetesObject[] }>(
        "GET",
        `/api/v1/namespaces/${clusterDatabaseNamespace(redis.id)}/pods`,
      );
      const primary = pods.items.find((pod) => pod.status?.podIP === address)!;
      const index = await pauseNode(primary.spec.nodeName);
      try {
        expect(
          await query(
            redis,
            'i=0; while [ "$i" -lt 90 ]; do if [ "$(timeout 3 redis-cli -c -h "$REDIS_HOST" --raw GET acceptance:0 2>/dev/null)" = value:0 ]; then echo replicated-key-recovered; exit 0; fi; i=$((i+1)); sleep 2; done; exit 1',
          ),
        ).toBe("replicated-key-recovered");
      } finally {
        await resume(index);
      }
      redis = await eventually(
        "Redis cluster recovery",
        () => observe(redis),
        (row) => !!row.observation?.ready,
        600000,
      );
    }, 2400000);

    it("restores Redis values and expiry from real object storage into a separate database", async () => {
      redis = await finish(
        await client.projects.backupClusterDatabase(project.id, {
          databaseId: redis.id,
          expectedSequence: redis.sequence,
        }),
      );
      const backup = redis.observation!.backups!.find((item) => item.phase === "completed")!;
      expect((await store.keys()).some((key) => key.endsWith("manifest.json"))).toBe(true);
      const restored = await create("cache-recovered", config("redis", 1), {
        databaseId: redis.id,
        backupName: backup.name,
      });
      expect(
        await query(
          restored,
          'test "$(redis-cli -h "$REDIS_HOST" --raw GET acceptance:0)" = value:0; ttl=$(redis-cli -h "$REDIS_HOST" --raw PTTL acceptance:expires); test "$ttl" -gt 0; test "$ttl" -lt 86400000; echo archive-recovered',
        ),
      ).toBe("archive-recovered");
      expect((await remove(restored, true)).status).toBe("deleted");
      expect((await remove(redis, true)).status).toBe("deleted");
      expect((await store.keys()).some((key) => key.endsWith("manifest.json"))).toBe(true);
    }, 1800000);

    it.each(["postgres", "redis"] as const)(
      "imports an existing Docker %s backup before moving its application",
      async (engine) => {
        const legacy = await seedProject(org.organizationId, {
          name: `Existing ${engine} application`,
          ...applicationSource,
        });
        const source = await scalingSourceDatabase(lab, engine, legacy);
        try {
          const runId = randomUUID();
          const destination = (await repos.backupDestination.findById(destinationId))!;
          const artifacts = await source.capture(
            resolveDestination({
              ...destination,
              kind: "s3_compatible",
              endpoint: store.localEndpoint,
            }),
            runId,
          );
          await repos.backupRun.create({
            id: runId,
            organizationId: org.organizationId,
            projectId: legacy.id,
            sourceKind: "service",
            destinationId,
            status: "succeeded",
            triggeredBy: "manual",
            finishedAt: new Date(),
            artifacts,
          });
          expect(await client.projects.listClusterDatabaseImports(legacy.id)).toMatchObject([
            { runId, artifactName: artifacts[0].name, engine },
          ]);
          const input = {
            requestId: randomUUID(),
            name: "imported",
            clusterId,
            config: config(engine, 1),
            importFrom: { runId, artifactName: artifacts[0].name },
          };
          const pending = await client.projects.createClusterDatabase(legacy.id, input);
          expect((await client.projects.createClusterDatabase(legacy.id, input)).id).toBe(
            pending.id,
          );
          let imported = await finish(pending);
          expect((await client.projects.getClusterWorkload(legacy.id)).clusterId).toBeNull();
          expect(await source.read()).toBe(`legacy-${engine}`);
          expect(await repos.clusterDatabase.hasActiveImport(runId)).toBe(false);
          expect(
            await query(
              imported,
              engine === "postgres"
                ? "psql -X -A -t -v ON_ERROR_STOP=1 -c 'SELECT value FROM acceptance WHERE id = 1'"
                : 'test "$(redis-cli -h "$REDIS_HOST" --raw GET acceptance:imported)" = legacy-redis; test "$(redis-cli -h "$REDIS_HOST" -n 1 --raw GET acceptance:numbered)" = separate-database; ttl=$(redis-cli -h "$REDIS_HOST" --raw PTTL acceptance:expires); test "$ttl" -gt 0; test "$ttl" -lt 86400000; echo legacy-redis',
            ),
          ).toBe(`legacy-${engine}`);
          // The destination is ready before choosing where the app runs. Moving the
          // app is still the separate reviewed deployment flow tested by the app suite.
          const current = await client.projects.getClusterWorkload(legacy.id);
          await client.projects.setClusterTarget(legacy.id, {
            clusterId,
            expectedUpdatedAt: current.updatedAt,
            stateless: true,
            config: { replicas: 2 },
          });
          imported = await client.projects.connectClusterDatabase(legacy.id, {
            databaseId: imported.id,
            expectedSequence: imported.sequence,
            envKey: engine === "postgres" ? "DATABASE_URL" : "REDIS_URL",
          });
          expect(imported.envKey).toBeTruthy();
          expect(await source.read()).toBe(`legacy-${engine}`);
          imported = await client.projects.connectClusterDatabase(legacy.id, {
            databaseId: imported.id,
            expectedSequence: imported.sequence,
            envKey: null,
          });
          expect((await remove(imported, true)).status).toBe("deleted");

          if (engine === "postgres") {
            // The stored bytes are real. Altering their recorded identity must fail
            // verification before the first table is loaded into the new database.
            const invalidRunId = randomUUID();
            await repos.backupRun.create({
              id: invalidRunId,
              organizationId: org.organizationId,
              projectId: legacy.id,
              sourceKind: "service",
              destinationId,
              status: "succeeded",
              triggeredBy: "manual",
              finishedAt: new Date(),
              artifacts: [{ ...artifacts[0], sha256: "0".repeat(64) }],
            });
            const failed = await finish(
              await client.projects.createClusterDatabase(legacy.id, {
                ...input,
                requestId: randomUUID(),
                name: "invalid-copy",
                importFrom: { runId: invalidRunId, artifactName: artifacts[0].name },
              }),
              ["failed"],
            );
            expect(failed.error).toContain(
              "Incremental backup index disagrees with the recorded backup",
            );
            expect(
              await query(
                failed,
                "psql -X -A -t -v ON_ERROR_STOP=1 -c \"SELECT count(*) FROM information_schema.tables WHERE table_name = 'acceptance'\"",
              ),
            ).toBe("0");
            expect(await source.read()).toBe("legacy-postgres");
            expect((await remove(failed, true)).status).toBe("deleted");
          }
        } finally {
          await source.dispose();
        }
      },
      1800000,
    );
  },
);
