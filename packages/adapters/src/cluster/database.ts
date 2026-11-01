import { createHash } from "node:crypto";
import {
  AppError,
  clusterDatabasePodCount,
  clusterPostgresVersion,
  validateClusterDatabase,
  type ClusterDatabaseConfig,
  type ClusterDatabaseObservation,
  type ClusterRuntimeHost,
  type ClusterDatabaseRestoreSource,
} from "@repo/core";
import { KubernetesApiError, type KubernetesApi, type KubernetesObject } from "./kubernetes-api";
import { clusterObject, installDatabaseAddon, waitForClusterResource } from "./database-addons";
import {
  listNamespaceResources,
  kubernetesProjectNamespace,
  projectNamespaceManifest,
} from "./namespace";
import {
  PostgresArchive,
  postgresObjectStore,
  type ClusterDatabaseBackupStorage,
} from "./database-backups";
import { kubernetesPodIssue, kubernetesPodPhase } from "./kubernetes-health";
import { kubernetesIdLabel } from "./kubernetes-label";
import { patchKubernetesObject } from "./kubernetes-mutation";
import { RedisArchive, DatabaseArchiveTasks } from "./redis-backups";
export type { ClusterDatabaseBackupStorage } from "./database-backups";

export const DATABASE_IMAGES = {
  postgres:
    "ghcr.io/cloudnative-pg/postgresql:17.11@sha256:70664ebcfa1100361b5bdc28bbf06fdbe08db2dc4ad7bd14de33c5e05fe8ea8e",
  redisSentinel:
    "quay.io/opstree/redis-sentinel:v7.4.11@sha256:9aae9fadd987a72684d5e75f92081bd4a3df81726e713b47a71df8bae861cda6",
  redis:
    "quay.io/opstree/redis:v7.4.11@sha256:115d8e221b1459b9f2db7d927ed40318ffac4eb2cddb5702974bce92d32b7a51",
} as const;
export const postgresDatabaseImage = (config: ClusterDatabaseConfig) =>
  clusterPostgresVersion(config) === "18"
    ? "ghcr.io/cloudnative-pg/postgresql:18.4@sha256:6138f19539304b585c6cafd1af82ca407f184139459a8e06f0880df4556d3588"
    : DATABASE_IMAGES.postgres;
export const clusterDatabaseNamespace = (id: string) =>
  `os-db-${createHash("sha256").update(id).digest("hex").slice(0, 24)}`;
export function clusterDatabaseHosts(id: string, config: ClusterDatabaseConfig) {
  const ns = clusterDatabaseNamespace(id);
  return {
    internalHost: `${config.engine === "postgres" ? "database-rw" : config.mode === "cluster" ? "database-leader" : config.mode === "replication" ? "database-master" : "database"}.${ns}.svc.cluster.local`,
    readOnlyHost:
      config.engine === "postgres" && config.mode === "cluster"
        ? `database-ro.${ns}.svc.cluster.local`
        : config.engine === "redis" && config.mode === "replication"
          ? `database-replica.${ns}.svc.cluster.local`
          : null,
  };
}
export function clusterDatabaseUrl(
  id: string,
  config: ClusterDatabaseConfig,
  password: string,
  target: "write" | "read" = "write",
) {
  const hosts = clusterDatabaseHosts(id, config);
  if (target === "read" && !hosts.readOnlyHost)
    throw new AppError(
      "Add PostgreSQL read replicas before choosing a reader connection.",
      422,
      "CLUSTER_DATABASE_READERS_REQUIRED",
    );
  const host = target === "read" ? hosts.readOnlyHost! : hosts.internalHost;
  return config.engine === "postgres"
    ? `postgresql://app:${encodeURIComponent(password)}@${host}:5432/${config.databaseName}?sslmode=require`
    : `redis://:${encodeURIComponent(password)}@${host}:6379`;
}
type DatabaseTarget = {
  id: string;
  projectId: string;
  runtimeId: string;
  generation: number;
  config: ClusterDatabaseConfig;
  hosts: Pick<ClusterRuntimeHost, "serverId" | "name" | "nodeName">[];
  backupStorage?: ClusterDatabaseBackupStorage;
  restoreSource?: ClusterDatabaseRestoreSource | null;
  /** Durable controller checkpoint: keep provenance without replaying imported data. */
  restoreCompleted?: boolean;
  restoreStorage?: ClusterDatabaseBackupStorage;
  consumerProjectIds?: () => Promise<readonly string[]>;
};
const managed = "openship.io/database";
const conflict = (message: string) =>
  new AppError(message, 409, "CLUSTER_DATABASE_RESOURCE_CONFLICT");

/** Operators own reconciliation, leader election and failover; this adapter only
 * declares the requested database and observes the operator's actual resources. */
export class ClusterDatabaseAdapter {
  readonly namespace: string;
  private readonly labels: Record<string, string>;
  readonly archive: PostgresArchive | RedisArchive;
  readonly dataTasks: DatabaseArchiveTasks;
  constructor(
    readonly api: KubernetesApi,
    readonly target: DatabaseTarget,
    readonly signal: AbortSignal,
    private readonly fence: () => Promise<void>,
  ) {
    this.namespace = clusterDatabaseNamespace(target.id);
    this.labels = {
      [managed]: target.id,
      "openship.io/project": kubernetesIdLabel(target.projectId),
      "openship.io/runtime": target.runtimeId,
    };
    this.dataTasks = new DatabaseArchiveTasks(
      api,
      this.namespace,
      this.labels,
      target.config,
      target.backupStorage,
      signal,
      fence,
      (path, object, update) => this.declare(path, object, update),
    );
    this.archive =
      target.config.engine === "redis"
        ? this.dataTasks
        : new PostgresArchive(
            api,
            this.namespace,
            this.labels,
            signal,
            fence,
            (path, object, update) => this.declare(path, object, update),
          );
  }
  private base() {
    return `/api/v1/namespaces/${this.namespace}`;
  }
  private crBase() {
    return this.target.config.engine === "postgres"
      ? `/apis/postgresql.cnpg.io/v1/namespaces/${this.namespace}/clusters`
      : `/apis/redis.redis.opstreelabs.in/v1beta2/namespaces/${this.namespace}/${this.target.config.mode === "cluster" ? "redisclusters" : this.target.config.mode === "replication" ? "redisreplications" : "redis"}`;
  }
  private metadata(name: string) {
    return { name, namespace: this.namespace, labels: this.labels };
  }
  private assertOwned(object: KubernetesObject, allowDeleting = false) {
    if (
      object.metadata.labels?.[managed] !== this.target.id ||
      object.metadata.labels?.["openship.io/project"] !==
        kubernetesIdLabel(this.target.projectId) ||
      object.metadata.labels?.["openship.io/runtime"] !== this.target.runtimeId ||
      (!allowDeleting && object.metadata.deletionTimestamp)
    )
      throw conflict(
        `${object.kind ?? "Resource"} ${object.metadata.name} has different ownership or is being removed. It was left unchanged.`,
      );
  }
  private async declare(path: string, object: KubernetesObject, update = false) {
    const full = `${path}/${object.metadata.name}`;
    const existing = await clusterObject(this.api, full, this.signal);
    if (existing) {
      this.assertOwned(existing);
      if (!update) return existing;
      return patchKubernetesObject(
        this.api,
        full,
        async (current) => {
          this.assertOwned(current);
          if (
            current.metadata.uid !== existing.metadata.uid ||
            Number(current.metadata.annotations?.["openship.io/generation"] ?? 0) >
              this.target.generation
          )
            throw conflict("A newer database operation has already updated this resource.");
          if (
            object.kind === "RedisReplication" &&
            object.spec.clusterSize < current.spec?.clusterSize
          )
            throw conflict(
              "Redis replication members cannot be removed in place yet. Restore a verified backup into a smaller database and switch its connection.",
            );
          await this.fence();
          return {
            ...object,
            metadata: {
              ...object.metadata,
              annotations: {
                ...object.metadata.annotations,
                "openship.io/generation": String(this.target.generation),
              },
            },
          };
        },
        this.signal,
      );
    }
    await this.fence();
    return this.api.request(
      "POST",
      path,
      {
        ...object,
        metadata: {
          ...object.metadata,
          annotations: {
            ...object.metadata.annotations,
            "openship.io/generation": String(this.target.generation),
          },
        },
      },
      this.signal,
    );
  }

