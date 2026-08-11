/**
 * Backup adapter contracts — four independent axes, composed by the
 * BackupOrchestrator. Each axis is a registry-discovered plug-in:
 *
 *   Trigger     WHEN  — manual / cron / webhook / pre-deploy
 *   Executor    HOW   — docker / cloud / ssh
 *   Producer    WHAT  — volume / pg_dump / mysql_dump / redis_rdb / mongo_dump / custom
 *   Destination WHERE — s3-compatible / sftp / local / http-upload / future
 *
 * The orchestrator never imports concrete adapters — it resolves them
 * from the registry by name. Adding a new database type, runtime, or
 * storage backend is a single-file addition.
 */

import type { Readable } from "node:stream";

// ─── Common ──────────────────────────────────────────────────────────────────

/** A reference to one of the user's deployed services. Adapters get
 *  this opaque shape from the orchestrator — they don't reach back
 *  into the DB. Everything an executor or producer might need about
 *  the service is on this handle. */
export interface ServiceHandle {
  /** Stable service id from the DB. */
  id: string;
  projectId: string;
  /** Compose-style service name; used for hostnames + container names. */
  name: string;
  /** Image tag, e.g. "postgres:16" or "node:22". Producers regex this
   *  for autodetection. */
  image: string | null;
  /** Plaintext env at backup time — needed by producers that invoke
   *  `pg_dump -U $POSTGRES_USER` etc. The orchestrator decrypts the
   *  per-service env_vars before constructing the handle. */
  env: Record<string, string>;
  /** Raw compose-syntax volume strings from `service.volumes`. The
   *  executor parses these to discover sources. */
  volumes: string[];
  /** Runtime-specific container/workspace id when the service is
   *  currently deployed. Null if it has never deployed or was destroyed. */
  containerId: string | null;
  /** Project slug — used in destination key paths. */
  projectSlug: string;
  /** Whether this service's NAMED volumes are project-scoped
   *  (openship-<slug>-<name>). Mirrors service.namespaceVolumes so the DB
   *  fallback in listSources resolves the same name deploy used. False for
   *  grandfathered pre-migration services (bare names). */
  namespaceVolumes: boolean;
}

export interface ExecExitInfo {
  code: number;
  signal?: NodeJS.Signals;
  /** Captured stderr (truncated to 16 KiB). */
  stderr: string;
}

// ─── Executor (HOW) ──────────────────────────────────────────────────────────

/** The set of physical sources an executor can pull bytes out of for a
 *  given service. Producers iterate this to decide what to back up. */
export interface BackupSource {
  /** Opaque id understood by the executor — typically the path or
   *  volume name. */
  id: string;
  /** Mount point inside the service (`/var/lib/postgresql/data`). */
  target: string;
  /** Where the bytes physically live on the host runtime. For Docker
   *  named volumes this is just the volume name; for bind mounts the
   *  host path; for cloud workspaces a synthetic id. */
  source: string;
  type: "volume" | "bind" | "tmpfs" | "workspace-disk";
  /** Best-effort size in bytes. Not all executors can probe cheaply
   *  (we don't `du -sb` by default). Undefined when unknown. */
  sizeHint?: number;
}

export interface ExecuteCommandOpts {
  env?: Record<string, string>;
  user?: string;
  /** Working directory inside the service. */
  cwd?: string;
  /** Kill the exec after this many milliseconds. Null = no timeout
   *  (use cautiously — long-running dumps are legitimate). */
  timeoutMs?: number;
}

export interface StreamPathOpts {
  compression?: "zstd" | "gzip" | "none";
  /** Glob-ish patterns to exclude (passed to tar `--exclude`). */
  exclude?: string[];
}

export interface ReceiveStreamOpts {
  compression?: "zstd" | "gzip" | "none";
  /** Wipe the target before extracting. Default false — adapter-
   *  specific safer modes (delete-then-recreate volume) take precedence. */
  clearTarget?: boolean;
}

