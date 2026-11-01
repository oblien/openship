import { AppError } from "./errors";
import type { SetupLog, SetupStepProgress } from "./cluster-runtime";
import { incrementalBackupStorage, type StoredBackupArtifact } from "./backup-storage";

/** Deployable database capabilities. Deliberately separate from the canvas planner. */
export const CLUSTER_DATABASE_TEMPLATES = [
  {
    id: "postgres",
    name: "PostgreSQL",
    operator: "CloudNativePG",
    port: 5432,
    envKey: "DATABASE_URL",
    modes: ["standalone", "cluster"],
    clusterDescription: "One primary with streaming replicas and automatic failover.",
    clusterAwareClient: false,
  },
  {
    id: "redis",
    name: "Redis",
    operator: "Redis Operator",
    port: 6379,
    envKey: "REDIS_URL",
    modes: ["standalone", "replication", "cluster"],
    replicationDescription:
      "One primary with replicas and three Sentinel voters for automatic failover.",
    clusterDescription:
      "Three or more shards, each with a replica. Requires a Redis Cluster client.",
    clusterAwareClient: true,
  },
] as const;

/** Operator-managed databases require the Kubernetes control and storage APIs. */
export function clusterDatabaseUnsupportedReason(
  provider: "k3s" | "swarm" | undefined,
): string | null {
  return provider === "swarm"
    ? "Managed database replication requires Kubernetes. Swarm application replicas do not synchronize database data. Choose a Kubernetes cluster for this database."
    : null;
}

export type ClusterDatabaseEngine = "postgres" | "redis";
export interface ClusterDatabaseConfig {
  engine: ClusterDatabaseEngine;
  /** Omitted on existing databases; their PostgreSQL major remains 17. */
  version?: "17" | "18";
  mode: "standalone" | "replication" | "cluster";
  /** Data members for PostgreSQL/Redis replication, or Redis Cluster shards (one follower each). */
  instances: number;
  storageGiB: number;
  storageClass: string;
  cpuMillis: number;
  memoryMiB: number;
  databaseName: string;
  backup?: {
    destinationId: string;
    schedule: "daily" | "hourly" | "manual";
    retentionDays: number;
  };
}
/** A reader connection routes to replicas; it does not make its credentials read-only. */
export type ClusterDatabaseConnectionTarget = "write" | "read";
export const clusterDatabaseConnectionOutputId = (
  id: string,
  target: ClusterDatabaseConnectionTarget = "write",
) => `cluster-database:${id}${target === "read" ? ":read" : ""}`;
export function clusterDatabaseConnectionTarget(id: string, outputId: string) {
  if (outputId === clusterDatabaseConnectionOutputId(id)) return "write" as const;
  if (outputId === clusterDatabaseConnectionOutputId(id, "read")) return "read" as const;
  return null;
}
export function clusterDatabaseHasReaders(config: ClusterDatabaseConfig) {
  return config.engine === "postgres" && config.mode === "cluster" && config.instances > 1;
}
/** Server-derived restore identity; the client never supplies archive paths. */
export interface ClusterDatabaseRestoreSource {
  format?: "postgres-physical" | "redis-rdb-set" | "postgres-logical" | "backup-artifact";
  pinId?: string;
  runtimeId?: string;
  sourceConfig?: ClusterDatabaseConfig;
  sourceSequence?: number;
  backupRunId?: string;
  artifact?: ClusterDatabaseImportArtifact;
  databaseId: string;
  backupName: string;
  backupId: string;
  destinationId: string;
  destinationPath: string;
  serverName: string;
  endpoint: string | null;
}
export type ClusterDatabaseImportArtifact = StoredBackupArtifact & {
  name: string;
  payloadKind: "pg_dump" | "redis_rdb";
  sha256: string;
};
export const clusterPostgresVersion = (config: ClusterDatabaseConfig) => config.version ?? "17";

