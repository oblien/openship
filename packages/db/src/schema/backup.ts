/**
 * Backup tables — four sibling tables that together implement the
 * adapter-based backup system:
 *
 *   backup_destination — per-user named storage endpoint (S3/SFTP/local).
 *                        Credentials encrypted with the `enc1:` envelope.
 *   backup_policy      — per-project + per-service-override scheduling
 *                        rules. Cascade picks ONE row (override or
 *                        default), no JSON merging.
 *   backup_run         — execution history. Survives policy + destination
 *                        deletion (the artifact at the destination outlives
 *                        the row that scheduled it).
 *   backup_restore     — restore history. Sibling to backup_run so the
 *                        status FSM stays clean.
 *
 * Schema-wise we deliberately add NO columns to existing tables. All
 * cross-references are FKs that cascade or set-null sensibly.
 */

import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  bigint,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { user } from "./auth";
import { project } from "./project";
import { service } from "./service";
import { servers } from "./servers";
import { mailServers } from "./mail";
import { organization } from "./organization";

// ─── backup_destination ──────────────────────────────────────────────────────

/**
 * A user-owned external storage endpoint. Same shape across S3-compatible,
 * SFTP, and local — kind-specific columns are nullable.
 */
export const backupDestination = pgTable(
  "backup_destination",
  {
    id: text("id").primaryKey(),
    /** Org that owns this destination — THE access primitive. */
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),

    /** User-supplied display name. */
    name: text("name").notNull(),
    /** "s3_compatible" | "sftp" | "openship_server" | "local" | "http_upload" */
    kind: text("kind").notNull(),
    /** When kind="openship_server", points at the user's existing
     *  servers row so we reuse its SSH credentials. ON DELETE SET NULL
     *  so removing a server doesn't cascade-delete backup history. */
    serverId: text("server_id").references(() => servers.id, { onDelete: "set null" }),

    /* ── Public connection identity (never encrypted) ───────────────── */
    endpoint: text("endpoint"),
    region: text("region"),
    bucket: text("bucket"),
    pathPrefix: text("path_prefix"),

    sshHost: text("ssh_host"),
    sshPort: integer("ssh_port"),
    sshUser: text("ssh_user"),

    /* ── Encrypted credentials (enc1: envelope) ─────────────────────── */
    accessKeyIdEnc: text("access_key_id_enc"),
    secretAccessKeyEnc: text("secret_access_key_enc"),
    sftpPasswordEnc: text("sftp_password_enc"),
    sftpPrivateKeyEnc: text("sftp_private_key_enc"),
    sftpKeyPassphraseEnc: text("sftp_key_passphrase_enc"),

    /* ── Provenance / UI affordances ────────────────────────────────── */
    lastVerifiedAt: timestamp("last_verified_at"),
    lastVerifyError: text("last_verify_error"),
    /** Surfaced in the UI as the "default" one-click target. */
    isDefault: boolean("is_default").notNull().default(false),

    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    // Name is unique per org.
    uniqueIndex("uq_backup_destination_org_name_active")
      .on(table.organizationId, table.name)
      .where(sql`${table.deletedAt} IS NULL`),
    index("idx_backup_destination_org").on(table.organizationId),
  ],
);

// ─── backup_policy ───────────────────────────────────────────────────────────

/**
 * Backup rules per (project, service?). A row with serviceId NULL is the
 * project-level default; rows with serviceId set are per-service overrides.
 * The cascade is "pick one" — no JSON merge.
 */