  async preflight() {
    validateClusterDatabase(this.target.config);
    const version = await this.api.request<any>("GET", "/version", undefined, this.signal);
    const minor = Number(String(version.minor).replace(/\D/g, ""));
    if (
      this.target.config.engine === "postgres" &&
      (Number(version.major) !== 1 || minor < 34 || minor > 36)
    )
      throw new Error(
        "This PostgreSQL template supports Kubernetes 1.34–1.36. Update the server cluster before installing it.",
      );
    const nodes = await this.api.request<{ items: KubernetesObject[] }>(
      "GET",
      `/api/v1/nodes?labelSelector=${encodeURIComponent(`openship.io/runtime=${this.target.runtimeId}`)}`,
      undefined,
      this.signal,
    );
    const expected = new Set(this.target.hosts.map((host) => host.nodeName));
    const ready = nodes.items.filter(
      (node) =>
        expected.has(node.metadata.name!) &&
        !node.spec?.unschedulable &&
        !node.spec?.taints?.some((t: any) => ["NoSchedule", "NoExecute"].includes(t.effect)) &&
        node.status?.conditions?.some((c: any) => c.type === "Ready" && c.status === "True"),
    );
    const count = clusterDatabasePodCount(this.target.config);
    if (ready.length < count)
      throw new Error(
        `This database needs ${count} ready, schedulable servers to keep each data instance on a different server. ${ready.length} are available.`,
      );
    return ready;
  }
  async operators(log: (message: string) => Promise<void>) {
    await installDatabaseAddon(
      this.api,
      this.target.config.engine,
      this.target.runtimeId,
      this.signal,
      this.fence,
      log,
    );
  }
  async storage(log: (message: string) => Promise<void>) {
    const config = this.target.config;
    if (config.storageClass === "openship-local")
      await installDatabaseAddon(
        this.api,
        "local",
        this.target.runtimeId,
        this.signal,
        this.fence,
        log,
      );
    const storage = await clusterObject(
      this.api,
      `/apis/storage.k8s.io/v1/storageclasses/${config.storageClass}`,
      this.signal,
    );
    if (!storage)
      throw new Error(
        `Storage class ${config.storageClass} does not exist. Choose an installed storage class.`,
      );
    if (
      config.storageClass === "openship-local" &&
      (storage.provisioner !== "openship.io/local-path" || storage.reclaimPolicy !== "Retain")
    )
      throw conflict("The OpenShip storage class configuration changed.");
  }