/** Executor — the runtime-shaped axis. Speaks "run this command inside
 *  the service and give me its stdout as a stream". Producers compose
 *  with this; they don't know whether they're talking to Docker, the
 *  Oblien cloud, or an SSH host. */
export interface BackupExecutor {
  /** Identifies which RuntimeAdapter this executor pairs with. */
  readonly runtimeName: "docker" | "bare" | "cloud";

  /** Discover what's backupable inside a service. */
  listSources(service: ServiceHandle): Promise<BackupSource[]>;

  /** Run a shell command inside the service. The stdout stream is
   *  returned immediately; `awaitExit` resolves with the exit code +
   *  stderr after the process completes. Producers use this for hot
   *  dumps (`pg_dump`, `mongodump`, `redis-cli BGSAVE`). */
  execStream(
    service: ServiceHandle,
    cmd: string[],
    opts?: ExecuteCommandOpts,
  ): Promise<{ stdout: Readable; awaitExit: Promise<ExecExitInfo> }>;

  /** Tar (and optionally compress) a source out of the service. The
   *  default cold-volume payload uses this. */
  streamPath(
    service: ServiceHandle,
    sourceId: string,
    opts?: StreamPathOpts,
  ): Promise<{ stdout: Readable; awaitExit: Promise<ExecExitInfo> }>;

  /** Push a stream INTO a service source. Used by producer.restore to
   *  load bytes back. */
  receiveStream(
    service: ServiceHandle,
    targetSourceId: string,
    body: Readable,
    opts?: ReceiveStreamOpts,
  ): Promise<{ bytesWritten: number }>;

  /** Same-daemon source→target copy in a single helper (no stream/SSH hop).
   *  Optional — only the docker executor implements it; the transfer core
   *  falls back to streamPath→receiveStream when it's absent. */
  copyVolumeLocal?(
    srcService: ServiceHandle,
    srcSourceId: string,
    dstService: ServiceHandle,
    dstSourceId: string,
    opts?: { clearTarget?: boolean },
  ): Promise<{ bytesWritten: number }>;

  /** Whether a named-volume source already exists on this daemon, and if so
   *  whether it holds data. Lets a caller REFUSE to overwrite a pre-existing,
   *  non-empty target volume (e.g. a cross-server migration that reuses bare
   *  volume names could otherwise clobber an unrelated volume on the target).
   *  Optional — docker-only; bind mounts / unknown → {exists:false,empty:true}. */
  probeVolume?(
    service: ServiceHandle,
    sourceId: string,
  ): Promise<{ exists: boolean; empty: boolean }>;

  /** Run a command inside the service with `body` piped to its stdin.
   *  Returns when the command exits. Used by DB-aware producers to
   *  stream dump bytes into `pg_restore` / `mysql` / `redis-cli` etc.
   *  without staging the whole file first. */
  pipeIntoCommand(
    service: ServiceHandle,
    cmd: string[],
    body: Readable,
    opts?: ExecuteCommandOpts,
  ): Promise<ExecExitInfo>;

  /** Stop a service so its volumes can be safely restored. */
  stopService(service: ServiceHandle): Promise<void>;

  /** Start a service after restore. */
  startService(service: ServiceHandle): Promise<void>;

  /** Is the service's runtime instance currently running? Used by the
   *  orchestrator to skip unnecessary stop calls. */
  isRunning(service: ServiceHandle): Promise<boolean>;
}

/** Factory takes the runtime adapter the executor pairs with. Each
 *  concrete factory asserts the runtime type (e.g. `instanceof
 *  DockerRuntime`) before downcasting. */
export type ExecutorFactory = (runtime: unknown) => BackupExecutor;

// ─── Producer (WHAT) ─────────────────────────────────────────────────────────

/** Canonical payload kinds. Stored in `backup_policy.payload_kind` as
 *  a string — the producer registry resolves by this name, so new
 *  kinds don't need a schema migration. */
export type PayloadKind =
  | "volume"
  | "pg_dump"
  | "mysql_dump"
  | "redis_rdb"
  | "mongo_dump"
  | "custom_command";

