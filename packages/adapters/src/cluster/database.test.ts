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
        persistentVolumeClaimRetentionPolicy: { whenDeleted: "Retain", whenScaled: "Retain" },
      },
    });
    expect(
      manifest.spec.redisLeader.affinity.podAntiAffinity
        .requiredDuringSchedulingIgnoredDuringExecution[0].labelSelector.matchLabels,
    ).toEqual({ "openship.io/database": "db" });
    expect(manifest.spec.redisFollower.affinity).toEqual(manifest.spec.redisLeader.affinity);
  });
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
                  labels: { "openship.io/database": "db", "openship.io/runtime": "runtime" },
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
      if (!path.includes("os-db-")) return missing();
      if (++reads > 1) return missing();
      return {
        metadata: {
          name: "database",
          deletionTimestamp: new Date().toISOString(),
          labels: { "openship.io/database": "db", "openship.io/runtime": "runtime" },
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