/** Saved native dumps only. Never infer an import command from a filename. */
export function validateClusterDatabaseImportArtifact(
  value: unknown,
): asserts value is ClusterDatabaseImportArtifact {
  const artifact = value as ClusterDatabaseImportArtifact | null;
  if (
    !artifact ||
    !["pg_dump", "redis_rdb"].includes(artifact.payloadKind) ||
    !artifact.name ||
    !/^[a-zA-Z0-9._/-]+$/.test(artifact.key) ||
    artifact.key.split("/").some((part) => !part || part === "." || part === "..") ||
    !Number.isSafeInteger(artifact.sizeBytes) ||
    artifact.sizeBytes < 1 ||
    !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
    !["none", "gzip", "zstd"].includes(String(artifact.metadata?.compression ?? "none")) ||
    artifact.metadata?.encrypted ||
    artifact.metadata?.encryption
  )
    throw new AppError(
      "Choose a completed PostgreSQL or Redis backup with verified integrity and a supported native dump format.",
      422,
      "CLUSTER_DATABASE_IMPORT_FORMAT",
    );
  incrementalBackupStorage(artifact);
  if (JSON.stringify(artifact).length > 200_000)
    throw new AppError(
      "This incremental backup has too many parts for a database import. Capture a full database backup and select it here.",
      422,
      "CLUSTER_DATABASE_IMPORT_FORMAT",
    );
}
export interface ClusterDatabaseBackup {
  name: string;
  phase: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  backupId: string | null;
}
export const CLUSTER_DATABASE_STEPS = [
  "connect",
  "operators",
  "storage",
  "database",
  "verify",
] as const;
export type ClusterDatabaseStep =
  | (typeof CLUSTER_DATABASE_STEPS)[number]
  | "remove"
  | "backup"
  | "restore";
export type ClusterDatabaseStatus =
  | "provisioning"
  | "ready"
  | "failed"
  | "interrupted"
  | "deleting"
  | "retained"
  | "deleted";
export interface ClusterDatabaseProgress {
  steps: SetupStepProgress<ClusterDatabaseStep>[];
  logs: SetupLog<ClusterDatabaseStep>[];
}
export interface ClusterDatabaseObservation {
  ready: boolean;
  message: string;
  observedAt: string;
  primary: string | null;
  pods: Array<{
    name: string;
    serverId: string | null;
    serverName: string | null;
    nodeName: string | null;
    role: string;
    ready: boolean;
    phase: string;
    restarts: number;
  }>;
  volumes: Array<{ name: string; phase: string; capacity: string | null }>;
  backups?: ClusterDatabaseBackup[];
  archive?: { healthy: boolean | null; message: string; lastSuccessfulBackup: string | null };
}
export const clusterDatabaseRunning = (status: string) =>
  status === "provisioning" || status === "deleting";
export const CLUSTER_DATABASE_LEASE_MS = 90_000;

/** Persistent data pods. Redis replication also has three small Sentinel voters. */
export function clusterDatabasePodCount(config: ClusterDatabaseConfig): number {
  return config.instances * (config.engine === "redis" && config.mode === "cluster" ? 2 : 1);
}

export function validateClusterDatabase(config: ClusterDatabaseConfig): void {
  const invalid = (message: string): never => {
    throw new AppError(message, 422, "CLUSTER_DATABASE_CONFIG");
  };
  if (!["postgres", "redis"].includes(config.engine))
    invalid("Choose a supported database engine.");
  if (
    config.version !== undefined &&
    (config.engine !== "postgres" || !["17", "18"].includes(config.version))
  )
    invalid("Choose PostgreSQL 17 or 18. Redis uses the supported version supplied by OpenShip.");
  if (
    !["standalone", "cluster", ...(config.engine === "redis" ? ["replication"] : [])].includes(
      config.mode,
    )
  )
    invalid("Choose a supported database topology.");
  if (
    !Number.isInteger(config.instances) ||
    (config.mode === "standalone"
      ? config.instances !== 1
      : config.instances < (config.engine === "postgres" ? 2 : 3) || config.instances > 9)
  )
    invalid(
      "Standalone databases use one instance. PostgreSQL needs 2–9 instances; Redis replication needs 3–9 data members; Redis Cluster needs 3–9 shards.",
    );
  if (!Number.isInteger(config.storageGiB) || config.storageGiB < 1 || config.storageGiB > 16384)
    invalid("Choose between 1 and 16384 GiB of storage per instance.");
  if (
    !/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(config.storageClass) ||
    config.storageClass.length > 63
  )
    invalid("Choose a valid storage class.");
  if (!Number.isInteger(config.cpuMillis) || config.cpuMillis < 100 || config.cpuMillis > 64000)
    invalid("CPU must be between 100 and 64000 millicores per instance.");
  if (!Number.isInteger(config.memoryMiB) || config.memoryMiB < 256 || config.memoryMiB > 262144)
    invalid("Memory must be between 256 and 262144 MiB per instance.");
  if (
    !/^[a-z][a-z0-9_]{0,47}$/.test(config.databaseName) ||
    ["postgres", "template0", "template1"].includes(config.databaseName)
  )
    invalid(
      "Use a database name starting with a letter, followed by letters, digits or underscores.",
    );
  if (config.backup) {
    if (!config.backup.destinationId || config.backup.destinationId.length > 128)
      invalid("Choose an existing S3 backup destination.");
    if (!["daily", "hourly", "manual"].includes(config.backup.schedule))
      invalid("Choose a supported backup schedule.");
    if (
      !Number.isInteger(config.backup.retentionDays) ||
      config.backup.retentionDays < 7 ||
      config.backup.retentionDays > 365
    )
      invalid("Keep database archives for between 7 and 365 days.");
  }
}

