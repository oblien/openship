import { createHash } from "node:crypto";
import {
  AppError,
  buildImageRef,
  type ClusterDatabaseConfig,
  type ClusterDatabaseBackup,
  type ClusterDatabaseRestoreSource,
} from "@repo/core";
import type { KubernetesApi, KubernetesObject } from "./kubernetes-api";
import type { ClusterDatabaseBackupStorage } from "./database-backups";
import { clusterObject } from "./database-addons";
import { patchKubernetesObject } from "./kubernetes-mutation";
import { runClusterJob } from "./job";
import { ARCHIVE_INDEX, decodeArchiveEntries, encodeArchiveEntries } from "./tasks/archive-index";
import type { DatabaseTaskConfig } from "./tasks/types";
import { restoreSignature } from "./tasks/main";

const conflict = (message: string) =>
  new AppError(message, 409, "CLUSTER_DATABASE_BACKUP_NOT_READY");
export function databaseTaskImage() {
  return buildImageRef(undefined, {
    name: "openship-cluster-tasks",
    imageOverride: process.env.OPENSHIP_CLUSTER_TASKS_IMAGE,
  });
}
export const databaseArchiveName = (requestId: string) =>
  `b-${createHash("sha256").update(requestId).digest("hex").slice(0, 24)}`;
