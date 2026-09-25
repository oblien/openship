import { createHash } from "node:crypto";
import {
  AppError,
  clusterDatabasePodCount,
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
export type { ClusterDatabaseBackupStorage } from "./database-backups";

export const DATABASE_IMAGES = {
  postgres:
    "ghcr.io/cloudnative-pg/postgresql:17.11@sha256:70664ebcfa1100361b5bdc28bbf06fdbe08db2dc4ad7bd14de33c5e05fe8ea8e",
  redis:
    "quay.io/opstree/redis:v7.4.11@sha256:115d8e221b1459b9f2db7d927ed40318ffac4eb2cddb5702974bce92d32b7a51",
} as const;
export const clusterDatabaseNamespace = (id: string) =>
  `os-db-${createHash("sha256").update(id).digest("hex").slice(0, 24)}`;
export function clusterDatabaseHosts(id: string, config: ClusterDatabaseConfig) {
  const ns = clusterDatabaseNamespace(id);
  return {
    internalHost: `${config.engine === "postgres" ? "database-rw" : config.mode === "cluster" ? "database-leader" : "database"}.${ns}.svc.cluster.local`,
    readOnlyHost:
      config.engine === "postgres" && config.mode === "cluster"
        ? `database-ro.${ns}.svc.cluster.local`
        : null,
  };
}
export function clusterDatabaseUrl(id: string, config: ClusterDatabaseConfig, password: string) {
  const host = clusterDatabaseHosts(id, config).internalHost;
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
  restoreStorage?: ClusterDatabaseBackupStorage;
};
const managed = "openship.io/database";
const conflict = (message: string) =>
  new AppError(message, 409, "CLUSTER_DATABASE_RESOURCE_CONFLICT");

/** Operators own reconciliation, leader election and failover; this adapter only
 * declares the requested database and observes the operator's actual resources. */
export class ClusterDatabaseAdapter {
  readonly namespace: string;
  private readonly labels: Record<string, string>;
  readonly archive: PostgresArchive;
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
    this.archive = new PostgresArchive(
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
      : `/apis/redis.redis.opstreelabs.in/v1beta2/namespaces/${this.namespace}/${this.target.config.mode === "cluster" ? "redisclusters" : "redis"}`;
  }
  private metadata(name: string) {
    return { name, namespace: this.namespace, labels: this.labels };
  }
  private assertOwned(object: KubernetesObject) {
    if (
      object.metadata.labels?.[managed] !== this.target.id ||
      object.metadata.labels?.["openship.io/runtime"] !== this.target.runtimeId ||
      object.metadata.deletionTimestamp
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
      if (
        Number(existing.metadata.annotations?.["openship.io/generation"] ?? 0) >
        this.target.generation
      )
        throw conflict("A newer database operation has already updated this resource.");
      await this.fence();
      return this.api.request(
        "PATCH",
        full,
        {
          ...object,
          metadata: {
            ...object.metadata,
            resourceVersion: existing.metadata.resourceVersion,
            annotations: {
              ...object.metadata.annotations,
              "openship.io/generation": String(this.target.generation),
            },
          },
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
          imageName: DATABASE_IMAGES.postgres,
          enableSuperuserAccess: false,
          bootstrap: this.target.restoreSource
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
                initdb: { database: c.databaseName, owner: "app", secret: { name: "credentials" } },
              },
          ...(this.target.restoreSource && this.target.restoreStorage
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
            labelSelector: { matchLabels: { [managed]: this.target.id } },
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
      kind: c.mode === "cluster" ? "RedisCluster" : "Redis",
      metadata: this.metadata("database"),
      spec: {
        kubernetesConfig: {
          image: DATABASE_IMAGES.redis,
          imagePullPolicy: "IfNotPresent",
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
          : { affinity, nodeSelector: selector }),
      },
    };
  }

  async apply(password: string) {
    if (this.target.config.backup && !this.target.backupStorage)
      throw new Error("The database backup destination could not be loaded.");
    if (this.target.restoreSource && !this.target.restoreStorage)
      throw new Error("The original backup destination could not be loaded for recovery.");
    await this.declare("/api/v1/namespaces", {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        name: this.namespace,
        labels: { ...this.labels, "pod-security.kubernetes.io/enforce": "baseline" },
      },
    });
    const c = this.target.config;
    const fromNamespace = (name: string) => ({
      namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": name } },
    });
    await this.declare(`/apis/networking.k8s.io/v1/namespaces/${this.namespace}/networkpolicies`, {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: this.metadata("database-ingress"),
      spec: {
        podSelector: {},
        policyTypes: ["Ingress"],
        ingress: [
          { from: [{ podSelector: {} }] },
          {
            from: [fromNamespace(kubernetesProjectNamespace(this.target.projectId))],
            ports: [{ protocol: "TCP", port: c.engine === "postgres" ? 5432 : 6379 }],
          },
          {
            from: [fromNamespace(c.engine === "postgres" ? "cnpg-system" : "ot-operators")],
            ports: (c.engine === "postgres" ? [5432, 8000] : [6379, 16379]).map((port) => ({
              protocol: "TCP",
              port,
            })),
          },
        ],
      },
    });
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
    await this.declare(this.crBase(), this.manifest(), true);
    if (c.backup) await this.archive.schedule(c.backup);
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
    const dataPods = ownedPods.filter(
      (pod) => !pod.metadata.ownerReferences?.some((owner) => owner.kind === "Job"),
    );
    const ready = dataPods.filter((pod) =>
      pod.status?.conditions?.some(
        (condition: any) => condition.type === "Ready" && condition.status === "True",
      ),
    );
    const primary = root?.status?.currentPrimary ?? null;
    const engineReady =
      current.engine === "postgres"
        ? root?.status?.readyInstances === current.instances &&
          !!primary &&
          root?.status?.phase === "Cluster in healthy state"
        : current.mode === "cluster"
          ? root?.status?.state === "Ready" &&
            root.status.readyLeaderReplicas === current.instances &&
            root.status.readyFollowerReplicas === current.instances
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
            backups: await this.archive.list(),
            archive: {
              healthy: archiveCondition ? archiveCondition.status === "True" : null,
              message: archiveCondition?.message ?? "Waiting for the first archive check.",
              lastSuccessfulBackup: root?.status?.lastSuccessfulBackup ?? null,
            },
          }
        : {}),
      pods: dataPods.map((pod) => {
        const host = this.target.hosts.find((item) => item.nodeName === pod.spec?.nodeName);
        // Redis's StatefulSet labels describe its original group, not its
        // elected role after failover. Do not present those as live leadership.
        return {
          name: pod.metadata.name!,
          nodeName: pod.spec?.nodeName ?? null,
          serverId: host?.serverId ?? null,
          serverName: host?.name ?? null,
          role:
            current.engine === "postgres"
              ? pod.metadata.name === primary
                ? "primary"
                : "replica"
              : current.mode === "cluster"
                ? "member"
                : "standalone",
          ready: ready.includes(pod),
          phase: kubernetesPodPhase(pod),
          restarts: (pod.status?.containerStatuses ?? []).reduce(
            (sum: number, status: any) => sum + (status.restartCount ?? 0),
            0,
          ),
        };
      }),
    };
  }

  async verify(log: (message: string) => Promise<void>): Promise<ClusterDatabaseObservation> {
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
    const name = `db-${this.namespace.slice(6)}-verify-${this.target.generation}`;
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
    const check =
      c.engine === "postgres"
        ? "test \"$(psql -X -A -t -c 'SELECT 1')\" = 1"
        : `test \"$(timeout 10 redis-cli -h ${host} PING)\" = PONG${c.mode === "cluster" ? ` && timeout 10 redis-cli -h ${host} CLUSTER INFO | tr -d '\\r' | grep -qx 'cluster_state:ok' && timeout 10 redis-cli -h ${host} CLUSTER INFO | tr -d '\\r' | grep -qx 'cluster_slots_assigned:16384'` : ""}`;
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
    await this.removeProbes();
    const namespace = await clusterObject(
      this.api,
      `/api/v1/namespaces/${this.namespace}`,
      this.signal,
    );
    if (!namespace) return;
    if (namespace.metadata.deletionTimestamp) {
      if (!deleteData)
        throw conflict(
          "Permanent database removal has already started. Retry that removal to finish cleanup.",
        );
      await this.waitForNamespaceRemoval(log);
      return;
    }
    this.assertOwned(namespace);
    if (this.target.config.engine === "postgres" && this.target.config.backup)
      await this.archive.suspend();
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
