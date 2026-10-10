import {
  pgTable,
  text,
  timestamp,
  bigint,
  uniqueIndex,
  index,
  integer,
  jsonb,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { DeploymentCheckSource } from "@repo/core";
import { deployment } from "./deployment";
import { serviceDeployment } from "./service";

// ─── Deployment check runs (GitHub Checks rollup + per-service) ─────────────

/**
 * Durable delivery intent and GitHub `check_run` mirrors for one attempt.
 * The unique rollup owns the captured source, preferences and delivery lease,
 * even when only service Checks are selected. Service mirrors are unique by
 * name within the attempt, so failures before runtime startup still report.
 * Remote IDs and service-deployment links are filled in as delivery progresses.
 * New deployment attempts get new rows; transport retries update the same Check.
 */
export const deploymentCheckRun = pgTable(
  "deployment_check_run",
  {
    id: text("id").primaryKey(), // "dcr_..."
    deploymentId: text("deployment_id")
      .notNull()
      .references(() => deployment.id, { onDelete: "cascade" }),
    /** GitHub `check_run.id` — bigint because the id space exceeds 32-bit. */
    checkRunId: bigint("check_run_id", { mode: "number" }),
    /** Stable project/environment name, with a service suffix for service Checks. */
    name: text("name").notNull(),
    /** Discriminator: `"rollup"` (project-level) | `"service"` (per-service mirror). */
    kind: text("kind").notNull(),
    /** Reference to the per-service deploy row for `kind = "service"`; null for rollup. */
    serviceDeploymentId: text("service_deployment_id").references(
      () => serviceDeployment.id,
      { onDelete: "cascade" },
    ),
    /** GitHub check-run lifecycle status: `queued | in_progress | completed`. */
    status: text("status").notNull(),
    /** GitHub check-run conclusion (only set when status = completed): `success | failure | neutral | cancelled | skipped | timed_out | action_required | stale`. */
    conclusion: text("conclusion"),
    /** Rollup rows also own the durable delivery queue, even for service-only reporting. */
    source: jsonb("source").$type<DeploymentCheckSource>(),
    /** Service identity exists before a runtime service_deployment row is created. */
    serviceName: text("service_name"),
    publishedDigest: text("published_digest"),
    nextAttemptAt: timestamp("next_attempt_at"),
    leaseToken: text("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("ix_deployment_check_run_due").on(t.nextAttemptAt)
      .where(sql`${t.kind} = 'rollup' and ${t.nextAttemptAt} is not null`),
    uniqueIndex("uq_deployment_check_run_service_name").on(t.deploymentId, t.serviceName)
      .where(sql`${t.kind} = 'service'`),
    // Rollup: exactly one row per deployment with kind = "rollup".
    // Partial index because NULL is distinct in PG unique indexes by
    // default — a non-partial unique over (deployment_id, kind,
    // service_deployment_id) would let multiple rollup rows coexist.
    uniqueIndex("uq_deployment_check_run_rollup")
      .on(t.deploymentId)
      .where(sql`${t.kind} = 'rollup'`),
    // Per-service: at most one row per (deployment, service_deployment)
    // pair. Partial because rollup rows have NULL service_deployment_id
    // and should not participate in this constraint.
    uniqueIndex("uq_deployment_check_run_service")
      .on(t.deploymentId, t.serviceDeploymentId)
      .where(sql`${t.serviceDeploymentId} IS NOT NULL`),
    // Note: no secondary `ix_deployment_check_run_deployment` —
    // deployment_id is the leading column of both unique indexes
    // above, which already serve the "all rows for a deployment"
    // lookup path.
  ],
);