export interface ProducerOpts {
  /** Which sources from `listSources()` to back up. Null = producer's
   *  default (usually "everything"). */
  sourceIds?: string[];
  /** For custom_command: the command to run. */
  command?: string;
  /** Extra patterns to exclude (forwarded to executor). */
  exclude?: string[];
}

export interface RestoreOpts {
  /** Pass clearTarget through. */
  clearTarget?: boolean;
  /** Wait this long for the service to come back up after restart. */
  startupTimeoutMs?: number;
}

/** A single backup artifact — one file in the destination. A producer
 *  may yield multiple (e.g. multi-volume tar fan-out). */
export interface Artifact {
  /** Filename within the run's directory. e.g. "volume-pgdata.tar.zst". */
  name: string;
  /** The bytes themselves. The orchestrator pipes this into the
   *  destination + a sha256 hasher in parallel. */
  stream: Readable;
  /** Approximate size for progress reporting. Producer-provided when
   *  cheap to compute; undefined otherwise. */
  sizeHint?: number;
  payloadKind: PayloadKind;
  /** Free-form per-artifact metadata recorded in manifest.json. */
  metadata: Record<string, unknown>;
}

/** Resolved during restore: the artifact's persisted location + stream. */
export interface ArtifactRef {
  /** Destination key (full path within the bucket/store). */
  key: string;
  /** Producer-readable metadata captured at backup time. */
  metadata: Record<string, unknown>;
  payloadKind: PayloadKind;
  sha256: string;
  sizeBytes: number;
  /** Lazily-resolved stream from the destination. The producer pipes
   *  this through whatever decompression/parsing it needs. */
  open: () => Promise<Readable>;
}

/** Producer — the payload-shape axis. Auto-detected from
 *  `service.image` or selected explicitly in the policy. */
export interface BackupProducer {
  readonly kind: PayloadKind;

  /** True if this producer is the appropriate default for this
   *  service. Implementations regex `service.image`. Multiple
   *  producers may return true; the registry picks the first match
   *  (registration order = priority). */
  detects?(service: ServiceHandle): boolean;

  /** Yield artifacts. Implementations call executor methods — they
   *  never touch Docker/Oblien SDKs directly. The async iterable
   *  contract lets the orchestrator stream-pipe one at a time. */
  produce(
    service: ServiceHandle,
    executor: BackupExecutor,
    opts: ProducerOpts,
  ): AsyncIterable<Artifact>;

  /** Restore an artifact back into the service. Producer-specific
   *  because pg_restore differs from tar-extract. */
  restore(
    service: ServiceHandle,
    executor: BackupExecutor,
    artifact: ArtifactRef,
    opts: RestoreOpts,
  ): Promise<void>;
}

// ─── Destination (WHERE) ─────────────────────────────────────────────────────

export type DestinationCapability =
  | "streamingPut"
  | "streamingGet"
  | "multipart"
  | "presignedGet"
  | "presignedPut"
  | "quota"
  | "serverSideCopy";

export type DestinationKind =
  | "s3_compatible"
  | "sftp"
  | "openship_server"
  | "local"
  | "http_upload";

/** Validated row shape passed to a DestinationFactory. The destination
 *  module decrypts its own secrets at construction time and discards
 *  the plaintext immediately. */
export interface BackupDestinationRow {
  id: string;
  organizationId: string;
  name: string;
  kind: DestinationKind;
  endpoint: string | null;
  region: string | null;
  bucket: string | null;
  pathPrefix: string | null;
  sshHost: string | null;
  sshPort: number | null;
  sshUser: string | null;
  /** When kind="openship_server" this is the user's servers.id. The
   *  apps/api layer hydrates SSH creds from that server BEFORE handing
   *  the row to resolveDestination — the adapter never queries the DB. */
  serverId?: string | null;
  /** Encrypted credential ciphertexts. Adapter calls decryptSecretField
   *  on construction; nothing else touches these. */
  accessKeyIdEnc: string | null;
  secretAccessKeyEnc: string | null;
  sftpPasswordEnc: string | null;
  sftpPrivateKeyEnc: string | null;
  sftpKeyPassphraseEnc: string | null;
}

