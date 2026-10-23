import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  integer,
  timestamp,
  jsonb,
  unique,
  index,
  check,
} from "drizzle-orm/pg-core";
import type { AutoscaleEvent, ClusterScalePrecondition } from "@repo/core";
import { project } from "./project";

export interface AutoscalePendingScale extends ClusterScalePrecondition {
  deploymentId: string;
  clusterId: string;
  projectUpdatedAt: string;
  toReplicas: number;
  event: Omit<AutoscaleEvent, "id">;
  cooldownSeconds: number;
}

/** One autoscaling policy per project. Only an enabled policy with NULL suspendedAt owns the replica count; any other actor writes a reason before resuming is
 * allowed through the dashboard's re-arm. */
export const projectAutoscalePolicy = pgTable(
  "project_autoscale_policy",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    enabled: integer("enabled").notNull().default(0),
    targetCpuPercent: integer("target_cpu_percent").notNull(),
    minReplicas: integer("min_replicas").notNull(),
    maxReplicas: integer("max_replicas").notNull(),
    stepSize: integer("step_size").notNull().default(1),
    cooldownSeconds: integer("cooldown_seconds").notNull().default(120),
    suspendAfterFailures: integer("suspend_after_failures").notNull().default(3),
    /** Failure backoff: next attempt no earlier than this instant. */
    nextAttemptAt: timestamp("next_attempt_at"),
    failureCount: integer("failure_count").notNull().default(0),
    suspendedAt: timestamp("suspended_at"),
    suspendedReason: text("suspended_reason"),
    pendingScale: jsonb("pending_scale").$type<AutoscalePendingScale | null>(),
    lastDecision: jsonb("last_decision").$type<AutoscaleEvent | null>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("project_autoscale_policy_project_id_unique").on(table.projectId),
    check(
      "project_autoscale_policy_failures_check",
      sql`${table.suspendAfterFailures} BETWEEN 1 AND 10`,
    ),
    check("project_autoscale_policy_cpu_check", sql`${table.targetCpuPercent} BETWEEN 1 AND 100`),
    check(
      "project_autoscale_policy_bounds_check",
      sql`${table.minReplicas} >= 1 AND ${table.maxReplicas} >= ${table.minReplicas} AND ${table.maxReplicas} <= 100`,
    ),
    check(
      "project_autoscale_policy_step_check",
      sql`${table.stepSize} BETWEEN 1 AND 10 AND ${table.cooldownSeconds} >= 30 AND ${table.cooldownSeconds} <= 3600`,
    ),
  ],
);

/** Recent decisions per project — the "why did it scale" trail. Rows are
 * pruned on insert so one hot project cannot grow this table unbounded. */
export const projectAutoscaleEvent = pgTable(
  "project_autoscale_event",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    action: text("action").$type<AutoscaleEvent["action"]>().notNull(),
    fromReplicas: integer("from_replicas").notNull(),
    toReplicas: integer("to_replicas"),
    observedCpuPercent: integer("observed_cpu_percent"),
    cooldownSeconds: integer("cooldown_seconds"),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [index("project_autoscale_event_recent_idx").on(table.projectId, table.createdAt)],
);