export class DatabaseArchiveTasks {
  private readonly base: string;
  constructor(
    private readonly api: KubernetesApi,
    private readonly namespace: string,
    private readonly labels: Record<string, string>,
    private readonly config: ClusterDatabaseConfig,
    private readonly storage: ClusterDatabaseBackupStorage | undefined,
    private readonly signal: AbortSignal,
    private readonly fence: () => Promise<void>,
    private readonly declare: (
      path: string,
      object: KubernetesObject,
      update?: boolean,
    ) => Promise<KubernetesObject>,
  ) {
    this.base = `/api/v1/namespaces/${namespace}`;
  }
  private metadata(name: string) {
    return { name, namespace: this.namespace, labels: this.labels };
  }
  private owned(object: KubernetesObject) {
    if (
      Object.entries(this.labels).some(([key, value]) => object.metadata.labels?.[key] !== value) ||
      object.metadata.deletionTimestamp
    )
      throw conflict("The saved database backup resources changed ownership.");
  }
  async secret(name: string, storage: ClusterDatabaseBackupStorage) {
    await this.declare(
      `${this.base}/secrets`,
      {
        apiVersion: "v1",
        kind: "Secret",
        metadata: this.metadata(name),
        type: "Opaque",
        data: Object.fromEntries(
          Object.entries({
            accessKeyId: storage.accessKeyId,
            secretAccessKey: storage.secretAccessKey,
            region: storage.region,
            endpoint: storage.endpoint ?? "",
          }).map(([key, value]) => [key, Buffer.from(value).toString("base64")]),
        ),
      },
      true,
    );
  }
  private async catalogue() {
    const index = await clusterObject(
      this.api,
      `${this.base}/configmaps/${ARCHIVE_INDEX}`,
      this.signal,
    );
    if (index) this.owned(index);
    return index;
  }
  private async prepare(storage: ClusterDatabaseBackupStorage) {
    let index = await this.declare(`${this.base}/configmaps`, {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: this.metadata(ARCHIVE_INDEX),
      data: {},
    });
    if (this.config.backup)
      index = await patchKubernetesObject(
        this.api,
        `${this.base}/configmaps/${ARCHIVE_INDEX}`,
        async (current) => {
          this.owned(current);
          if (
            current.data?.destinationPath &&
            (current.data.destinationPath !== storage.destinationPath ||
              current.data.endpoint !== (storage.endpoint ?? ""))
          )
            throw conflict(
              "The database archive location changed. Restore its saved destination before continuing.",
            );
          await this.fence();
          return {
            data: { destinationPath: storage.destinationPath, endpoint: storage.endpoint ?? "" },
          };
        },
        this.signal,
      );
    await this.declare(`${this.base}/serviceaccounts`, {
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: this.metadata("database-archives"),
    });
    await this.declare(`/apis/rbac.authorization.k8s.io/v1/namespaces/${this.namespace}/roles`, {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "Role",
      metadata: this.metadata("database-archives"),
      rules: [
        {
          apiGroups: [""],
          resources: ["configmaps"],
          resourceNames: [ARCHIVE_INDEX],
          verbs: ["get", "patch"],
        },
      ],
    });
    await this.declare(
      `/apis/rbac.authorization.k8s.io/v1/namespaces/${this.namespace}/rolebindings`,
      {
        apiVersion: "rbac.authorization.k8s.io/v1",
        kind: "RoleBinding",
        metadata: this.metadata("database-archives"),
        roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: "database-archives" },
        subjects: [
          { kind: "ServiceAccount", name: "database-archives", namespace: this.namespace },
        ],
      },
    );
    return index;
  }
  private task(config: DatabaseTaskConfig, secretName: string) {
    const envSecret = (name: string, key: string) => ({
      name,
      valueFrom: { secretKeyRef: { name: secretName, key } },
    });
    return {
      backoffLimit: 0,
      activeDeadlineSeconds: 1800,
      ttlSecondsAfterFinished: 86400,
      template: {
        metadata: { labels: { ...this.labels, "openship.io/database-task": "true" } },
        spec: {
          restartPolicy: "Never",
          serviceAccountName: "database-archives",
          automountServiceAccountToken: true,
          nodeSelector: { "openship.io/runtime": this.labels["openship.io/runtime"] },
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 1000,
            fsGroup: 1000,
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            {
              name: "data",
              image: databaseTaskImage(),
              imagePullPolicy: "IfNotPresent",
              securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
              env: [
                { name: "OPENSHIP_DATABASE_TASK", value: "1" },
                { name: "TASK_CONFIG", value: JSON.stringify(config) },
                {
                  name: "JOB_NAME",
                  valueFrom: {
                    fieldRef: { fieldPath: "metadata.labels['batch.kubernetes.io/job-name']" },
                  },
                },
                {
                  name: config.postgres ? "PGPASSWORD" : "REDISCLI_AUTH",
                  valueFrom: { secretKeyRef: { name: "credentials", key: "password" } },
                },
                envSecret("BACKUP_ACCESS_KEY_ID", "accessKeyId"),
                envSecret("BACKUP_SECRET_ACCESS_KEY", "secretAccessKey"),
                envSecret("BACKUP_REGION", "region"),
                envSecret("BACKUP_ENDPOINT", "endpoint"),
              ],
              resources: {
                requests: { cpu: "100m", memory: "128Mi", "ephemeral-storage": "128Mi" },
                limits: {
                  cpu: "1",
                  memory: `${this.config.memoryMiB + 256}Mi`,
                  "ephemeral-storage": `${this.config.storageGiB * 2 + 1}Gi`,
                },
              },
              volumeMounts: [{ name: "scratch", mountPath: "/tmp" }],
            },
          ],
          volumes: [
            { name: "scratch", emptyDir: { sizeLimit: `${this.config.storageGiB * 2 + 1}Gi` } },
          ],
        },
      },
    };
  }
  private configFor(
    index: KubernetesObject,
    storage: ClusterDatabaseBackupStorage,
  ): DatabaseTaskConfig {
    return {
      operation: this.config.engine === "postgres" ? "postgres-backup" : "redis-backup",
      databaseId: this.labels["openship.io/database"],
      runtimeId: this.labels["openship.io/runtime"],
      namespace: this.namespace,
      indexUid: index.metadata.uid!,
      destinationPath: storage.destinationPath,
      ...(this.config.engine === "postgres"
        ? {
            postgres: {
              host: `database-rw.${this.namespace}.svc.cluster.local`,
              database: this.config.databaseName,
              user: "app",
            },
          }
        : {
            redis: {
              host: `${this.config.mode === "cluster" ? "database-leader" : this.config.mode === "replication" ? "database-master" : "database"}.${this.namespace}.svc.cluster.local`,
              port: 6379,
              mode: this.config.mode,
              ...(this.config.mode === "replication"
                ? {
                    replicas: this.config.instances - 1,
                    sentinel: {
                      host: `database-sentinel.${this.namespace}.svc.cluster.local`,
                      port: 26379,
                      masterName: "mymaster",
                    },
                  }
                : {}),
            },
          }),
      retentionDays: this.config.backup?.retentionDays,
    };
  }
  async schedule(config: NonNullable<ClusterDatabaseConfig["backup"]>) {
    if (!this.storage) throw conflict("Choose a backup destination for this database.");
    const index = await this.prepare(this.storage);
    await this.declare(
      `/apis/batch/v1/namespaces/${this.namespace}/cronjobs`,
      {
        apiVersion: "batch/v1",
        kind: "CronJob",
        metadata: this.metadata("archives"),
        spec: {
          schedule: config.schedule === "hourly" ? "0 * * * *" : "0 3 * * *",
          timeZone: "Etc/UTC",
          suspend: config.schedule === "manual",
          concurrencyPolicy: "Forbid",
          startingDeadlineSeconds: 300,
          successfulJobsHistoryLimit: 1,
          failedJobsHistoryLimit: 3,
          jobTemplate: {
            metadata: { labels: this.labels },
            spec: this.task(this.configFor(index, this.storage), "backup-destination"),
          },
        },
      },
      true,
    );
  }
  async suspend() {
    const path = `/apis/batch/v1/namespaces/${this.namespace}/cronjobs/archives`;
    if (!(await clusterObject(this.api, path, this.signal))) return;
    await patchKubernetesObject(
      this.api,
      path,
      async (current) => {
        this.owned(current);
        await this.fence();
        return { spec: { suspend: true } };
      },
      this.signal,
    );
  }
  async list(): Promise<ClusterDatabaseBackup[]> {
    return decodeArchiveEntries((await this.catalogue())?.data)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, 100)
      .map((entry) => ({
        name: entry.name,
        phase: entry.phase,
        startedAt: entry.startedAt,
        completedAt: entry.completedAt,
        error: entry.error,
        backupId: entry.manifestKey,
      }));
  }
  async restoreSource(
    databaseId: string,
    destinationId: string,
    name: string,
  ): Promise<ClusterDatabaseRestoreSource> {
    const index = await this.catalogue();
    const entry = decodeArchiveEntries(index?.data).find((item) => item.name === name);
    if (
      !entry ||
      entry.phase !== "completed" ||
      !entry.manifestKey ||
      !index?.data?.destinationPath
    )
      throw conflict("Choose a completed Redis backup before restoring.");
    return {
      format: "redis-rdb-set",
      databaseId,
      destinationId,
      backupName: name,
      backupId: entry.manifestKey,
      destinationPath: index.data.destinationPath,
      serverName: this.namespace,
      endpoint: index.data.endpoint || null,
    };
  }
  async pin(name: string, pinId: string, remove = false) {
    const path = `${this.base}/configmaps/${ARCHIVE_INDEX}`;
    if (remove && !(await this.catalogue())) return;
    await patchKubernetesObject(
      this.api,
      path,
      async (current) => {
        this.owned(current);
        const entries = decodeArchiveEntries(current.data);
        const entry = entries.find((item) => item.name === name);
        if (!remove && (!entry || entry.phase !== "completed"))
          throw conflict("The Redis archive is no longer available for recovery.");
        if (entry)
          entry.pins = remove
            ? (entry.pins ?? []).filter((value) => value !== pinId)
            : [...new Set([...(entry.pins ?? []), pinId])];
        await this.fence();
        return { data: { archives: encodeArchiveEntries(entries) } };
      },
      this.signal,
    );
  }
  async assertRemovable() {
    if (decodeArchiveEntries((await this.catalogue())?.data).some((entry) => entry.pins?.length))
      throw conflict(
        "Another database is still recovering from this database's backup. Finish or remove that recovery before removing its source.",
      );
  }
  async run(
    requestId: string,
    _generation: number,
    log: (message: string) => Promise<void>,
    pinId?: string,
  ) {
    if (!this.storage) throw conflict("Choose a backup destination for this database.");
    const archiveName = databaseArchiveName(requestId);
    if (
      decodeArchiveEntries((await this.catalogue())?.data).some(
        (entry) => entry.name === archiveName && entry.phase === "completed",
      )
    ) {
      await log("The saved backup already completed. Reusing its recovery point.");
      return;
    }
    const index = await this.prepare(this.storage);
    if (pinId)
      await patchKubernetesObject(
        this.api,
        `${this.base}/configmaps/${ARCHIVE_INDEX}`,
        async (current) => {
          this.owned(current);
          const entries = decodeArchiveEntries(current.data),
            entry = entries.find((item) => item.name === archiveName);
          if (entry?.error === "Archive retention cleanup in progress.")
            throw conflict("The saved copy was removed by its retention policy.");
          if (entry) entry.pins = [...new Set([...(entry.pins ?? []), pinId])];
          else
            entries.push({
              name: archiveName,
              phase: "running",
              startedAt: new Date().toISOString(),
              completedAt: null,
              error: null,
              manifestKey: null,
              pins: [pinId],
            });
          await this.fence();
          return { data: { archives: encodeArchiveEntries(entries) } };
        },
        this.signal,
      );
    const job = {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: this.metadata(`backup-${archiveName}`),
      spec: this.task(
        { ...this.configFor(index, this.storage), archiveName },
        "backup-destination",
      ),
    };
    const result = await runClusterJob(this.api, job, {
      signal: this.signal,
      fence: this.fence,
      retryFailed: true,
      log,
    });
    for (const line of result.output.trim().split("\n").filter(Boolean)) await log(line);
    if (
      !decodeArchiveEntries((await this.catalogue())?.data).some(
        (entry) => entry.name === archiveName && entry.phase === "completed",
      )
    )
      throw conflict("The database task finished without saving a completed backup record.");
  }
  async restore(
    source: ClusterDatabaseRestoreSource,
    storage: ClusterDatabaseBackupStorage,
    log: (message: string) => Promise<void>,
  ) {
    const index = await this.prepare(this.storage ?? storage);
    await this.secret("restore-destination", storage);
    const config: DatabaseTaskConfig = {
      ...this.configFor(index, storage),
      operation:
        source.format === "backup-artifact"
          ? "import-backup"
          : this.config.engine === "postgres"
            ? "postgres-restore"
            : "redis-restore",
      ...(source.artifact
        ? { artifact: source.artifact }
        : {
            source: {
              databaseId: source.databaseId,
              runtimeId: source.runtimeId ?? this.labels["openship.io/runtime"],
              manifestKey: source.backupId,
            },
          }),
    };
    if (index.data?.restored === restoreSignature(config)) {
      await log("This recovery request already completed. Keeping the recovered data.");
      return;
    }
    const result = await runClusterJob(
      this.api,
      {
        apiVersion: "batch/v1",
        kind: "Job",
        metadata: this.metadata("restore-data"),
        spec: this.task(config, "restore-destination"),
      },
      { signal: this.signal, fence: this.fence, retryFailed: true, log },
    );
    for (const line of result.output.trim().split("\n").filter(Boolean)) await log(line);
  }
}
export { DatabaseArchiveTasks as RedisArchive };