export interface PutOpts {
  /** Known byte size when available (S3 multipart threshold etc.). */
  size?: number;
  contentType?: string;
  /** Pre-computed sha256 hex; if present, destination may verify
   *  end-to-end (e.g. S3 Content-MD5 / ChecksumSHA256). */
  sha256?: string;
  /** Free-form object metadata stored alongside (S3 x-amz-meta-*,
   *  SFTP ignores). */
  metadata?: Record<string, string>;
}

export interface PutResult {
  bytesWritten: number;
  /** Provider-supplied ETag or equivalent. */
  etag?: string;
}

export interface HeadInfo {
  sizeBytes: number;
  etag?: string;
  uploadedAt: Date;
  metadata?: Record<string, string>;
}

export interface ListPage {
  entries: Array<{ key: string; size: number; uploadedAt: Date }>;
  nextContinuationToken?: string;
}

export interface ListOpts {
  limit?: number;
  continuationToken?: string;
}

/** Destination — the storage-backend axis. */
export interface BackupDestination {
  readonly kind: DestinationKind;
  readonly capabilities: ReadonlySet<DestinationCapability>;

  /** Verify the destination is reachable + writable. Probes by writing
   *  + reading + deleting a tiny object. Called from controller
   *  before saving credentials and periodically by a sweep. */
  preflight(): Promise<{ ok: true } | { ok: false; reason: string }>;

  put(key: string, body: Readable, opts: PutOpts): Promise<PutResult>;
  get(key: string): Promise<Readable>;
  head(key: string): Promise<HeadInfo | null>;
  list(prefix: string, opts?: ListOpts): Promise<ListPage>;
  delete(key: string): Promise<void>;
  deleteMany(keys: string[]): Promise<{
    deleted: string[];
    failed: Array<{ key: string; error: string }>;
  }>;

  /** Mint a presigned GET URL — used so cloud workspaces can fetch
   *  artifacts directly during restore instead of proxying through
   *  the API host. Only implemented when capabilities include
   *  `presignedGet`. */
  presignGet?(key: string, ttlSec: number): Promise<string>;
  presignPut?(
    key: string,
    ttlSec: number,
    opts?: { contentType?: string },
  ): Promise<string>;
}

export type DestinationFactory = (row: BackupDestinationRow) => BackupDestination;

// ─── Trigger (WHEN) ──────────────────────────────────────────────────────────

export type TriggerSource = "manual" | "cron" | "webhook" | "pre_deploy";

/** The orchestrator's only input besides the policy id. Triggers funnel
 *  through `orchestrator.runBackup(policyId, trigger)` regardless of
 *  source — adding a new trigger doesn't change the orchestrator. */
export interface BackupTrigger {
  source: TriggerSource;
  /** Who initiated. For cron/webhook this is the policy's createdBy. */
  userId: string;
  /** Client IP when applicable (manual + webhook). */
  clientIp?: string;
  /** Free-form per-trigger context recorded for audit. */
  metadata?: Record<string, unknown>;
}

// ─── Manifest ────────────────────────────────────────────────────────────────

/** Recorded as `manifest.json` at the root of every backup run's
 *  destination directory. Self-contained: anyone with destination
 *  access can hand-restore by reading this file. */
export interface BackupManifest {
  version: 1;
  runId: string;
  projectId: string;
  projectSlug: string;
  serviceId: string;
  serviceName: string;
  serviceImage: string | null;
  capturedAt: string;
  artifacts: Array<{
    name: string;
    key: string;
    sizeBytes: number;
    sha256: string;
    payloadKind: PayloadKind;
    metadata: Record<string, unknown>;
  }>;
  /** Env var keys captured at backup time (values are NEVER recorded
   *  in the manifest — secrets stay in encrypted DB columns). */
  envVarKeys: string[];
  /** Service-level config snapshot for restore-correctness checks. */
  serviceConfig: {
    image: string | null;
    ports: string[];
    command: string | null;
    environmentKeys: string[];
  };
}
