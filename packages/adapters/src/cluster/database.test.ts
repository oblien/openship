import { describe, expect, it, vi } from "vitest";
import { ClusterDatabaseAdapter, clusterDatabaseHosts, clusterDatabaseUrl } from "./database";
import { prepareDatabaseAddon, ensureClusterAddonObject } from "./database-addons";
import type { ClusterDatabaseConfig } from "@repo/core";
import { KubernetesApiError, type KubernetesApi } from "./kubernetes-api";
import { projectNamespaceManifest } from "./namespace";
const config: ClusterDatabaseConfig = {
  engine: "postgres",
  mode: "cluster",
  instances: 3,
  storageGiB: 20,
  storageClass: "openship-local",
  cpuMillis: 500,
  memoryMiB: 512,
  databaseName: "app",
};
const adapter = (
  patch: Partial<ClusterDatabaseConfig> = {},
  api = { request: vi.fn() } as unknown as KubernetesApi,
  projectId = "project",
) =>
  new ClusterDatabaseAdapter(
    api,
    {
      id: "db",
      projectId,
      runtimeId: "runtime",
      generation: 1,
      config: { ...config, ...patch },
      hosts: [],
    },
    new AbortController().signal,
    vi.fn(),
  );
describe("operator database manifests", () => {
  it.each(["redis-rdb-set", "postgres-logical", "backup-artifact"] as const)(
    "keeps a completed %s import while applying updated resources",
    async (format) => {
      const saved = new Map<string, any>();
      const request = vi.fn(async (method: string, path: string, body?: any) => {
        if (method === "GET") {
          const current = saved.get(path);
          if (!current) throw new KubernetesApiError(404, "Not found");
          return structuredClone(current);
        }
        const key = method === "POST" ? `${path}/${body.metadata.name}` : path;
        const current = saved.get(key);
        const object = {
          ...body,
          metadata: { ...body.metadata, uid: current?.metadata.uid ?? key, resourceVersion: "1" },
        };
        saved.set(key, object);
        return structuredClone(object);
      });
      const original = adapter(
        format === "redis-rdb-set" ? { engine: "redis", mode: "replication", instances: 3 } : {},
        { request } as unknown as KubernetesApi,
      );
      await original.apply("password");
      const changed = new ClusterDatabaseAdapter(
        original.api,
        {
          ...original.target,
          generation: 2,
          config: { ...original.target.config, memoryMiB: 768 },
          restoreCompleted: true,
          restoreSource: {
            format,
            databaseId: "original-source",
            backupName: "saved",
            backupId: "original/manifest.json",
            destinationId: "removed-destination",
            destinationPath: "s3://original/backup",
            serverName: "original",
            endpoint: null,
          },
        },
        original.signal,
        async () => {},
      );
      await changed.apply("password");
      const recover = vi.spyOn(changed.dataTasks, "restore");
      await changed.restore(async () => {});
      expect(recover).not.toHaveBeenCalled();
      const write = [...request.mock.calls].reverse().find(
        ([method, path]) =>
          method === "PATCH" && /\/(?:clusters|redisreplications)\/database$/.test(path),
      );
      expect(write?.[2].spec).toMatchObject(
        format === "redis-rdb-set"
          ? { kubernetesConfig: { resources: { limits: { memory: "768Mi" } } } }
          : { resources: { limits: { memory: "768Mi" } } },
      );
      expect(request.mock.calls.some(([method]) => method === "DELETE")).toBe(false);
      expect(
        request.mock.calls.some(
          ([, path]) => path.includes("restore-destination") || path.includes("/jobs"),
        ),
      ).toBe(false);
    },
  );

  it("uses a fresh newer database for a logical upgrade instead of physical recovery across major versions", () => {
    const original = adapter();
    const upgraded = new ClusterDatabaseAdapter(
      original.api,
      {
        ...original.target,
        config: { ...config, version: "18" },
        restoreSource: {
          format: "postgres-logical",
          databaseId: "original",
          backupName: "copy",
          backupId: "snapshot/manifest.json",
          destinationId: "destination",
          destinationPath: "s3://backups/archives",
          serverName: "original",
          endpoint: null,
        },
      },
      original.signal,
      async () => {},
    );
    const spec = upgraded.manifest().spec;
    expect(spec.imageName).toContain("postgresql:18.4@sha256:");
    expect(spec.bootstrap.initdb).toMatchObject({ database: "app", owner: "app" });
    expect(spec.bootstrap.recovery).toBeUndefined();
    expect(spec.externalClusters).toBeUndefined();
  });
  it.each(["project", "another-project"])(
    "keeps a database referenced by a running release after disconnect (%s)",
    async (appProjectId) => {
      const instance = adapter();
      const request = vi.mocked(instance.api.request);
      request.mockImplementation(async (_method, path) => {
        if (path.startsWith("/api/v1/namespaces?"))
          return { items: [projectNamespaceManifest(appProjectId, "runtime")] } as any;
        if (
          path ===
            `/api/v1/namespaces/${projectNamespaceManifest("project", "runtime").metadata.name}` &&
          appProjectId !== "project"
        )
          throw new KubernetesApiError(404, "Not found");
        if (path.endsWith("/deployments"))
          return {
            items: [
              {
                spec: {
                  replicas: 1,
                  template: {
                    spec: {
                      containers: [{ envFrom: [{ secretRef: { name: "old-release-env" } }] }],
                    },
                  },
                },
              },
            ],
          } as any;
        if (path.endsWith("/secrets"))
          return {
            items: [
              {
                metadata: { name: "old-release-env" },
                data: {
                  DATABASE_URL: Buffer.from(clusterDatabaseUrl("db", config, "password")).toString(
                    "base64",
                  ),
                },
              },
            ],
          } as any;
        return {
          metadata: {
            name: "namespace",
            labels: {
              "openship.io/database": "db",
              "openship.io/runtime": "runtime",
              "openship.io/project": "project",
            },
          },
        } as any;
      });
      await expect(instance.remove(true)).rejects.toThrow(/application release still uses/);
      expect(request.mock.calls.every(([method]) => method === "GET")).toBe(true);
    },
  );
  it("grants and revokes only explicit private consumers while preserving database ownership", async () => {
    const labels = {
      "openship.io/database": "db",
      "openship.io/project": "project",
      "openship.io/runtime": "runtime",
    };
    const namespace = adapter().namespace;
    let policy: any;
    const api = {
      request: vi.fn(async (method: string, path: string, value?: any) => {
        if (method === "GET" && path.endsWith(namespace))
          return { kind: "Namespace", metadata: { name: namespace, uid: "db-namespace", labels } };
        if (method === "GET") {
          if (!policy) throw new KubernetesApiError(404, "Missing policy");
          return structuredClone(policy);
        }
        if (method === "POST" || method === "PATCH") {
          policy = {
            ...value,
            metadata: { ...value.metadata, uid: "policy-uid", resourceVersion: "2" },
          };
          return structuredClone(policy);
        }
        throw new Error("Unexpected request");
      }),
    } as unknown as KubernetesApi;
    const instance = adapter({}, api);
    await instance.reconcileConnections(["consumer", "consumer"]);
    const grants = policy.spec.ingress[1].from;
    expect(grants).toHaveLength(2);
    expect(grants[0]).toEqual({
      namespaceSelector: {
        matchLabels: {
          "kubernetes.io/metadata.name": projectNamespaceManifest("project", "runtime").metadata
            .name,
        },
      },
    });
    expect(grants[1].namespaceSelector.matchLabels["kubernetes.io/metadata.name"]).toBe(
      projectNamespaceManifest("consumer", "runtime").metadata.name,
    );
    expect(grants[1].podSelector.matchLabels).toEqual({
      "openship.io/project": "consumer",
      "openship.io/runtime": "runtime",
    });
    expect(policy.spec.ingress[1].ports).toEqual([{ protocol: "TCP", port: 5432 }]);
    await instance.reconcileConnections([]);
    expect(policy.spec.ingress[1].from).toHaveLength(1);
    expect(policy.metadata.labels).toEqual(labels);
    expect(
      policy.spec.ingress[2].from[0].namespaceSelector.matchLabels["kubernetes.io/metadata.name"],
    ).toBe("cnpg-system");
  });

  it("keeps Sentinel administration private while granting only its scoped quorum probe", async () => {
    const instance = adapter({ engine: "redis", mode: "replication" });
    const labels = instance.manifest().metadata.labels!;
    let policy: any;
    vi.mocked(instance.api.request).mockImplementation(async (method, path, body) => {
      if (method === "GET" && path.endsWith(instance.namespace))
        return { metadata: { name: instance.namespace, labels } } as any;
      if (method === "GET") throw new KubernetesApiError(404, "missing");
      policy = body;
      return body as any;
    });
    await instance.reconcileConnections(["consumer"]);
    expect(policy.spec.ingress[1].ports).toEqual([{ protocol: "TCP", port: 6379 }]);
    expect(policy.spec.ingress[2].ports).toEqual([
      { protocol: "TCP", port: 6379 },
      { protocol: "TCP", port: 26379 },
    ]);
    expect(policy.spec.ingress[3].ports).toEqual([{ protocol: "TCP", port: 26379 }]);
    expect(policy.spec.ingress[3].from).toHaveLength(1);
    expect(policy.spec.ingress[3].from[0].podSelector.matchLabels).toEqual({
      ...labels,
      "openship.io/database-probe": "true",
    });
    expect(
      policy.spec.ingress[3].from[0].namespaceSelector.matchLabels["kubernetes.io/metadata.name"],
    ).toBe(projectNamespaceManifest("project", "runtime").metadata.name);
  });

  it("uses the same valid project identity as application namespaces", () => {
    const projectId = "proj_database_";
    const database = adapter({}, undefined, projectId).manifest();
    const namespace = projectNamespaceManifest(projectId, "runtime");
    const label = database.metadata.labels!["openship.io/project"]!;
    expect(label).toBe(namespace.metadata.labels!["openship.io/project"]);
    expect(label).toMatch(/^[a-z0-9](?:[-a-z0-9_.]*[a-z0-9])?$/i);
    expect(label.length).toBeLessThanOrEqual(63);
  });

  it("uses a primary and synchronous replicas with strict server separation", () => {
    const manifest = adapter().manifest();
    expect(manifest.kind).toBe("Cluster");
    expect(manifest.spec).toMatchObject({
      instances: 3,
      enableSuperuserAccess: false,
      postgresql: { synchronous: { number: 1, dataDurability: "required" } },
      affinity: {
        podAntiAffinityType: "required",
        nodeSelector: { "openship.io/runtime": "runtime" },
      },
    });
    expect(manifest.spec.storage).toEqual({ size: "20Gi", storageClass: "openship-local" });
    expect(manifest.spec.imageName).toContain("@sha256:");
    expect(manifest.spec.bootstrap.initdb.secret.name).toBe("credentials");
  });
  it("keeps Redis data and cluster node identity in separate persistent claims", () => {
    const manifest = adapter({ engine: "redis" }).manifest();
    expect(manifest.kind).toBe("RedisCluster");
    expect(manifest.spec).toMatchObject({
      clusterSize: 3,
      persistenceEnabled: true,
      storage: { keepAfterDelete: true, nodeConfVolume: true },
      kubernetesConfig: {
        ignoreAnnotations: ["openship.io/generation"],
        persistentVolumeClaimRetentionPolicy: { whenDeleted: "Retain", whenScaled: "Retain" },
      },
    });
    expect(
      manifest.spec.redisLeader.affinity.podAntiAffinity
        .requiredDuringSchedulingIgnoredDuringExecution[0].labelSelector.matchLabels,
    ).toEqual({ "openship.io/database": "db", redis_setup_type: "cluster" });
    expect(manifest.spec.redisFollower.affinity).toEqual(manifest.spec.redisLeader.affinity);
  });
  it("declares non-sharded Redis with an authenticated primary, replica service and isolated Sentinel quorum", () => {
    const replication: ClusterDatabaseConfig = { ...config, engine: "redis", mode: "replication" };
    const manifest = adapter(replication).manifest();
    expect(manifest.kind).toBe("RedisReplication");
    expect(manifest.spec.clusterSize).toBe(3);
    expect(manifest.spec.redisLeader).toBeUndefined();
    expect(manifest.spec.storage.keepAfterDelete).toBe(true);
    expect(manifest.spec.kubernetesConfig.redisSecret).toEqual({
      name: "credentials",
      key: "password",
    });
    expect(manifest.spec.kubernetesConfig.persistentVolumeClaimRetentionPolicy).toEqual({
      whenDeleted: "Retain",
      whenScaled: "Retain",
    });
    const sentinel = adapter(replication).sentinelManifest();
    expect(manifest.spec.sentinel).toBeUndefined();
    expect(sentinel.kind).toBe("RedisSentinel");
    expect(sentinel.spec).toMatchObject({
      clusterSize: 3,
      redisSentinelConfig: {
        redisReplicationName: "database",
        masterGroupName: "mymaster",
        redisReplicationPassword: { secretKeyRef: { name: "credentials", key: "password" } },
      },
      nodeSelector: { "openship.io/runtime": "runtime" },
    });
    expect(sentinel.spec.kubernetesConfig.redisSecret).toEqual({
      name: "credentials",
      key: "password",
    });
    expect(sentinel.spec.kubernetesConfig.image).toMatch(
      /^quay.io\/opstree\/redis-sentinel:v7\.4\.11@sha256:/,
    );
    expect(
      manifest.spec.affinity.podAntiAffinity.requiredDuringSchedulingIgnoredDuringExecution[0]
        .labelSelector.matchLabels.redis_setup_type,
    ).toBe("replication");
    expect(
      sentinel.spec.affinity.podAntiAffinity.requiredDuringSchedulingIgnoredDuringExecution[0]
        .labelSelector.matchLabels.redis_setup_type,
    ).toBe("sentinel");
    const hosts = clusterDatabaseHosts("db", replication);
    expect(hosts.internalHost).toMatch(/^database-master\./);
    expect(hosts.readOnlyHost).toMatch(/^database-replica\./);
    expect(clusterDatabaseUrl("db", replication, "private")).toContain("@database-master.");
    expect(clusterDatabaseUrl("db", replication, "private", "read")).toContain(
      "@database-replica.",
    );
  });

  it("counts Redis data and quorum separately and uses the operator's elected primary after failover", async () => {
    const instance = adapter({ engine: "redis", mode: "replication" });
    const labels = instance.manifest().metadata.labels!;
    const pod = (name: string, type: string, index: number) => ({
      metadata: { name, labels: { ...labels, redis_setup_type: type } },
      spec: { nodeName: `server-${index}` },
      status: { conditions: [{ type: "Ready", status: "True" }], phase: "Running" },
    });
    const members = [0, 1, 2].map((index) => pod(`database-${index}`, "replication", index));
    const sentinels = [0, 1, 2].map((index) => pod(`database-s-${index}`, "sentinel", index));
    const request = vi.mocked(instance.api.request);
    request.mockImplementation(async (_method, path) => {
      if (path.endsWith("/redisreplications/database"))
        return {
          metadata: { name: "database", labels },
          status: { masterNode: "database-2" },
        } as any;
      if (path.endsWith("/pods")) return { items: [...members, ...sentinels] } as any;
      if (path.endsWith("/persistentvolumeclaims"))
        return {
          items: members.map((member) => ({
            metadata: member.metadata,
            status: { phase: "Bound" },
          })),
        } as any;
      return { metadata: { name: instance.namespace, labels } } as any;
    });
    const ready = await instance.observe();
    expect(ready.ready).toBe(true);
    expect(ready.primary).toBe("database-2");
    expect(ready.pods.find((pod) => pod.name === "database-2")?.role).toBe("primary");
    expect(ready.pods.filter((pod) => pod.role === "replica")).toHaveLength(2);
    expect(ready.pods.filter((pod) => pod.role === "sentinel")).toHaveLength(3);
    sentinels[0].status.conditions[0].status = "False";
    expect((await instance.observe()).ready).toBe(false);
    sentinels[0].status.conditions[0].status = "True";
    sentinels[0].spec.nodeName = sentinels[1].spec.nodeName;
    expect((await instance.observe()).ready).toBe(false);
  });

  it.each(["database-0", "database-3", "", "unrecognized-primary"])(
    "refuses unverified Redis member removal regardless of last observed primary (%s)",
    async (primary) => {
      const instance = adapter({ engine: "redis", mode: "replication", instances: 3 });
      const labels = instance.manifest().metadata.labels!;
      const request = vi.mocked(instance.api.request);
      request.mockImplementation(async (method, path, body) => {
        if (method === "GET" && path.endsWith("/redisreplications/database"))
          return {
            metadata: { name: "database", uid: "db", resourceVersion: "1", labels },
            spec: { clusterSize: 4 },
            status: { masterNode: primary },
          } as any;
        if (method === "GET" && path.endsWith("/credentials"))
          return {
            metadata: { name: "credentials", uid: "secret", labels },
            data: { password: Buffer.from("password").toString("base64") },
          } as any;
        if (method === "GET" && !path.endsWith(instance.namespace))
          throw new KubernetesApiError(404, "missing");
        if (method === "GET") return { metadata: { name: instance.namespace, labels } } as any;
        return {
          ...(body as Record<string, unknown>),
          metadata: { ...(body as any)?.metadata, uid: "new", resourceVersion: "1" },
        } as any;
      });
      await expect(instance.apply("password")).rejects.toThrow(/cannot be removed in place/);
      expect(
        request.mock.calls.some(
          ([method, path]) => method === "PATCH" && path.endsWith("/redisreplications/database"),
        ),
      ).toBe(false);
    },
  );

  it("does not describe standalone Redis as a sharded cluster", () => {
    const manifest = adapter({ engine: "redis", mode: "standalone", instances: 1 }).manifest();
    expect(manifest.kind).toBe("Redis");
    expect(manifest.spec.clusterSize).toBeUndefined();
    expect(
      clusterDatabaseHosts("db", { ...config, engine: "redis", mode: "standalone" }).internalHost,
    ).toMatch(/^database\./);
  });
  it.each([
    [
      {
        conditions: [
          {
            type: "PodScheduled",
            status: "False",
            reason: "Unschedulable",
            message: "No server has enough free memory.",
          },
        ],
      },
      "No server has enough free memory.",
    ],
    [
      {
        initContainerStatuses: [
          {
            state: {
              waiting: {
                reason: "ImagePullBackOff",
                message: "The registry denied the image pull.",
              },
            },
          },
        ],
      },
      "The registry denied the image pull.",
    ],
  ])("reports the actual prerequisite blocking a database instance", async (status, message) => {
    const pod = {
      metadata: { name: "database-1", labels: { "openship.io/database": "db" } },
      status,
    };
    const api = {
      request: vi.fn(async (_method, path) =>
        path.endsWith("/pods")
          ? { items: [pod] }
          : path.endsWith("/persistentvolumeclaims")
            ? { items: [] }
            : {
                metadata: {
                  name: "database",
                  labels: {
                    "openship.io/database": "db",
                    "openship.io/runtime": "runtime",
                    "openship.io/project": "project",
                  },
                },
                status: {},
              },
      ),
    } as unknown as KubernetesApi;
    const view = await adapter({}, api).observe();
    expect(view.ready).toBe(false);
    expect(view.message).toContain(message);
    expect(view.message).toContain("database-1");
  });
  it("separates namespaces and encodes generated credentials in private connection URLs", () => {
    expect(clusterDatabaseHosts("db-a", config)).not.toEqual(clusterDatabaseHosts("db-b", config));
    expect(clusterDatabaseUrl("db", config, "pass@:/?#")).toContain("pass%40%3A%2F%3F%23@");
    expect(clusterDatabaseUrl("db", config, "pass")).toContain("sslmode=require");
  });
  it("refuses to adopt another controller's add-on", async () => {
    const api = {
      request: vi.fn(async () => ({ metadata: { name: "operator", labels: {} } })),
    } as unknown as KubernetesApi;
    await expect(
      ensureClusterAddonObject(
        api,
        { apiVersion: "v1", kind: "Namespace", metadata: { name: "operator" } },
        "runtime",
        "postgres",
        new AbortController().signal,
        vi.fn(),
      ),
    ).rejects.toThrow("different ownership");
    expect(api.request).toHaveBeenCalledTimes(1);
  });
  it("continues an already accepted namespace deletion without replaying mutations", async () => {
    let reads = 0;
    const missing = () => {
      throw new KubernetesApiError(404, "Not found");
    };
    const request = vi.fn(async (_method: string, path: string) => {
      if (path.startsWith("/api/v1/namespaces?")) return { items: [] };
      if (!path.includes("os-db-")) return missing();
      if (++reads > 1) return missing();
      return {
        metadata: {
          name: "database",
          deletionTimestamp: new Date().toISOString(),
          labels: {
            "openship.io/database": "db",
            "openship.io/runtime": "runtime",
            "openship.io/project": "project",
          },
        },
      };
    });
    const api = { request } as unknown as KubernetesApi;
    await adapter({}, api).remove(true);
    expect(request.mock.calls.every(([method]) => method === "GET")).toBe(true);
  });
  it("prepares a dedicated storage class with explicit retention without changing defaults", () => {
    const objects = prepareDatabaseAddon(
      "local",
      [
        {
          apiVersion: "storage.k8s.io/v1",
          kind: "StorageClass",
          metadata: { name: "local-path" },
          provisioner: "rancher.io/local-path",
          reclaimPolicy: "Delete",
        },
      ],
      "runtime",
    );
    expect(objects[0]).toMatchObject({
      metadata: { name: "openship-local" },
      provisioner: "openship.io/local-path",
      reclaimPolicy: "Retain",
    });
    expect(
      objects[0].metadata.annotations?.["storageclass.kubernetes.io/is-default-class"],
    ).toBeUndefined();
  });
});
