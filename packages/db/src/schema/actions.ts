import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type {
  ActionCapabilities,
  ActionJobResult,
  ActionJobSpec,
  ActionGitHubRun,
  ActionGitHubJob,
  ActionWorkflowController,
  ActionWorkflowNotifications,
  ActionRunnerConfig,
  ActionStatus,
  ActionWorkerEvent,
  ActionWorkflowPlan,
  ExecutionAuthority,
} from "@repo/core";
import { organization } from "./organization";
import { servers } from "./servers";
import { backupDestination } from "./backup";
import { project } from "./project";

export const actionRunner = pgTable(
  "action_runner",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    serverId: text("server_id").references(() => servers.id, { onDelete: "restrict" }),
    /** Funded CI namespaces, never monthly application hosts. */
    cloudPoolId: text("cloud_pool_id"),
    /** Catalog profile for a customer-funded pool; null for operator pools. */
    cloudProfileId: text("cloud_profile_id"),
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
    uniqueIndex("action_runner_cloud_profile_unique").on(t.cloudPoolId, t.cloudProfileId),
    check(
      "action_runner_cloud_profile_check",
      sql`${t.cloudProfileId} IS NULL OR ${t.cloudPoolId} IS NOT NULL`,
    ),
    check(
      "action_runner_destination_check",
      sql`(${t.serverId} IS NULL) <> (${t.cloudPoolId} IS NULL)`,
    ),
  ],
);

export interface ActionRunConfiguration {
  owner: string | null;
  repo: string | null;
  path: string;
  defaultBranch: string;
  runnerIds: string[];
  variables: Record<string, string>;
  /** Encrypted at rest, never part of the run view or diagnostics. */
  secrets: Record<string, string>;
  storageDestinationId?: string | null;
  /** Configuration approved when this immutable run was dispatched. */
  workflowVersion?: string;
  notifications?: ActionWorkflowNotifications | null;
  /** Jobs schedules dispatch into this queue; they do not copy the execution. */
  sourceJob?: {
    key: string;
    label: string;
    trigger: string;
    notifyConfig?: { channels: string[]; states: Array<"running" | "success" | "failed"> } | null;
  };
}

export const actionWorkflow = pgTable(
  "action_workflow",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    controller: text("controller").$type<ActionWorkflowController>().notNull().default("openship"),
    githubWorkflowId: text("github_workflow_id"),
    syncAfter: timestamp("sync_after").notNull().defaultNow(),
    syncLeaseOwner: text("sync_lease_owner"),
    syncLeaseUntil: timestamp("sync_lease_until"),
    owner: text("owner"),
    repo: text("repo"),
    path: text("path").notNull(),
    ref: text("ref").notNull(),
    /** Null follows the repository commit. Saved YAML is reviewed explicitly before replacement. */
    source: text("source"),
    definition: jsonb("definition").$type<ActionWorkflowPlan>().notNull(),
    lastError: text("last_error"),
    runnerIds: jsonb("runner_ids").$type<string[]>().notNull(),
    notifications: jsonb("notifications").$type<ActionWorkflowNotifications>(),
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
    index("action_workflow_sync_idx").on(t.controller, t.syncAfter, t.syncLeaseUntil),
    check("action_workflow_controller_check", sql`${t.controller} IN ('openship', 'github')`),
    check(
      "action_workflow_github_check",
      sql`${t.controller} <> 'github' OR (${t.owner} IS NOT NULL AND ${t.repo} IS NOT NULL AND ${t.source} IS NULL AND ${t.githubWorkflowId} IS NOT NULL)`,
    ),
    check(
      "action_workflow_source_check",
      sql`(${t.owner} IS NOT NULL AND ${t.repo} IS NOT NULL) OR (${t.owner} IS NULL AND ${t.repo} IS NULL AND ${t.source} IS NOT NULL)`,
    ),
  ],
);

/** Association, not a workflow copy. A monorepo workflow can check several projects. */
export const actionProject = pgTable(
  "action_project",
  {
    organizationId: text("organization_id").notNull(),
    workflowId: text("workflow_id").notNull(),
    projectId: text("project_id").notNull(),
    required: boolean("required").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workflowId, t.projectId] }),
    foreignKey({
      columns: [t.workflowId, t.organizationId],
      foreignColumns: [actionWorkflow.id, actionWorkflow.organizationId],
      name: "action_project_workflow_owner_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.projectId, t.organizationId],
      foreignColumns: [project.id, project.organizationId],
      name: "action_project_project_owner_fk",
    }).onDelete("cascade"),
    index("action_project_project_idx").on(t.projectId, t.organizationId),
  ],
);