  manifest(): KubernetesObject {
    const c = this.target.config;
    const resources = {
      requests: { cpu: `${c.cpuMillis}m`, memory: `${c.memoryMiB}Mi` },
      limits: { cpu: `${c.cpuMillis}m`, memory: `${c.memoryMiB}Mi` },
    };
    const selector = { "openship.io/runtime": this.target.runtimeId };
    if (c.engine === "postgres")
      return {
        apiVersion: "postgresql.cnpg.io/v1",
        kind: "Cluster",
        metadata: this.metadata("database"),
        spec: {
          instances: c.instances,
          imageName: postgresDatabaseImage(c),
          enableSuperuserAccess: false,
          bootstrap:
            this.target.restoreSource &&
            (!this.target.restoreSource.format ||
              this.target.restoreSource.format === "postgres-physical")
              ? {
                  recovery: {
                    source: "original",
                    database: c.databaseName,
                    owner: "app",
                    secret: { name: "credentials" },
                    recoveryTarget: {
                      backupID: this.target.restoreSource.backupId,
                      targetImmediate: true,
                    },
                  },
                }
              : {
                  initdb: {
                    database: c.databaseName,
                    owner: "app",
                    secret: { name: "credentials" },
                  },
                },
          ...(this.target.restoreSource &&
          (!this.target.restoreSource.format ||
            this.target.restoreSource.format === "postgres-physical") &&
          this.target.restoreStorage
            ? {
                externalClusters: [
                  {
                    name: "original",
                    barmanObjectStore: postgresObjectStore(
                      this.target.restoreStorage,
                      this.target.restoreSource.serverName,
                      "restore-destination",
                    ),
                  },
                ],
              }
            : {}),
          ...(c.backup && this.target.backupStorage
            ? {
                backup: {
                  retentionPolicy: `${c.backup.retentionDays}d`,
                  barmanObjectStore: postgresObjectStore(
                    this.target.backupStorage,
                    this.namespace,
                    "backup-destination",
                  ),
                },
              }
            : {}),
          storage: { size: `${c.storageGiB}Gi`, storageClass: c.storageClass },
          resources,
          inheritedMetadata: { labels: this.labels },
          affinity: {
            enablePodAntiAffinity: true,
            podAntiAffinityType: "required",
            topologyKey: "kubernetes.io/hostname",
            nodeSelector: selector,
          },
          enablePDB: true,
          primaryUpdateStrategy: "unsupervised",
          ...(c.mode === "cluster"
            ? {
                postgresql: {
                  synchronous: { method: "any", number: 1, dataDurability: "required" },
                },
              }
            : {}),
        },
      };
    const affinity = {
      nodeAffinity: {
        requiredDuringSchedulingIgnoredDuringExecution: {
          nodeSelectorTerms: [
            {
              matchExpressions: [
                { key: "openship.io/runtime", operator: "In", values: [this.target.runtimeId] },
              ],
            },
          ],
        },
      },
      podAntiAffinity: {
        requiredDuringSchedulingIgnoredDuringExecution: [
          {
            labelSelector: {
              // Backups and verification Jobs share database ownership, but
              // must be able to run alongside its data pods on a full cluster.
              matchLabels: {
                [managed]: this.target.id,
                redis_setup_type:
                  c.mode === "cluster"
                    ? "cluster"
                    : c.mode === "replication"
                      ? "replication"
                      : "standalone",
              },
            },
            topologyKey: "kubernetes.io/hostname",
          },
        ],
      },
    };
    const claim = {
      metadata: { labels: this.labels },
      spec: {
        storageClassName: c.storageClass,
        accessModes: ["ReadWriteOnce"],
        resources: { requests: { storage: `${c.storageGiB}Gi` } },
      },
    };
    return {
      apiVersion: "redis.redis.opstreelabs.in/v1beta2",
      kind:
        c.mode === "cluster"
          ? "RedisCluster"
          : c.mode === "replication"
            ? "RedisReplication"
            : "Redis",
      metadata: this.metadata("database"),
      spec: {
        kubernetesConfig: {
          image: DATABASE_IMAGES.redis,
          imagePullPolicy: "IfNotPresent",
          // The operator copies CR annotations into its pod templates. Keep
          // OpenShip's stale-operation fence on the CR without rolling every
          // existing data pod while a partition resize is in progress.
          ignoreAnnotations: ["openship.io/generation"],
          resources,
          redisSecret: { name: "credentials", key: "password" },
          persistentVolumeClaimRetentionPolicy: { whenDeleted: "Retain", whenScaled: "Retain" },
        },
        podSecurityContext: { runAsUser: 1000, fsGroup: 1000 },
        persistenceEnabled: true,
        storage: {
          volumeClaimTemplate: claim,
          keepAfterDelete: true,
          ...(c.mode === "cluster"
            ? {
                nodeConfVolume: true,
                nodeConfVolumeClaimTemplate: {
                  ...claim,
                  spec: { ...claim.spec, resources: { requests: { storage: "128Mi" } } },
                },
              }
            : {}),
        },
        ...(c.mode === "cluster"
          ? {
              clusterSize: c.instances,
              clusterVersion: "v7",
              redisLeader: { affinity, pdb: { enabled: true, minAvailable: c.instances - 1 } },
              redisFollower: { affinity, pdb: { enabled: true, minAvailable: c.instances - 1 } },
            }
          : {
              affinity,
              nodeSelector: selector,
              ...(c.mode === "replication"
                ? {
                    clusterSize: c.instances,
                    pdb: { enabled: true, minAvailable: c.instances - 1 },
                  }
                : {}),
            }),
      },
    };
  }

  /** The separate operator resource keeps role reconciliation active during a
   * data-node outage. Embedded Sentinel waits for every Redis pod to be ready. */
  sentinelManifest(): KubernetesObject {
    const sentinelAffinity = {
      nodeAffinity: {
        requiredDuringSchedulingIgnoredDuringExecution: {
          nodeSelectorTerms: [
            {
              matchExpressions: [
                { key: "openship.io/runtime", operator: "In", values: [this.target.runtimeId] },
              ],
            },
          ],
        },
      },
      podAntiAffinity: {
        requiredDuringSchedulingIgnoredDuringExecution: [
          {
            labelSelector: {
              matchLabels: { [managed]: this.target.id, redis_setup_type: "sentinel" },
            },
            topologyKey: "kubernetes.io/hostname",
          },
        ],
      },
    };
    return {
      apiVersion: "redis.redis.opstreelabs.in/v1beta2",
      kind: "RedisSentinel",
      metadata: this.metadata("database"),
      spec: {
        clusterSize: 3,
        podSecurityContext: { runAsUser: 1000, fsGroup: 1000 },
        nodeSelector: { "openship.io/runtime": this.target.runtimeId },
        affinity: sentinelAffinity,
        pdb: { enabled: true, minAvailable: 2 },
        redisSentinelConfig: {
          redisReplicationName: "database",
          masterGroupName: "mymaster",
          quorum: "2",
          redisReplicationPassword: { secretKeyRef: { name: "credentials", key: "password" } },
        },
        kubernetesConfig: {
          image: DATABASE_IMAGES.redisSentinel,
          imagePullPolicy: "IfNotPresent",
          ignoreAnnotations: ["openship.io/generation"],
          redisSecret: { name: "credentials", key: "password" },
          resources: {
            requests: { cpu: "100m", memory: "128Mi" },
            limits: { cpu: "250m", memory: "256Mi" },
          },
        },
      },
    };
  }

  /** Keep private access limited to the owner and explicit consumers. */
  async reconcileConnections(consumerProjectIds: readonly string[]) {
    await this.fence();
    const namespace = await clusterObject(this.api, this.base(), this.signal);
    if (!namespace) throw conflict("The database namespace is unavailable. Retry database setup.");
    this.assertOwned(namespace);
    const c = this.target.config;
    const fromNamespace = (name: string) => ({
      namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": name } },
    });
    await this.declare(
      `/apis/networking.k8s.io/v1/namespaces/${this.namespace}/networkpolicies`,
      {
        apiVersion: "networking.k8s.io/v1",
        kind: "NetworkPolicy",
        metadata: this.metadata("database-ingress"),
        spec: {
          podSelector: {},
          policyTypes: ["Ingress"],
          ingress: [
            { from: [{ podSelector: {} }] },
            {
              from: [
                fromNamespace(kubernetesProjectNamespace(this.target.projectId)),
                ...[...new Set(consumerProjectIds)]
                  .filter((projectId) => projectId !== this.target.projectId)
                  .sort()
                  .map((projectId) => ({
                    ...fromNamespace(kubernetesProjectNamespace(projectId)),
                    podSelector: {
                      matchLabels: {
                        "openship.io/project": kubernetesIdLabel(projectId),
                        "openship.io/runtime": this.target.runtimeId,
                      },
                    },
                  })),
              ],
              ports: [{ protocol: "TCP", port: c.engine === "postgres" ? 5432 : 6379 }],
            },
            {
              from: [fromNamespace(c.engine === "postgres" ? "cnpg-system" : "ot-operators")],
              ports: (c.engine === "postgres"
                ? [5432, 8000]
                : c.mode === "replication"
                  ? [6379, 26379]
                  : [6379, 16379]
              ).map((port) => ({
                protocol: "TCP",
                port,
              })),
            },
            ...(c.engine === "redis" && c.mode === "replication"
              ? [
                  {
                    // Sentinel has no public client endpoint: only the scoped
                    // connection-check Job may verify quorum from the app namespace.
                    from: [
                      {
                        ...fromNamespace(kubernetesProjectNamespace(this.target.projectId)),
                        podSelector: {
                          matchLabels: { ...this.labels, "openship.io/database-probe": "true" },
                        },
                      },
                    ],
                    ports: [{ protocol: "TCP", port: 26379 }],
                  },
                ]
              : []),
          ],
        },
      },
      true,
    );
  }