export const backupPolicy = pgTable(
  "backup_policy",
  {
    id: text("id").primaryKey(),
    /**
     * What this policy backs up. "service" (default) = a deployed project
     * service (projectId + optional serviceId). "mail_server" = a bare mail
     * server (mailServerId), which has no project/service.
     */
    sourceKind: text("source_kind").notNull().default("service"),
    /** Null for a mail_server source. */
    projectId: text("project_id").references(() => project.id, {
      onDelete: "cascade",
    }),
    /** NULL = project default. Non-null = service override. */
    serviceId: text("service_id").references(() => service.id, {
      onDelete: "cascade",
    }),
    /** Set when sourceKind="mail_server" — the mail server being backed up. */
    mailServerId: text("mail_server_id").references(() => mailServers.serverId, {
      onDelete: "cascade",
    }),

    /**
     * Destination FK is RESTRICTive on purpose — deleting a destination
     * that has active policies should fail with a clear error so users
     * don't lose schedules silently.
     */
    destinationId: text("destination_id")
      .notNull()
      .references(() => backupDestination.id, { onDelete: "restrict" }),

    enabled: boolean("enabled").notNull().default(true),

    /* ── Scheduling ─────────────────────────────────────────────────── */
    /** Standard 5-field cron expression. Null = manual-only. */
    cronExpression: text("cron_expression"),
    /** Auto-trigger before a new deployment lands (Chunk 2). */
    triggerOnPreDeploy: boolean("trigger_on_pre_deploy").notNull().default(false),
    /** Inbound webhook token. Null = no webhook trigger. Unique. */
    webhookToken: text("webhook_token"),
    webhookLastFiredAt: timestamp("webhook_last_fired_at"),

    /* ── Retention ──────────────────────────────────────────────────── */
    /** Keep at most N successful runs. Null = unlimited (but see retainDays). */
    retainCount: integer("retain_count"),
    /** Delete runs older than N days. Null = no age cap. */
    retainDays: integer("retain_days"),

    /* ── Payload ────────────────────────────────────────────────────── */
    /** Producer-registry kind: "volume" | "pg_dump" | etc. | "auto". */
    payloadKind: text("payload_kind").notNull().default("auto"),
    /** Producer-specific options ({ command, sourceIds, exclude... }). */
    payloadConfig: jsonb("payload_config").$type<Record<string, unknown>>().default({}),

    /* ── Hooks ──────────────────────────────────────────────────────── */
    preHook: text("pre_hook"),
    postHook: text("post_hook"),
    hookTimeoutSeconds: integer("hook_timeout_seconds").notNull().default(300),

    /* ── Encoding ───────────────────────────────────────────────────── */
    compressionAlgo: text("compression_algo").notNull().default("zstd"),
    /** Extra client-side AES on top of TLS. Per-run DEK derived from
     *  BETTER_AUTH_SECRET + runId. */
    encryptionAtRest: boolean("encryption_at_rest").notNull().default(false),

    /* ── Audit ──────────────────────────────────────────────────────── */
    createdBy: text("created_by").references(() => user.id),

    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    // At most one active policy per (project, service). The serviceId
    // NULL row is the project default; non-null rows are overrides.
    // (Postgres treats NULLs as distinct, so mail-server rows — projectId
    // NULL — are naturally excluded from this constraint.)
    uniqueIndex("uq_backup_policy_project_service")
      .on(table.projectId, table.serviceId)
      .where(sql`${table.deletedAt} IS NULL`),
    // At most one active policy per mail server.
    uniqueIndex("uq_backup_policy_mail_server")
      .on(table.mailServerId)
      .where(sql`${table.mailServerId} IS NOT NULL AND ${table.deletedAt} IS NULL`),
    uniqueIndex("uq_backup_policy_webhook_token")
      .on(table.webhookToken)
      .where(sql`${table.webhookToken} IS NOT NULL`),
    index("idx_backup_policy_project").on(table.projectId),
    index("idx_backup_policy_mail_server").on(table.mailServerId),
    index("idx_backup_policy_destination").on(table.destinationId),
  ],
);

// ─── backup_run ──────────────────────────────────────────────────────────────

/**
 * One execution of a backup. Owned by the BackupOrchestrator FSM —
 * status transitions through queued → preparing → snapshotting →
 * uploading → verifying → succeeded/failed/cancelled/server_error.
 */
