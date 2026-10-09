import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type {
  ActionCapabilities,
  ActionJobResult,
  ActionJobSpec,
  ActionRunnerConfig,
  ActionStatus,
  ActionWorkerEvent,
  ActionWorkflowPlan,
  ExecutionAuthority,
} from "@repo/core";
import { organization } from "./organization";
import { servers } from "./servers";
import { backupDestination } from "./backup";

export const actionRunner = pgTable(
  "action_runner",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    serverId: text("server_id").references(() => servers.id, { onDelete: "restrict" }),
    /** Cloud pools are operator-provisioned, funded CI namespaces, never monthly app hosts. */
    cloudPoolId: text("cloud_pool_id"),
    config: jsonb("config").$type<ActionRunnerConfig>().notNull(),
    capabilities: jsonb("capabilities").$type<ActionCapabilities>(),
    enabled: boolean("enabled").notNull().default(true),
    checkedAt: timestamp("checked_at"),
    error: text("error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("action_runner_owner_unique").on(t.id, t.organizationId),
    index("action_runner_org_idx").on(t.organizationId),
    // One native/container lease policy per physical destination prevents two
    // configurations from accidentally multiplying its allowed concurrency.
    uniqueIndex("action_runner_server_unique").on(t.serverId),
    check(
      "action_runner_destination_check",
      sql`(${t.serverId} IS NULL) <> (${t.cloudPoolId} IS NULL)`,
    ),
  ],
);

export interface ActionRunConfiguration {
  owner: string;
  repo: string;
  path: string;
  defaultBranch: string;
  runnerIds: string[];
  variables: Record<string, string>;
  /** Encrypted at rest, never part of the run view or diagnostics. */
  secrets: Record<string, string>;
  storageDestinationId?: string | null;
}

export const actionWorkflow = pgTable(
  "action_workflow",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    owner: text("owner").notNull(),
    repo: text("repo").notNull(),
    path: text("path").notNull(),
    ref: text("ref").notNull(),
    /** Null follows the repository file. Inline workflows are explicitly configured by an administrator. */
    source: text("source"),
    definition: jsonb("definition").$type<ActionWorkflowPlan>().notNull(),
    lastError: text("last_error"),
    runnerIds: jsonb("runner_ids").$type<string[]>().notNull(),
    variables: jsonb("variables").$type<Record<string, string>>().notNull().default({}),
    secrets: jsonb("secrets").$type<Record<string, string>>().notNull().default({}),
    storageDestinationId: text("storage_destination_id").references(() => backupDestination.id, {
      onDelete: "restrict",
    }),
    authority: jsonb("authority").$type<ExecutionAuthority>().notNull(),
    enabled: boolean("enabled").notNull().default(true),
    /** Fork PRs may only use a disposable Cloud VM after explicit approval. */
    allowForks: boolean("allow_forks").notNull().default(false),
    nextNumber: integer("next_number").notNull().default(1),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("action_workflow_owner_unique").on(t.id, t.organizationId),
    uniqueIndex("action_workflow_repo_path_unique").on(t.organizationId, t.owner, t.repo, t.path),
    index("action_workflow_repo_idx").on(t.owner, t.repo),
  ],
);

export const actionRun = pgTable(
  "action_run",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    workflowId: text("workflow_id").notNull(),
    number: integer("number").notNull(),
    attempt: integer("attempt").notNull().default(1),
    originalRunId: text("original_run_id"),
    /** Includes workflow, delivery/dispatch identity and immutable ref. */
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status").$type<ActionStatus>().notNull().default("queued"),
    source: text("source").notNull(),
    plan: jsonb("plan").$type<ActionWorkflowPlan>().notNull(),
    configuration: jsonb("configuration").$type<ActionRunConfiguration>().notNull(),
    authority: jsonb("authority").$type<ExecutionAuthority>().notNull(),
    revision: text("revision").notNull(),
    ref: text("ref").notNull(),
    eventName: text("event_name").notNull(),
    event: jsonb("event").$type<Record<string, unknown>>().notNull(),
    inputs: jsonb("inputs").$type<Record<string, unknown>>().notNull().default({}),
    actor: text("actor").notNull(),
    untrusted: boolean("untrusted").notNull().default(false),
    approvedAt: timestamp("approved_at"),
    approvedBy: text("approved_by"),
    concurrencyGroup: text("concurrency_group"),
    cancelInProgress: boolean("cancel_in_progress").notNull().default(false),
    expandedJobs: jsonb("expanded_jobs").$type<string[]>().notNull().default([]),
    cancelRequestedAt: timestamp("cancel_requested_at"),
    leaseOwner: text("lease_owner"),
    leaseUntil: timestamp("lease_until"),
    error: text("error"),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
    /** Cleanup/check delivery can continue after the visible run has completed. */
    settledAt: timestamp("settled_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("action_run_owner_unique").on(t.id, t.organizationId),
    uniqueIndex("action_run_idempotency_unique").on(t.organizationId, t.idempotencyKey),
    uniqueIndex("action_run_number_attempt_unique").on(t.workflowId, t.number, t.attempt),
    foreignKey({
      columns: [t.workflowId, t.organizationId],
      foreignColumns: [actionWorkflow.id, actionWorkflow.organizationId],
      name: "action_run_workflow_owner_fk",
    }).onDelete("restrict"),
    index("action_run_workflow_created_idx").on(t.workflowId, t.createdAt),
    index("action_run_pending_idx").on(t.settledAt, t.leaseUntil),
    index("action_run_concurrency_idx").on(t.organizationId, t.concurrencyGroup, t.status),
  ],
);