  async apply(password: string) {
    if (this.target.config.backup && !this.target.backupStorage)
      throw new Error("The database backup destination could not be loaded.");
    if (
      this.target.restoreSource &&
      (!this.target.restoreCompleted ||
        !this.target.restoreSource.format ||
        this.target.restoreSource.format === "postgres-physical") &&
      !this.target.restoreStorage
    )
      throw new Error("The original backup destination could not be loaded for recovery.");
    await this.declare("/api/v1/namespaces", {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        name: this.namespace,
        labels: { ...this.labels, "pod-security.kubernetes.io/enforce": "baseline" },
      },
    });
    await this.reconcileConnections((await this.target.consumerProjectIds?.()) ?? []);
    const c = this.target.config;
    const secret = {
      username: Buffer.from("app").toString("base64"),
      password: Buffer.from(password).toString("base64"),
    };
    const existing = await this.declare(`${this.base()}/secrets`, {
      apiVersion: "v1",
      kind: "Secret",
      metadata: this.metadata("credentials"),
      type: c.engine === "postgres" ? "kubernetes.io/basic-auth" : "Opaque",
      data: secret,
    });
    if (existing.data?.password !== secret.password)
      throw conflict(
        "The database credentials changed outside OpenShip. Restore the saved credential before retrying.",
      );
    if (this.target.backupStorage)
      await this.archive.secret("backup-destination", this.target.backupStorage);
    if (this.target.restoreStorage)
      await this.archive.secret("restore-destination", this.target.restoreStorage);
    const old = await clusterObject(this.api, `${this.crBase()}/database`, this.signal);
    if (old && old.spec?.storage?.size !== `${c.storageGiB}Gi` && c.engine === "postgres") {
      const storage = await this.api.request(
        "GET",
        `/apis/storage.k8s.io/v1/storageclasses/${c.storageClass}`,
        undefined,
        this.signal,
      );
      if (!storage.allowVolumeExpansion)
        throw new Error("This storage class does not support online volume expansion.");
    }
    if (old && c.engine === "postgres" && c.instances === 1 && Number(old.spec?.instances) > 1)
      await this.assertNoApplicationReferences(
        [
          clusterDatabaseHosts(this.target.id, {
            ...c,
            mode: "cluster",
            instances: Number(old.spec.instances),
          }).readOnlyHost!,
        ],
        "reader",
      );
    const desired = this.manifest();
    if (old && c.engine === "postgres" && c.mode === "standalone") {
      // Merge Patch retains omitted properties: explicitly clear the previous
      // synchronous policy so a sole primary cannot wait for removed readers.
      // Null is a patch deletion instruction, not part of a new Cluster spec.
      desired.spec.postgresql = { ...desired.spec.postgresql, synchronous: null };
    }
    await this.declare(this.crBase(), desired, true);
    if (c.engine === "redis" && c.mode === "replication")
      await this.declare(
        `/apis/redis.redis.opstreelabs.in/v1beta2/namespaces/${this.namespace}/redissentinels`,
        this.sentinelManifest(),
        true,
      );
    if (c.backup && !this.target.restoreSource) await this.archive.schedule(c.backup);
  }

  async needsRedisResize() {
    if (this.target.config.engine !== "redis" || this.target.config.mode !== "cluster")
      return false;
    const current = await clusterObject(this.api, `${this.crBase()}/database`, this.signal);
    if (!current) return false;
    this.assertOwned(current);
    return current.spec.clusterSize !== this.target.config.instances;
  }

  async backupBeforeRedisResize(log: (message: string) => Promise<void>) {
    if (!(this.archive instanceof RedisArchive) || !this.target.backupStorage)
      throw conflict("Configure a backup destination before moving Redis data.");
    const current = await this.api.request(
      "GET",
      `${this.crBase()}/database`,
      undefined,
      this.signal,
    );
    this.assertOwned(current);
    if (
      current.status?.state !== "Ready" ||
      current.status.readyLeaderReplicas !== current.spec.clusterSize ||
      current.status.readyFollowerReplicas !== current.spec.clusterSize
    )
      throw conflict(
        "Wait for all Redis instances and replicas to recover before changing its data partitions.",
      );
    await this.archive.secret("backup-destination", this.target.backupStorage);
    await this.archive.run(`before-resize-${this.target.generation}`, this.target.generation, log);
  }

  async restore(log: (message: string) => Promise<void>) {
    if (
      this.target.restoreCompleted ||
      !this.target.restoreSource ||
      !["redis-rdb-set", "postgres-logical", "backup-artifact"].includes(
        this.target.restoreSource.format ?? "",
      )
    )
      return;
    if (!this.target.restoreStorage)
      throw conflict("The saved recovery destination is unavailable.");
    await this.dataTasks.restore(this.target.restoreSource, this.target.restoreStorage, log);
  }

  async releaseRestorePin() {
    const source = this.target.restoreSource;
    if (
      !source ||
      !["redis-rdb-set", "postgres-logical"].includes(source.format ?? "") ||
      !source.pinId
    )
      return;
    const archive = new RedisArchive(
      this.api,
      clusterDatabaseNamespace(source.databaseId),
      { ...this.labels, [managed]: source.databaseId },
      this.target.config,
      undefined,
      this.signal,
      this.fence,
      (path, object, update) => this.declare(path, object, update),
    );
    await archive.pin(source.backupName, source.pinId, true);
  }

  async observe(): Promise<ClusterDatabaseObservation> {
    const namespace = await clusterObject(
      this.api,
      `/api/v1/namespaces/${this.namespace}`,
      this.signal,
    );
    if (!namespace)
      return {
        ready: false,
        observedAt: new Date().toISOString(),
        primary: null,
        message: "No database namespace remains on the cluster.",
        pods: [],
        volumes: [],
      };
    this.assertOwned(namespace);
    const root = await clusterObject(this.api, `${this.crBase()}/database`, this.signal);
    if (root) this.assertOwned(root);
    const [pods, claims] = await Promise.all([
      this.api.request<{ items: KubernetesObject[] }>(
        "GET",
        `${this.base()}/pods`,
        undefined,
        this.signal,
      ),
      this.api.request<{ items: KubernetesObject[] }>(
        "GET",
        `${this.base()}/persistentvolumeclaims`,
        undefined,
        this.signal,
      ),
    ]);
    const current = this.target.config;
    const ownedPods = pods.items.filter(
      (pod) =>
        !pod.metadata.deletionTimestamp &&
        pod.metadata.labels?.[managed] === this.target.id &&
        !pod.metadata.labels?.["openship.io/database-probe"],
    );
    const memberPods = ownedPods.filter(
      (pod) => !pod.metadata.ownerReferences?.some((owner) => owner.kind === "Job"),
    );
    const sentinelPods = memberPods.filter(
      (pod) => pod.metadata.labels?.redis_setup_type === "sentinel",
    );
    const dataPods = memberPods.filter(
      (pod) => pod.metadata.labels?.redis_setup_type !== "sentinel",
    );
    const ready = dataPods.filter((pod) =>
      pod.status?.conditions?.some(
        (condition: any) => condition.type === "Ready" && condition.status === "True",
      ),
    );
    const primary =
      current.engine === "redis" && current.mode === "replication"
        ? (root?.status?.masterNode ?? null)
        : (root?.status?.currentPrimary ?? null);
    const engineReady =
      current.engine === "postgres"
        ? root?.status?.readyInstances === current.instances &&
          !!primary &&
          root?.status?.phase === "Cluster in healthy state"
        : current.mode === "cluster"
          ? root?.status?.state === "Ready" &&
            root.status.readyLeaderReplicas === current.instances &&
            root.status.readyFollowerReplicas === current.instances
          : current.mode === "replication"
            ? !!primary &&
              dataPods.some((pod) => pod.metadata.name === primary) &&
              sentinelPods.length === 3 &&
              sentinelPods.every((pod) =>
                pod.status?.conditions?.some(
                  (condition: any) => condition.type === "Ready" && condition.status === "True",
                ),
              ) &&
              new Set(sentinelPods.map((pod) => pod.spec?.nodeName)).size === 3
            : ready.length === 1;
    const volumes = claims.items
      .filter((claim) => claim.metadata.labels?.[managed] === this.target.id)
      .map((claim) => ({
        name: claim.metadata.name!,
        phase: claim.status?.phase ?? "Pending",
        capacity: claim.status?.capacity?.storage ?? null,
      }));
    const count = clusterDatabasePodCount(current);
    const distinct = new Set(ready.map((pod) => pod.spec?.nodeName)).size === count;
    const healthy =
      !!engineReady &&
      ready.length === count &&
      distinct &&
      volumes.length >= count &&
      volumes.every((volume) => volume.phase === "Bound");
    const waiting = ownedPods.map(kubernetesPodIssue).filter(Boolean);
    const archiveCondition = root?.status?.conditions?.find(
      (condition: any) => condition.type === "ContinuousArchiving",
    );
    const backups = current.backup ? await this.archive.list() : undefined;
    return {
      ready: healthy,
      observedAt: new Date().toISOString(),
      primary,
      message: healthy
        ? "Database instances and persistent volumes are ready on separate servers."
        : String(
            waiting[0] ??
              root?.status?.reason ??
              root?.status?.phase ??
              "Waiting for the database operator, persistent volumes and healthy instances.",
          ),
      volumes,
      ...(current.backup
        ? {
            backups,
            archive:
              current.engine === "redis"
                ? {
                    healthy:
                      backups?.[0]?.phase === "completed"
                        ? true
                        : backups?.[0]?.phase === "failed"
                          ? false
                          : null,
                    message:
                      backups?.[0]?.error ??
                      (backups?.[0]?.phase === "completed"
                        ? "Redis data snapshots are saved at the backup destination."
                        : "Waiting for the first completed data backup."),
                    lastSuccessfulBackup:
                      backups?.find((backup) => backup.phase === "completed")?.completedAt ?? null,
                  }
                : {
                    healthy: archiveCondition ? archiveCondition.status === "True" : null,
                    message: archiveCondition?.message ?? "Waiting for the first archive check.",
                    lastSuccessfulBackup: root?.status?.lastSuccessfulBackup ?? null,
                  },
          }
        : {}),
      pods: memberPods.map((pod) => {
        const host = this.target.hosts.find((item) => item.nodeName === pod.spec?.nodeName);
        // Redis's StatefulSet labels describe its original group, not its
        // elected role after failover. Do not present those as live leadership.
        return {
          name: pod.metadata.name!,
          nodeName: pod.spec?.nodeName ?? null,
          serverId: host?.serverId ?? null,
          serverName: host?.name ?? null,
          role:
            current.engine === "postgres" || current.mode === "replication"
              ? pod.metadata.labels?.redis_setup_type === "sentinel"
                ? "sentinel"
                : pod.metadata.name === primary
                  ? "primary"
                  : "replica"
              : current.mode === "cluster"
                ? "member"
                : "standalone",
          ready:
            pod.status?.conditions?.some(
              (condition: any) => condition.type === "Ready" && condition.status === "True",
            ) ?? false,
          phase: kubernetesPodPhase(pod),
          restarts: (pod.status?.containerStatuses ?? []).reduce(
            (sum: number, status: any) => sum + (status.restartCount ?? 0),
            0,
          ),
        };
      }),
    };
  }

  async verify(
    log: (message: string) => Promise<void>,
    purpose = "ready",
  ): Promise<ClusterDatabaseObservation> {
    let last = "";
    await waitForClusterResource(
      this.signal,
      async () => {
        const view = await this.observe();
        if (view.message !== last) {
          last = view.message;
          await log(last);
        }
        return view.ready ? view : null;
      },
      "database instances and storage",
      900_000,
    );
    const c = this.target.config;
    // Test the actual application's namespace, including its DNS path and the
    // database ingress policy. A same-namespace probe would miss policy errors.
    const projectNamespace = projectNamespaceManifest(this.target.projectId, this.target.runtimeId);
    const appNamespace = projectNamespace.metadata.name!;
    let existingNamespace = await clusterObject(
      this.api,
      `/api/v1/namespaces/${appNamespace}`,
      this.signal,
    );
    if (!existingNamespace) {
      await this.fence();
      try {
        existingNamespace = await this.api.request(
          "POST",
          "/api/v1/namespaces",
          projectNamespace,
          this.signal,
        );
      } catch (error) {
        if (!(error instanceof KubernetesApiError) || error.statusCode !== 409) throw error;
        existingNamespace = await this.api.request(
          "GET",
          `/api/v1/namespaces/${appNamespace}`,
          undefined,
          this.signal,
        );
      }
    }
    if (
      !existingNamespace ||
      existingNamespace.metadata.deletionTimestamp ||
      Object.entries(projectNamespace.metadata.labels!).some(
        ([key, value]) => existingNamespace!.metadata.labels?.[key] !== value,
      )
    )
      throw conflict("The application namespace has different ownership or is being removed.");
    const name = `db-${this.namespace.slice(6)}-verify-${this.target.generation}-${purpose}`;
    const labels = {
      ...this.labels,
      "app.kubernetes.io/managed-by": "openship",
      "openship.io/database-probe": "true",
    };
    const metadata = { name, namespace: appNamespace, labels };
    const credentials = await this.api.request(
      "GET",
      `${this.base()}/secrets/credentials`,
      undefined,
      this.signal,
    );
    this.assertOwned(credentials);
    await this.declare(`/api/v1/namespaces/${appNamespace}/secrets`, {
      apiVersion: "v1",
      kind: "Secret",
      metadata,
      data: { password: credentials.data.password },
    });
    const host = clusterDatabaseHosts(this.target.id, c).internalHost;
    const password = { secretKeyRef: { name, key: "password" } };
    const env =
      c.engine === "postgres"
        ? [
            { name: "PGPASSWORD", valueFrom: password },
            { name: "PGHOST", value: host },
            { name: "PGUSER", value: "app" },
            { name: "PGDATABASE", value: c.databaseName },
            { name: "PGSSLMODE", value: "require" },
            { name: "PGCONNECT_TIMEOUT", value: "10" },
          ]
        : [{ name: "REDISCLI_AUTH", valueFrom: password }];
    const redisChecks = [`test "$(timeout 10 redis-cli -h ${host} PING)" = PONG`];
    if (c.mode === "cluster")
      redisChecks.push(
        `timeout 30 redis-cli --cluster check ${host}:6379`,
        `timeout 10 redis-cli -h ${host} CLUSTER INFO | tr -d '\\r' | grep -qx 'cluster_state:ok'`,
        `timeout 10 redis-cli -h ${host} CLUSTER INFO | tr -d '\\r' | grep -qx 'cluster_slots_assigned:16384'`,
      );
    if (c.engine === "redis" && c.mode === "replication")
      redisChecks.push(
        `timeout 10 redis-cli -h ${host} INFO replication | tr -d '\\r' | grep -qx 'role:master'`,
        `timeout 10 redis-cli -h ${host} INFO replication | tr -d '\\r' | grep -qx 'connected_slaves:${c.instances - 1}'`,
        `timeout 15 redis-cli -h ${host} WAIT ${c.instances - 1} 10000 | grep -qx '${c.instances - 1}'`,
        `timeout 10 redis-cli -h database-sentinel.${this.namespace}.svc.cluster.local -p 26379 SENTINEL CKQUORUM mymaster | grep -q '^OK '`,
      );
    const check =
      c.engine === "postgres"
        ? "test \"$(psql -X -A -t -c 'SELECT 1')\" = 1"
        : redisChecks.join(" && ");
    // Service endpoints can lag pod readiness. Retry only these read-only
    // protocol checks, within a bounded Job; never recreate the database.
    const command = [
      "sh",
      "-ec",
      `attempt=0; while [ "$attempt" -lt 30 ]; do if ${check}; then exit 0; fi; attempt=$((attempt + 1)); sleep 2; done; echo 'Private database connection did not become ready.' >&2; exit 1`,
    ];
    const jobPath = `/apis/batch/v1/namespaces/${appNamespace}/jobs`;
    const job = await this.declare(jobPath, {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata,
      spec: {
        backoffLimit: 0,
        activeDeadlineSeconds: 600,
        ttlSecondsAfterFinished: 3600,
        template: {
          metadata: { labels },
          spec: {
            restartPolicy: "Never",
            automountServiceAccountToken: false,
            nodeSelector: { "openship.io/runtime": this.target.runtimeId },
            containers: [
              {
                name: "check",
                image: DATABASE_IMAGES[c.engine],
                command,
                env,
                resources: {
                  requests: { cpu: "50m", memory: "64Mi" },
                  limits: { cpu: "250m", memory: "128Mi" },
                },
              },
            ],
          },
        },
      },
    });
    const secret = await this.api.request(
      "GET",
      `/api/v1/namespaces/${appNamespace}/secrets/${name}`,
      undefined,
      this.signal,
    );
    this.assertOwned(secret);
    await this.fence();
    await this.api.request(
      "PATCH",
      `/api/v1/namespaces/${appNamespace}/secrets/${name}`,
      {
        metadata: {
          resourceVersion: secret.metadata.resourceVersion,
          ownerReferences: [{ apiVersion: "batch/v1", kind: "Job", name, uid: job.metadata.uid }],
        },
      },
      this.signal,
    );
    await waitForClusterResource(
      this.signal,
      async () => {
        const job = await this.api.request("GET", `${jobPath}/${name}`, undefined, this.signal);
        if (job.status?.failed) {
          const pods = await this.api.request<{ items: KubernetesObject[] }>(
            "GET",
            `/api/v1/namespaces/${appNamespace}/pods?labelSelector=${encodeURIComponent(`job-name=${name}`)}`,
            undefined,
            this.signal,
          );
          let detail = String(
            job.status.conditions?.find((item: any) => item.type === "Failed")?.message ?? "",
          );
          for (const pod of pods.items) {
            for await (const line of this.api.logs(
              `/api/v1/namespaces/${appNamespace}/pods/${pod.metadata.name}/log?tailLines=12`,
              this.signal,
            ))
              detail = (detail + "\n" + line).slice(-3000);
          }
          throw new Error(
            `The private database connection check failed: ${detail || "No protocol response was received."} The database and its volumes were kept.`,
          );
        }
        return job.status?.succeeded ? job : null;
      },
      "an authenticated database connection from the application",
      620_000,
    );
    await log(
      c.engine === "postgres"
        ? "An authenticated PostgreSQL query succeeded from the application's private namespace."
        : c.mode === "cluster"
          ? "Authenticated Redis connectivity from the application and all 16384 cluster slots passed."
          : "An authenticated Redis PING succeeded from the application's private namespace.",
    );
    return this.observe();
  }

  async remove(deleteData: boolean, log: (message: string) => Promise<void> = async () => {}) {
    const namespace = await clusterObject(
      this.api,
      `/api/v1/namespaces/${this.namespace}`,
      this.signal,
    );
    if (!namespace) return;
    await this.assertNoApplicationReferences();
    await this.dataTasks.assertRemovable();
    await this.removeProbes();
    if (namespace.metadata.deletionTimestamp) {
      if (!deleteData)
        throw conflict(
          "Permanent database removal has already started. Retry that removal to finish cleanup.",
        );
      await this.waitForNamespaceRemoval(log);
      return;
    }
    this.assertOwned(namespace);
    if (this.target.config.backup) await this.archive.suspend();
    const claims = await this.api.request<{ items: KubernetesObject[] }>(
      "GET",
      `${this.base()}/persistentvolumeclaims`,
      undefined,
      this.signal,
    );
    // Detach controller references before deleting the CR. Even an operator's
    // garbage collector must not remove data on the default "keep data" path.
    for (const claim of claims.items) {
      if (claim.metadata.labels?.[managed] !== this.target.id)
        throw conflict(`Volume ${claim.metadata.name} has unknown ownership and was kept.`);
      if (claim.spec?.volumeName) {
        const pv = await this.api.request(
          "GET",
          `/api/v1/persistentvolumes/${claim.spec.volumeName}`,
          undefined,
          this.signal,
        );
        if (pv.spec?.claimRef?.uid !== claim.metadata.uid)
          throw conflict("A database volume changed ownership. Removal stopped.");
        await this.fence();
        await this.api.request(
          "PATCH",
          `/api/v1/persistentvolumes/${pv.metadata.name}`,
          {
            metadata: { resourceVersion: pv.metadata.resourceVersion },
            spec: { persistentVolumeReclaimPolicy: deleteData ? "Delete" : "Retain" },
          },
          this.signal,
        );
      }
      await this.fence();
      await this.api.request(
        "PATCH",
        `${this.base()}/persistentvolumeclaims/${claim.metadata.name}`,
        { metadata: { resourceVersion: claim.metadata.resourceVersion, ownerReferences: [] } },
        this.signal,
      );
    }
    if (this.target.config.engine === "redis" && this.target.config.mode === "replication") {
      const path = `/apis/redis.redis.opstreelabs.in/v1beta2/namespaces/${this.namespace}/redissentinels/database`;
      const sentinel = await clusterObject(this.api, path, this.signal);
      if (sentinel) {
        this.assertOwned(sentinel, true);
        if (!sentinel.metadata.deletionTimestamp) {
          await this.fence();
          await this.api.request(
            "DELETE",
            path,
            {
              propagationPolicy: "Foreground",
              preconditions: {
                uid: sentinel.metadata.uid,
                resourceVersion: sentinel.metadata.resourceVersion,
              },
            },
            this.signal,
          );
        }
        await waitForClusterResource(
          this.signal,
          async () => ((await clusterObject(this.api, path, this.signal)) ? null : true),
          "Redis Sentinel shutdown",
        );
      }
    }
    const root = await clusterObject(this.api, `${this.crBase()}/database`, this.signal);
    if (root) {
      if (root.metadata.labels?.[managed] !== this.target.id)
        throw conflict("The database resource changed ownership.");
      if (!root.metadata.deletionTimestamp) {
        await this.fence();
        await this.api.request(
          "DELETE",
          `${this.crBase()}/database`,
          {
            propagationPolicy: "Foreground",
            preconditions: {
              uid: root.metadata.uid,
              resourceVersion: root.metadata.resourceVersion,
            },
          },
          this.signal,
        );
      }
      await waitForClusterResource(
        this.signal,
        async () =>
          (await clusterObject(this.api, `${this.crBase()}/database`, this.signal)) ? null : true,
        "database shutdown",
      );
    }
    if (!deleteData) return;
    // Remove only verified claims. Keep the owned namespace and credentials if
    // other objects remain; no broad namespace deletion can erase foreign data.
    for (const claim of claims.items) {
      const current = await clusterObject(
        this.api,
        `${this.base()}/persistentvolumeclaims/${claim.metadata.name}`,
        this.signal,
      );
      if (!current) continue;
      if (
        current.metadata.uid !== claim.metadata.uid ||
        current.metadata.labels?.[managed] !== this.target.id
      )
        throw conflict("A database volume changed during removal.");
      await this.fence();
      await this.api.request(
        "DELETE",
        `${this.base()}/persistentvolumeclaims/${current.metadata.name}`,
        {
          preconditions: {
            uid: current.metadata.uid,
            resourceVersion: current.metadata.resourceVersion,
          },
        },
        this.signal,
      );
      await waitForClusterResource(
        this.signal,
        async () =>
          (await clusterObject(
            this.api,
            `${this.base()}/persistentvolumeclaims/${current.metadata.name}`,
            this.signal,
          ))
            ? null
            : true,
        "database volume removal",
      );
      if (claim.spec?.volumeName)
        await waitForClusterResource(
          this.signal,
          async () =>
            (await clusterObject(
              this.api,
              `/api/v1/persistentvolumes/${claim.spec.volumeName}`,
              this.signal,
            ))
              ? null
              : true,
          "storage reclamation",
        );
    }
    const secret = await clusterObject(this.api, `${this.base()}/secrets/credentials`, this.signal);
    if (secret) {
      this.assertOwned(secret);
      await this.fence();
      await this.api.request(
        "DELETE",
        `${this.base()}/secrets/credentials`,
        { preconditions: { uid: secret.metadata.uid } },
        this.signal,
      );
    }
    const objects = await listNamespaceResources(this.api, this.namespace, this.signal);
    const safeKinds = new Set([
      "Secret",
      "ConfigMap",
      "NetworkPolicy",
      "Service",
      "Endpoints",
      "EndpointSlice",
      "ServiceAccount",
      "Role",
      "RoleBinding",
      "Job",
      "Pod",
      "PodDisruptionBudget",
      "Backup",
      "ScheduledBackup",
      "CronJob",
    ]);
    const accepted = new Set<string>();
    for (const object of objects) {
      const automatic =
        (object.kind === "ConfigMap" && object.metadata.name === "kube-root-ca.crt") ||
        (object.kind === "ServiceAccount" && object.metadata.name === "default");
      if (
        automatic ||
        (safeKinds.has(object.kind!) && object.metadata.labels?.[managed] === this.target.id)
      )
        accepted.add(object.metadata.uid!);
    }
    for (let pass = 0; pass < objects.length; pass++) {
      let added = false;
      for (const object of objects)
        if (
          !accepted.has(object.metadata.uid!) &&
          safeKinds.has(object.kind!) &&
          object.metadata.ownerReferences?.some((owner) => accepted.has(owner.uid))
        ) {
          accepted.add(object.metadata.uid!);
          added = true;
        }
      if (!added) break;
    }
    const foreign = objects.find((object) => !accepted.has(object.metadata.uid!));
    if (foreign)
      throw conflict(
        `The database namespace contains ${foreign.kind} ${foreign.metadata.name} with unknown ownership. It was kept; removal can be retried after resolving this resource.`,
      );
    await this.fence();
    await this.api.request(
      "DELETE",
      `/api/v1/namespaces/${this.namespace}`,
      { propagationPolicy: "Foreground", preconditions: { uid: namespace.metadata.uid } },
      this.signal,
    );
    await this.waitForNamespaceRemoval(log);
  }

  private async assertNoApplicationReferences(
    hosts: readonly string[] = Object.values(
      clusterDatabaseHosts(this.target.id, this.target.config),
    ).filter(Boolean) as string[],
    purpose: "database" | "reader" = "database",
  ) {
    // A disconnected consumer can still have an old running release. Inspect
    // managed application namespaces on this runtime, not only current links.
    const selector = encodeURIComponent(
      `app.kubernetes.io/managed-by=openship,openship.io/runtime=${this.target.runtimeId}`,
    );
    const namespaces = await this.api.request<{ items: KubernetesObject[] }>(
      "GET",
      `/api/v1/namespaces?labelSelector=${selector}`,
      undefined,
      this.signal,
    );
    if (!Array.isArray(namespaces.items))
      throw new Error("Could not verify the cluster's application references.");
    const names = namespaces.items
      .filter(
        (namespace) =>
          /^os-[a-f0-9]{24}$/.test(namespace.metadata.name ?? "") &&
          namespace.metadata.labels?.["app.kubernetes.io/managed-by"] === "openship" &&
          namespace.metadata.labels?.["openship.io/runtime"] === this.target.runtimeId &&
          !!namespace.metadata.labels?.["openship.io/project"],
      )
      .map((namespace) => namespace.metadata.name!);
    for (const appNamespace of names) {
      const [deployments, secrets, pods] = await Promise.all([
        this.api.request<{ items: KubernetesObject[] }>(
          "GET",
          `/apis/apps/v1/namespaces/${appNamespace}/deployments`,
          undefined,
          this.signal,
        ),
        this.api.request<{ items: KubernetesObject[] }>(
          "GET",
          `/api/v1/namespaces/${appNamespace}/secrets`,
          undefined,
          this.signal,
        ),
        this.api.request<{ items: KubernetesObject[] }>(
          "GET",
          `/api/v1/namespaces/${appNamespace}/pods`,
          undefined,
          this.signal,
        ),
      ]);
      const referenced = new Set(
        secrets.items
          .filter((secret) =>
            Object.values(secret.data ?? {}).some((value) =>
              hosts.some((host) => Buffer.from(String(value), "base64").toString().includes(host)),
            ),
          )
          .map((secret) => secret.metadata.name),
      );
      const usesDatabase = (spec: any) =>
        [...(spec?.containers ?? []), ...(spec?.initContainers ?? [])].some(
          (container: any) =>
            container.envFrom?.some((source: any) => referenced.has(source.secretRef?.name)) ||
            container.env?.some(
              (env: any) =>
                referenced.has(env.valueFrom?.secretKeyRef?.name) ||
                hosts.some((host) => String(env.value ?? "").includes(host)),
            ),
        );
      if (
        deployments.items.some(
          (deployment) =>
            deployment.spec?.replicas > 0 && usesDatabase(deployment.spec?.template?.spec),
        ) ||
        (pods.items ?? []).some(
          (pod) => !["Succeeded", "Failed"].includes(pod.status?.phase) && usesDatabase(pod.spec),
        )
      )
        throw conflict(
          purpose === "reader"
            ? "An application release still uses this database's reader endpoint. Redeploy it with the new connection, or stop it and wait for its instances to exit, before removing the final read replica."
            : "An application release still uses this database. Deploy its new connection, or stop the application and wait for its instances to exit, before removing the database.",
        );
    }
  }

  private async waitForNamespaceRemoval(log: (message: string) => Promise<void>) {
    let detail = "";
    try {
      await waitForClusterResource(
        this.signal,
        async () => {
          const namespace = await clusterObject(
            this.api,
            `/api/v1/namespaces/${this.namespace}`,
            this.signal,
          );
          if (!namespace) return true;
          if (
            namespace.metadata.labels?.[managed] !== this.target.id ||
            namespace.metadata.labels?.["openship.io/runtime"] !== this.target.runtimeId
          )
            throw conflict("The database namespace changed ownership during cleanup.");
          const next = (namespace.status?.conditions ?? [])
            .filter((condition: any) => condition.status === "True")
            .map((condition: any) => condition.message ?? condition.reason)
            .filter(Boolean)
            .join("\n")
            .slice(0, 2000);
          if (next && next !== detail) {
            detail = next;
            await log(`Waiting for Kubernetes cleanup: ${detail}`);
          }
          return null;
        },
        "database namespace cleanup",
      );
    } catch (error) {
      if (!detail) throw error;
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${detail}`);
    }
  }

  private async removeProbes() {
    const namespace = kubernetesProjectNamespace(this.target.projectId);
    if (!(await clusterObject(this.api, `/api/v1/namespaces/${namespace}`, this.signal))) return;
    const selector = encodeURIComponent(
      `${managed}=${this.target.id},openship.io/database-probe=true`,
    );
    for (const path of [
      `/apis/batch/v1/namespaces/${namespace}/jobs`,
      `/api/v1/namespaces/${namespace}/secrets`,
    ]) {
      const list = await this.api.request<{ items: KubernetesObject[] }>(
        "GET",
        `${path}?labelSelector=${selector}`,
        undefined,
        this.signal,
      );
      for (const object of list.items) {
        const current = await clusterObject(
          this.api,
          `${path}/${object.metadata.name}`,
          this.signal,
        );
        if (!current) continue;
        if (
          current.metadata.uid !== object.metadata.uid ||
          current.metadata.labels?.[managed] !== this.target.id ||
          current.metadata.labels?.["openship.io/runtime"] !== this.target.runtimeId
        )
          throw conflict("A database connection check changed ownership during cleanup.");
        if (!current.metadata.deletionTimestamp) {
          await this.fence();
          await this.api.request(
            "DELETE",
            `${path}/${object.metadata.name}`,
            {
              propagationPolicy: "Foreground",
              preconditions: {
                uid: current.metadata.uid,
                resourceVersion: current.metadata.resourceVersion,
              },
            },
            this.signal,
          );
        }
        await waitForClusterResource(
          this.signal,
          async () =>
            (await clusterObject(this.api, `${path}/${object.metadata.name}`, this.signal))
              ? null
              : true,
          "database connection check cleanup",
        );
      }
    }
  }
}