/** Intent retained while CI runs. Only the regular deployment engine activates it. */
export const actionDeployment = pgTable(
  "action_deployment",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    projectId: text("project_id").notNull(),
    revision: text("revision").notNull(),
    ref: text("ref").notNull(),
    requirements: jsonb("requirements").$type<Record<string, string>>().notNull(),
    intent: jsonb("intent")
      .$type<{
        serverId?: string;
        environment?: string;
        commitMessage?: string;
        serviceIds?: string[];
        forceAll?: boolean;
        changedPaths?: string[] | null;
        forcePullImages?: boolean;
        strictServiceScope?: boolean;
        smartRoute?: boolean;
        event?: Record<string, unknown>;
      }>()
      .notNull(),
    authority: jsonb("authority").$type<ExecutionAuthority>().notNull(),
    status: text("status")
      .$type<
        "waiting" | "blocked" | "deploying" | "deployed" | "superseded" | "failed" | "cancelled"
      >()
      .notNull()
      .default("waiting"),
    deploymentId: text("deployment_id"),
    error: text("error"),
    leaseOwner: text("lease_owner"),
    leaseUntil: timestamp("lease_until"),
    retryAt: timestamp("retry_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.projectId, t.organizationId],
      foreignColumns: [project.id, project.organizationId],
      name: "action_deployment_project_owner_fk",
    }).onDelete("cascade"),
    uniqueIndex("action_deployment_commit_unique").on(t.projectId, t.revision),
    index("action_deployment_pending_idx").on(t.status, t.retryAt),
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
    controller: text("controller").$type<ActionWorkflowController>().notNull().default("openship"),
    github: jsonb("github").$type<ActionGitHubRun>(),
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
    uniqueIndex("action_run_number_attempt_unique").on(
      t.workflowId,
      t.controller,
      t.number,
      t.attempt,
    ),
    foreignKey({
      columns: [t.workflowId, t.organizationId],
      foreignColumns: [actionWorkflow.id, actionWorkflow.organizationId],
      name: "action_run_workflow_owner_fk",
    }).onDelete("restrict"),
    index("action_run_workflow_created_idx").on(t.workflowId, t.createdAt),
    index("action_run_pending_idx").on(t.settledAt, t.leaseUntil),
    index("action_run_concurrency_idx").on(t.organizationId, t.concurrencyGroup, t.status),
    check("action_run_controller_check", sql`${t.controller} IN ('openship', 'github')`),
    uniqueIndex("action_run_github_unique").on(
      t.organizationId,
      sql`(${t.github}->>'id')`,
      t.attempt,
    ),
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
    github: jsonb("github").$type<ActionGitHubJob>(),
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

/** GitHub assigns jobs to ephemeral runner registrations. A registration is a
 * capacity lease, not a second workflow job or source of workflow results. */
export const actionRunnerSession = pgTable(
  "action_runner_session",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    workflowId: text("workflow_id").notNull(),
    runnerId: text("runner_id").notNull(),
    demandJobId: text("demand_job_id").notNull(),
    repoOwner: text("repo_owner").notNull(),
    repoName: text("repo_name").notNull(),
    runnerName: text("runner_name").notNull(),
    githubRunnerId: text("github_runner_id"),
    registration: text("registration"),
    registrationExpiresAt: timestamp("registration_expires_at"),
    spec: jsonb("spec").$type<ActionJobSpec>().notNull(),
    directory: text("directory"),
    workerBinary: text("worker_binary"),
    providerWorkspaceId: text("provider_workspace_id"),
    providerRequestedAt: timestamp("provider_requested_at"),
    workerStartedAt: timestamp("worker_started_at"),
    lastEventSequence: integer("last_event_sequence").notNull().default(0),
    state: text("state")
      .$type<"preparing" | "listening" | "running" | "stopping" | "finished">()
      .notNull()
      .default("preparing"),
    cancelRequestedAt: timestamp("cancel_requested_at"),
    finishedAt: timestamp("finished_at"),
    cleanedAt: timestamp("cleaned_at"),
    leaseOwner: text("lease_owner"),
    leaseUntil: timestamp("lease_until"),
    error: text("error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.workflowId, t.organizationId],
      foreignColumns: [actionWorkflow.id, actionWorkflow.organizationId],
      name: "action_runner_session_workflow_owner_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.runnerId, t.organizationId],
      foreignColumns: [actionRunner.id, actionRunner.organizationId],
      name: "action_runner_session_runner_owner_fk",
    }).onDelete("restrict"),
    uniqueIndex("action_runner_session_name_unique").on(t.runnerName),
    uniqueIndex("action_runner_session_demand_unique")
      .on(t.organizationId, t.demandJobId)
      .where(sql`${t.cleanedAt} IS NULL`),
    index("action_runner_session_pending_idx").on(t.cleanedAt, t.leaseUntil),
  ],
);

/** Outbound commands have durable receipts because GitHub dispatch/rerun do
 * not accept an idempotency key. An uncertain response is never replayed. */
export const actionCommand = pgTable(
  "action_command",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    workflowId: text("workflow_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    state: text("state")
      .$type<"submitted" | "accepted" | "uncertain" | "rejected">()
      .notNull()
      .default("submitted"),
    remoteRunId: text("remote_run_id"),
    remoteAttempt: integer("remote_attempt"),
    sourceJob: jsonb("source_job").$type<ActionRunConfiguration["sourceJob"]>(),
    error: text("error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("action_command_key_unique").on(t.organizationId, t.idempotencyKey),
    foreignKey({
      columns: [t.workflowId, t.organizationId],
      foreignColumns: [actionWorkflow.id, actionWorkflow.organizationId],
      name: "action_command_workflow_owner_fk",
    }).onDelete("cascade"),
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