export const actionJob = pgTable(
  "action_job",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    runId: text("run_id").notNull(),
    jobKey: text("job_key").notNull(),
    matrixIndex: integer("matrix_index").notNull(),
    spec: jsonb("spec").$type<ActionJobSpec>(),
    status: text("status").$type<ActionStatus>().notNull().default("queued"),
    runnerId: text("runner_id"),
    /** Fixed path derived from the random job ID, retained until verified cleanup. */
    directory: text("directory"),
    workerBinary: text("worker_binary"),
    providerWorkspaceId: text("provider_workspace_id"),
    providerRequestedAt: timestamp("provider_requested_at"),
    workerStartedAt: timestamp("worker_started_at"),
    lastEventSequence: integer("last_event_sequence").notNull().default(0),
    logBytes: integer("log_bytes").notNull().default(0),
    result: jsonb("result").$type<ActionJobResult>(),
    error: text("error"),
    checkRunId: text("check_run_id"),
    checkStatus: text("check_status"),
    checkError: text("check_error"),
    checkRetryAt: timestamp("check_retry_at"),
    cancelRequestedAt: timestamp("cancel_requested_at"),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
    cleanedAt: timestamp("cleaned_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("action_job_owner_unique").on(t.id, t.organizationId),
    uniqueIndex("action_job_matrix_unique").on(t.runId, t.jobKey, t.matrixIndex),
    foreignKey({
      columns: [t.runId, t.organizationId],
      foreignColumns: [actionRun.id, actionRun.organizationId],
      name: "action_job_run_owner_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.runnerId, t.organizationId],
      foreignColumns: [actionRunner.id, actionRunner.organizationId],
      name: "action_job_runner_owner_fk",
    }).onDelete("restrict"),
    index("action_job_runner_active_idx").on(t.runnerId, t.cleanedAt),
  ],
);

export const actionEvent = pgTable(
  "action_event",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    runId: text("run_id").notNull(),
    jobId: text("job_id").notNull(),
    sequence: integer("sequence").notNull(),
    event: jsonb("event").$type<ActionWorkerEvent>().notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("action_event_job_sequence_unique").on(t.jobId, t.sequence),
    foreignKey({
      columns: [t.runId, t.organizationId],
      foreignColumns: [actionRun.id, actionRun.organizationId],
      name: "action_event_run_owner_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.jobId, t.organizationId],
      foreignColumns: [actionJob.id, actionJob.organizationId],
      name: "action_event_job_owner_fk",
    }).onDelete("cascade"),
    index("action_event_run_idx").on(t.runId, t.createdAt),
  ],
);

/** Verified webhook work, persisted before acknowledging GitHub. The feed stays
 * metadata-only; private event payloads are cleared as soon as processing ends. */
export const actionDelivery = pgTable(
  "action_delivery",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    workflowId: text("workflow_id").notNull(),
    deliveryId: text("delivery_id").notNull(),
    eventName: text("event_name").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    attempts: integer("attempts").notNull().default(0),
    retryAt: timestamp("retry_at").notNull().defaultNow(),
    leaseOwner: text("lease_owner"),
    leaseUntil: timestamp("lease_until"),
    error: text("error"),
    finishedAt: timestamp("finished_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("action_delivery_workflow_unique").on(t.workflowId, t.deliveryId),
    foreignKey({
      columns: [t.workflowId, t.organizationId],
      foreignColumns: [actionWorkflow.id, actionWorkflow.organizationId],
      name: "action_delivery_workflow_owner_fk",
    }).onDelete("cascade"),
    index("action_delivery_pending_idx").on(t.finishedAt, t.retryAt, t.leaseUntil),
  ],
);
