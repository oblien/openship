/** The narrow job protocol. Kubernetes owns execution and recovery; these jobs
 * only capture or load an engine's native backup format. No scheduler lives here. */
export interface RedisEndpoint {
  host: string;
  port: number;
  mode: "standalone" | "replication" | "cluster";
  /** Required for verified recovery into a non-sharded replicated destination. */
  replicas?: number;
  /** Private operator discovery endpoint; never infer the primary from a stale Service route. */
  sentinel?: { host: string; port: number; masterName: string };
}
export interface ArchiveFile {
  key: string;
  sizeBytes: number;
  sha256: string;
}
export interface RedisArchiveManifest {
  format: "openship-redis-rdb-v1";
  databaseId: string;
  runtimeId: string;
  mode: "standalone" | "cluster";
  createdAt: string;
  /** Every primary has its own consistent RDB; this is not a global transaction. */
  files: Array<ArchiveFile & { primaryId: string }>;
}
export interface PostgresArchiveManifest {
  format: "openship-postgres-dump-v1";
  databaseId: string;
  runtimeId: string;
  createdAt: string;
  databaseName: string;
  file: ArchiveFile;
}
export interface ArchiveEntry {
  name: string;
  phase: "running" | "completed" | "failed";
  startedAt: string;
  completedAt: string | null;
  error: string | null;
  manifestKey: string | null;
  /** Restore requests pin archives until the target reports completion. */
  pins?: string[];
}
export interface DatabaseTaskConfig {
  operation:
    | "redis-backup"
    | "redis-restore"
    | "postgres-backup"
    | "postgres-restore"
    | "import-backup";
  databaseId: string;
  runtimeId: string;
  namespace: string;
  indexUid: string;
  archiveName?: string;
  destinationPath: string;
  redis?: RedisEndpoint;
  postgres?: { host: string; database: string; user: string };
  retentionDays?: number;
  source?: { databaseId: string; runtimeId: string; manifestKey: string };
  artifact?: import("@repo/core").StoredBackupArtifact & {
    payloadKind: "pg_dump" | "redis_rdb";
    sha256: string;
  };
}