export const backupRun = pgTable(
  "backup_run",
  {
    id: text("id").primaryKey(),

    // Policy + destination — SET NULL on delete so the run row + its
    // remote artifacts survive their schedule's deletion.
    policyId: text("policy_id").references(() => backupPolicy.id, {
      onDelete: "set null",
    }),
    destinationId: text("destination_id").references(() => backupDestination.id, {
      onDelete: "set null",
    }),

    /** "service" | "mail_server" — mirrors the policy's source kind. */
    sourceKind: text("source_kind").notNull().default("service"),
    projectId: text("project_id").references(() => project.id, { onDelete: "set null" }),
    serviceId: text("service_id").references(() => service.id, { onDelete: "set null" }),
    /** Set when sourceKind="mail_server". SET NULL so history outlives the row. */
    mailServerId: text("mail_server_id").references(() => mailServers.serverId, {
      onDelete: "set null",
    }),

    /** Org that owns this run — THE access primitive. The actor who
     *  triggered the run is captured below in triggeredByUserId. */
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),

    status: text("status").notNull().default("queued"),
    /** "manual" | "cron" | "webhook" | "pre_deploy" */
    triggeredBy: text("triggered_by").notNull(),
    triggeredByUserId: text("triggered_by_user_id").references(() => user.id),
    clientIp: text("client_ip"),

    startedAt: timestamp("started_at").notNull().defaultNow(),
    finishedAt: timestamp("finished_at"),
    /** Bumped at each FSM transition (heartbeat for stale-run detection). */
    lastEventAt: timestamp("last_event_at").notNull().defaultNow(),

    /** Destination key prefix this run wrote to. */
    objectKeyPrefix: text("object_key_prefix"),
    /** Full key of the canonical manifest.json. */
    manifestKey: text("manifest_key"),

    bytesTransferred: bigint("bytes_transferred", { mode: "number" }),
    /** Array<{ name, key, sizeBytes, sha256, payloadKind, metadata }> */
    artifacts: jsonb("artifacts").$type<unknown[]>().default([]),

    /** Truncated to 4 KiB. */
    errorMessage: text("error_message"),
    /** Captured pre/post-hook stdout+stderr (≤ 64 KiB). */
    hookLog: text("hook_log"),

    /** User-set "protect this backup" toggle. Skips retention prune. */
    retentionLockedUntil: timestamp("retention_locked_until"),

    /** Soft delete used when the prune sweep removes destination objects. */
    deletedAt: timestamp("deleted_at"),
  },
  (table) => [
    index("idx_backup_run_org_started").on(table.organizationId, table.startedAt),
    index("idx_backup_run_destination_started").on(table.destinationId, table.startedAt),
    index("idx_backup_run_project_started").on(table.projectId, table.startedAt),
    // Partial index for the boot-time stale-run sweep.
    index("idx_backup_run_in_flight")
      .on(table.status)
      .where(
        sql`${table.status} IN ('queued','preparing','snapshotting','uploading','verifying')`,
      ),
  ],
);

// ─── backup_restore ──────────────────────────────────────────────────────────

/**
 * One restore. RunId is RESTRICTive — we never lose the source run while
 * a restore references it. Confirmation token captured for audit so a
 * future incident can verify the destructive op was intentional.
 */
export const backupRestore = pgTable(
  "backup_restore",
  {
    id: text("id").primaryKey(),

    runId: text("run_id")
      .notNull()
      .references(() => backupRun.id, { onDelete: "restrict" }),
    destinationId: text("destination_id")
      .notNull()
      .references(() => backupDestination.id, { onDelete: "restrict" }),

    projectId: text("project_id").references(() => project.id, { onDelete: "set null" }),
    serviceId: text("service_id").references(() => service.id, { onDelete: "set null" }),

    /** Org that owns this restore — THE access primitive. Actor info
     *  flows through triggeredByUserId / audit_event. */
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),

    status: text("status").notNull().default("queued"),
    /** "in_place" only in v1. "to_fork" reserved for v2. */
    mode: text("mode").notNull().default("in_place"),
    /** Set when mode='to_fork' — the new service row's id. */
    forkServiceId: text("fork_service_id").references(() => service.id, {
      onDelete: "set null",
    }),
    /** Migration target when restoring a mail_server run onto a DIFFERENT
     *  mail server (mode='to_fork'). NULL for in-place restores. */
    forkMailServerId: text("fork_mail_server_id").references(() => mailServers.serverId, {
      onDelete: "set null",
    }),

    startedAt: timestamp("started_at").notNull().defaultNow(),
    finishedAt: timestamp("finished_at"),
    lastEventAt: timestamp("last_event_at").notNull().defaultNow(),

    bytesRestored: bigint("bytes_restored", { mode: "number" }),
    errorMessage: text("error_message"),
    clientIp: text("client_ip"),

    /** Short token user typed to confirm. Stored for audit forensics. */
    confirmationToken: text("confirmation_token"),
  },
  (table) => [
    index("idx_backup_restore_org_started").on(table.organizationId, table.startedAt),
    index("idx_backup_restore_run").on(table.runId),
  ],
);
