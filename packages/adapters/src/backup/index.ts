/**
 * Public surface of the backup adapter package.
 *
 * Importing this module triggers self-registration of every shipped
 * executor / producer / destination via side effects. Consumers
 * (the BackupOrchestrator in apps/api) just need to import this once
 * to make everything resolvable through the registry.
 *
 * Registration order matters for producers — the registry walks them
 * in registration order for auto-detection. Producers with `detects()`
 * regex matches (Chunk 3: pg-dump etc.) must register BEFORE the
 * fallback `volume` producer. We control that here by import order.
 */

// Types
export type {
  ArtifactRef,
  Artifact,
  BackupDestination,
  BackupDestinationRow,
  BackupExecutor,
  BackupManifest,
  BackupProducer,
  BackupSource,
  BackupTrigger,
  DestinationCapability,
  DestinationFactory,
  DestinationKind,
  ExecExitInfo,
  ExecuteCommandOpts,
  ExecutorFactory,
  HeadInfo,
  ListOpts,
  ListPage,
  PayloadKind,
  ProducerOpts,
  PutOpts,
  PutResult,
  ReceiveStreamOpts,
  RestoreOpts,
  ServiceHandle,
  StreamPathOpts,
  TriggerSource,
} from "./types";

// Registry accessors
export {
  listRegisteredDestinations,
  listRegisteredExecutors,
  listRegisteredProducers,
  registerDestination,
  registerExecutor,
  registerProducer,
  resolveDestination,
  resolveExecutor,
  resolveProducer,
  resolveProducerForService,
} from "./registry";

// Common helpers — re-exported for orchestrator use.
export { setBackupCredentialSecret } from "./common/credentials";
export { HashingPassthrough } from "./common/sha256-stream";
export { artifactKey, manifestKey, runPrefix } from "./common/key-builder";
export { buildManifest, validateManifest } from "./common/manifest";

// Single strategy-driven volume-transfer core (same/cross-daemon).
export {
  transferVolume,
  resolvePlan,
  type TransferMode,
  type TransferCompression,
  type TransferEndpoint,
  type TransferOptions,
  type TransferPlan,
  type TransferResult,
} from "./volume-transfer";

// ─── Side-effect imports: every adapter self-registers on load ──────────────
// DB-specific producers will land in Chunk 3 — import them ABOVE
// "./producers/volume" so they win autodetect priority.

// DB-specific producers — register BEFORE the volume fallback so
// their detects() wins for postgres/mysql/redis/mongo images.
import "./producers/pg-dump";
import "./producers/mysql-dump";
import "./producers/redis";
import "./producers/mongo";
import "./producers/custom-command";  // explicit-only, no detect
import "./producers/volume";          // universal fallback — LAST
import "./executors/docker";          // docker runtime → backup executor
import "./executors/cloud";           // cloud runtime → backup executor
import "./executors/bare";            // bare SSH host → backup executor (mail, etc.)
import "./destinations/local";        // local filesystem destination
import "./destinations/s3";           // S3-compatible (AWS/R2/Wasabi/B2/MinIO/...)
import "./destinations/sftp";         // SFTP + openship_server (shared impl)

// Other producers / executors / destinations land in later chunks via
// new side-effect imports here. Keep this section flat + ordered.