/** PostgreSQL keeps the same operator resource; Redis topology conversion needs data migration. */
export function validateClusterDatabaseUpdate(
  before: ClusterDatabaseConfig,
  after: ClusterDatabaseConfig,
  review?: { confirmRedisRebalance?: boolean },
) {
  validateClusterDatabase(after);
  if (
    before.engine === "postgres" &&
    clusterPostgresVersion(before) !== clusterPostgresVersion(after)
  )
    throw new AppError(
      "Create an upgraded copy, verify its data, then switch the application connection. Major database versions cannot be changed in place.",
      422,
      "CLUSTER_DATABASE_IMMUTABLE",
    );
  if (
    ["engine", "storageClass", "databaseName", ...(before.engine === "redis" ? ["mode"] : [])].some(
      (key) =>
        before[key as keyof ClusterDatabaseConfig] !== after[key as keyof ClusterDatabaseConfig],
    )
  )
    throw new AppError(
      "The engine, topology, storage class and database name cannot be changed in place. Create another database and restore into it.",
      422,
      "CLUSTER_DATABASE_IMMUTABLE",
    );
  if (after.storageGiB < before.storageGiB)
    throw new AppError("Database volumes cannot be shrunk.", 422, "CLUSTER_DATABASE_IMMUTABLE");
  if (after.storageClass === "openship-local" && after.storageGiB !== before.storageGiB)
    throw new AppError(
      "Local storage reservations cannot be resized. For resizable PostgreSQL volumes, select an expandable storage class when creating the database.",
      422,
      "CLUSTER_DATABASE_IMMUTABLE",
    );
  if (
    before.engine === "redis" &&
    before.mode === "replication" &&
    after.instances < before.instances
  )
    throw new AppError(
      "Redis replication members cannot be removed in place yet. Create a smaller verified copy and switch its connection after review.",
      422,
      "CLUSTER_DATABASE_IMMUTABLE",
    );
  if (after.engine === "redis" && after.storageGiB !== before.storageGiB)
    throw new AppError(
      "Redis volume resizing is not supported by this template yet. Keep the existing storage size.",
      422,
      "CLUSTER_DATABASE_IMMUTABLE",
    );
  if (
    after.engine === "redis" &&
    after.mode === "cluster" &&
    after.instances !== before.instances
  ) {
    if (!review?.confirmRedisRebalance)
      throw new AppError(
        "Review and confirm the Redis data migration before changing its shard count.",
        422,
        "CLUSTER_DATABASE_REBALANCE_REVIEW",
      );
    if (!before.backup || !after.backup)
      throw new AppError(
        "Save a backup destination before changing Redis data partitions. OpenShip will verify a backup before moving data.",
        422,
        "CLUSTER_DATABASE_BACKUP_REQUIRED",
      );
  }
  if (before.backup && after.backup?.destinationId !== before.backup.destinationId)
    throw new AppError(
      "Keep this database's archive destination to preserve its recovery history. You can change the schedule or restore into a new database with a different destination.",
      422,
      "CLUSTER_DATABASE_IMMUTABLE",
    );
}
