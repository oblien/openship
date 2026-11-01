import { describe, expect, it, vi } from "vitest";
import { KubernetesApiError, type KubernetesApi, type KubernetesObject } from "./kubernetes-api";
import { PostgresArchive, postgresObjectStore } from "./database-backups";
import { ClusterDatabaseAdapter } from "./database";
const signal = new AbortController().signal;
const storage = {
  destinationId: "s3",
  destinationPath: "s3://archives/openship/databases",
  endpoint: "https://objects.example.com",
  region: "auto",
  accessKeyId: "s3-access-test-value",
  secretAccessKey: "s3-secret-test-value",
};
function archive(objects: KubernetesObject[]) {
  const api = {
    request: vi.fn(async (_method: string, path: string) =>
      path.endsWith("/backups")
        ? { items: objects }
        : path.endsWith("scheduledbackups/archives")
          ? { metadata: {} }
          : objects.find((object) => path.endsWith("/" + object.metadata.name)),
    ),
  } as unknown as KubernetesApi;
  const declare = vi.fn();
  return {
    archive: new PostgresArchive(
      api,
      "namespace",
      { "openship.io/database": "database" },
      signal,
      vi.fn(),
      declare,
    ),
    declare,
    api,
  };
}
const backup = (phase: string, extra: Record<string, unknown> = {}): KubernetesObject => ({
  metadata: {
    name: "saved-backup",
    labels: { "openship.io/database": "database", "openship.io/backup-request": "request" },
  },
  spec: { cluster: { name: "database" } },
  status: {
    phase,
    backupId: "20260921T100000",
    destinationPath: storage.destinationPath,
    serverName: "original-namespace",
    ...extra,
  },
});
describe("operator archive recovery", () => {
  it("gives scheduled Redis backups the private Sentinel topology used for primary discovery", async () => {
    const saved = new Map<string, any>();
    const request = vi.fn(async (method: string, path: string, body?: any) => {
      if (method === "GET") {
        const object = saved.get(path);
        if (!object) throw new KubernetesApiError(404, "Not found");
        return structuredClone(object);
      }
      const key = method === "POST" ? `${path}/${body.metadata.name}` : path;
      const previous = saved.get(key);
      const object = {
        ...previous,
        ...body,
        data: { ...previous?.data, ...body.data },
        metadata: {
          ...previous?.metadata,
          ...body.metadata,
          uid: "owned-resource",
          resourceVersion: "1",
        },
      };
      saved.set(key, object);
      return structuredClone(object);
    });
    const config = {
      engine: "redis" as const,
      mode: "replication" as const,
      instances: 4,
      storageGiB: 1,
      storageClass: "openship-local",
      cpuMillis: 250,
      memoryMiB: 256,
      databaseName: "app",
      backup: { destinationId: "s3", schedule: "daily" as const, retentionDays: 7 },
    };
    const adapter = new ClusterDatabaseAdapter(
      { request } as unknown as KubernetesApi,
      {
        id: "database",
        projectId: "project",
        runtimeId: "runtime",
        generation: 1,
        hosts: [],
        config,
        backupStorage: storage,
      },
      signal,
      async () => {},
    );
    await adapter.dataTasks.schedule(config.backup);
    const scheduled = request.mock.calls.find(
      ([method, path]) => method === "POST" && path.endsWith("/cronjobs"),
    )![2];
    const task = scheduled.spec.jobTemplate.spec.template.spec.containers[0];
    expect(
      JSON.parse(task.env.find((item: any) => item.name === "TASK_CONFIG").value).redis,
    ).toEqual({
      host: `database-master.${adapter.namespace}.svc.cluster.local`,
      port: 6379,
      mode: "replication",
      replicas: 3,
      sentinel: {
        host: `database-sentinel.${adapter.namespace}.svc.cluster.local`,
        port: 26379,
        masterName: "mymaster",
      },
    });
  });

  it("adopts a completed backup after an ambiguous controller response", async () => {
    const context = archive([backup("completed")]);
    await context.archive.run("request", 3, vi.fn());
    expect(context.declare).not.toHaveBeenCalled();
  });
  it("does not let foreign or incomplete backup records select a recovery source", async () => {
    const foreign = backup("completed");
    foreign.metadata.labels = {};
    const context = archive([
      foreign,
      { ...backup("running"), metadata: { ...backup("running").metadata, name: "pending" } },
    ]);
    await expect(context.archive.restoreSource("database", "s3", "saved-backup")).rejects.toThrow(
      "completed PostgreSQL",
    );
    await expect(context.archive.restoreSource("database", "s3", "pending")).rejects.toThrow(
      "completed PostgreSQL",
    );
  });
  it("keeps credentials in Secret references and restores to an explicit consistent backup point", async () => {
    const context = archive([backup("completed", { endpointURL: storage.endpoint })]);
    const restoreSource = await context.archive.restoreSource("database", "s3", "saved-backup");
    const target = new ClusterDatabaseAdapter(
      context.api,
      {
        id: "new-database",
        projectId: "project",
        runtimeId: "runtime",
        generation: 1,
        hosts: [],
        config: {
          engine: "postgres",
          mode: "standalone",
          instances: 1,
          storageGiB: 20,
          storageClass: "openship-local",
          cpuMillis: 500,
          memoryMiB: 512,
          databaseName: "app",
        },
        restoreSource,
        restoreStorage: storage,
      },
      signal,
      vi.fn(),
    );
    expect(target.manifest().spec.bootstrap).toEqual({
      recovery: {
        source: "original",
        database: "app",
        owner: "app",
        secret: { name: "credentials" },
        recoveryTarget: { backupID: "20260921T100000", targetImmediate: true },
      },
    });
    expect(target.manifest().spec.externalClusters[0].barmanObjectStore.serverName).toBe(
      "original-namespace",
    );
    expect(postgresObjectStore(storage, "database", "s3").s3Credentials.secretAccessKey).toEqual({
      name: "s3",
      key: "secretAccessKey",
    });
    expect(JSON.stringify(target.manifest())).not.toContain(storage.secretAccessKey);
    expect(JSON.stringify(target.manifest())).not.toContain(storage.accessKeyId);
  });
});
