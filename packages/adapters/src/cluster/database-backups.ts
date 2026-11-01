import type {
  ClusterDatabaseBackup,
  ClusterDatabaseConfig,
  ClusterDatabaseRestoreSource,
} from "@repo/core";
import { AppError } from "@repo/core";
import type { KubernetesApi, KubernetesObject } from "./kubernetes-api";
import { clusterObject, waitForClusterResource } from "./database-addons";

/** Hydrated only by the platform. Credentials are never part of a public DTO. */
export interface ClusterDatabaseBackupStorage {
  destinationId: string;
  destinationPath: string;
  endpoint: string | null;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}
export function postgresObjectStore(
  storage: ClusterDatabaseBackupStorage,
  serverName: string,
  secretName: string,
) {
  const ref = (key: string) => ({ name: secretName, key });
  return {
    destinationPath: storage.destinationPath,
    serverName,
    ...(storage.endpoint ? { endpointURL: storage.endpoint } : {}),
    s3Credentials: {
      accessKeyId: ref("accessKeyId"),
      secretAccessKey: ref("secretAccessKey"),
      region: ref("region"),
    },
    data: { compression: "gzip" },
    wal: { compression: "gzip" },
  };
}
export class PostgresArchive {
  private readonly base: string;
  constructor(
    private readonly api: KubernetesApi,
    private readonly namespace: string,
    private readonly labels: Record<string, string>,
    private readonly signal: AbortSignal,
    private readonly fence: () => Promise<void>,
    private readonly declare: (
      path: string,
      object: KubernetesObject,
      update?: boolean,
    ) => Promise<KubernetesObject>,
  ) {
    this.base = `/apis/postgresql.cnpg.io/v1/namespaces/${namespace}`;
  }
  private metadata(name: string) {
    return { name, namespace: this.namespace, labels: this.labels };
  }
  async secret(name: string, storage: ClusterDatabaseBackupStorage) {
    const data = Object.fromEntries(
      (["accessKeyId", "secretAccessKey", "region"] as const).map((key) => [
        key,
        Buffer.from(storage[key]).toString("base64"),
      ]),
    );
    await this.declare(
      `/api/v1/namespaces/${this.namespace}/secrets`,
      { apiVersion: "v1", kind: "Secret", metadata: this.metadata(name), data },
      true,
    );
  }
  async schedule(config: NonNullable<ClusterDatabaseConfig["backup"]>) {
    await this.declare(
      `${this.base}/scheduledbackups`,
      {
        apiVersion: "postgresql.cnpg.io/v1",
        kind: "ScheduledBackup",
        metadata: this.metadata("archives"),
        spec: {
          cluster: { name: "database" },
          method: "barmanObjectStore",
          target: "prefer-standby",
          backupOwnerReference: "self",
          immediate: false,
          schedule: config.schedule === "hourly" ? "0 0 * * * *" : "0 0 3 * * *",
          suspend: config.schedule === "manual",
        },
      },
      true,
    );
  }
  async suspend() {
    const schedule = await clusterObject(
      this.api,
      `${this.base}/scheduledbackups/archives`,
      this.signal,
    );
    if (!schedule) return;
    if (schedule.metadata.labels?.["openship.io/database"] !== this.labels["openship.io/database"])
      throw new Error("The database backup schedule has different ownership.");
    await this.fence();
    await this.api.request(
      "PATCH",
      `${this.base}/scheduledbackups/archives`,
      { metadata: { resourceVersion: schedule.metadata.resourceVersion }, spec: { suspend: true } },
      this.signal,
    );
  }
  private async objects() {
    const [list, schedule] = await Promise.all([
      this.api.request<{ items: KubernetesObject[] }>(
        "GET",
        `${this.base}/backups`,
        undefined,
        this.signal,
      ),
      clusterObject(this.api, `${this.base}/scheduledbackups/archives`, this.signal),
    ]);
    const scheduleUid =
      schedule?.metadata.labels?.["openship.io/database"] === this.labels["openship.io/database"]
        ? schedule.metadata.uid
        : undefined;
    return list.items.filter(
      (backup) =>
        !backup.metadata.deletionTimestamp &&
        backup.spec?.cluster?.name === "database" &&
        (backup.metadata.labels?.["openship.io/database"] === this.labels["openship.io/database"] ||
          (scheduleUid &&
            backup.metadata.ownerReferences?.some((owner) => owner.uid === scheduleUid))),
    );
  }
  async list(): Promise<ClusterDatabaseBackup[]> {
    return (await this.objects())
      .sort((a, b) =>
        String(b.metadata.creationTimestamp).localeCompare(String(a.metadata.creationTimestamp)),
      )
      .slice(0, 100)
      .map((backup) => ({
        name: backup.metadata.name!,
        phase: backup.status?.phase ?? "pending",
        startedAt: backup.status?.startedAt ?? null,
        completedAt: backup.status?.stoppedAt ?? null,
        backupId: backup.status?.backupId ?? null,
        error: backup.status?.error ? String(backup.status.error).slice(0, 2000) : null,
      }));
  }
  async restoreSource(
    databaseId: string,
    destinationId: string,
    name: string,
  ): Promise<ClusterDatabaseRestoreSource> {
    const backup = (await this.objects()).find((backup) => backup.metadata.name === name);
    if (
      !backup ||
      backup.status?.phase !== "completed" ||
      !/^[0-9]{8}T[0-9]{6}$/.test(backup.status?.backupId ?? "") ||
      !String(backup.status?.destinationPath ?? "").startsWith("s3://")
    )
      throw new AppError(
        "Choose a completed PostgreSQL archive backup before restoring.",
        409,
        "CLUSTER_DATABASE_BACKUP_NOT_READY",
      );
    return {
      databaseId,
      destinationId,
      backupName: name,
      backupId: backup.status.backupId,
      destinationPath: backup.status.destinationPath,
      serverName: backup.status.serverName ?? this.namespace,
      endpoint: backup.status.endpointURL ?? null,
    };
  }
  /** The operator continues an accepted backup even if OpenShip disconnects.
   * A retry adopts that same request, starting a new attempt only after failure. */
  async run(requestId: string, generation: number, log: (message: string) => Promise<void>) {
    if (!/^[a-z0-9-]{1,48}$/.test(requestId))
      throw new Error("Invalid saved backup request identity.");
    const previous = (await this.objects()).filter(
      (object) => object.metadata.labels?.["openship.io/backup-request"] === requestId,
    );
    if (previous.some((object) => object.status?.phase === "completed")) {
      await log("The saved backup already completed. Reusing its verified archive.");
      return;
    }
    const pending = previous.find((object) => object.status?.phase !== "failed");
    const name = pending?.metadata.name ?? `b-${requestId}-${generation}`;
    if (!pending)
      await this.declare(`${this.base}/backups`, {
        apiVersion: "postgresql.cnpg.io/v1",
        kind: "Backup",
        metadata: {
          ...this.metadata(name),
          labels: { ...this.labels, "openship.io/backup-request": requestId },
        },
        spec: {
          cluster: { name: "database" },
          method: "barmanObjectStore",
          target: "prefer-standby",
        },
      });
    let last = "";
    await waitForClusterResource(
      this.signal,
      async () => {
        const backup = await this.api.request(
          "GET",
          `${this.base}/backups/${name}`,
          undefined,
          this.signal,
        );
        const phase = backup.status?.phase ?? "pending";
        if (phase !== last) {
          last = phase;
          await log(`PostgreSQL archive backup: ${phase}.`);
        }
        if (phase === "failed")
          throw new Error(
            `PostgreSQL backup failed: ${String(backup.status?.error ?? "The database operator reported a backup error.")} ${String(backup.status?.commandError ?? "").slice(-3000)}`,
          );
        return phase === "completed" && backup.status?.backupId ? backup : null;
      },
      "the PostgreSQL archive backup",
      20 * 60_000,
    );
    await log(
      "PostgreSQL data and recovery metadata were uploaded to the configured backup destination.",
    );
  }
}
