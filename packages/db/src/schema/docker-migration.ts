/**
 * Docker migration run — one execution of "migrate a server's existing Docker
 * stack into Openship". Owned by the MigrationOrchestrator FSM. Sibling in
 * spirit to backup_run/backup_restore. Adds NO columns to existing tables; all
 * cross-references cascade or set-null.
 *
 * Flow: adopt (create the project) → moving_data (tar named volumes A→B,
 * skipped when same-server) → deploying (deploy on the target) → verifying →
 * awaiting_cutover → cutover (opt-in stop/remove of A's originals) → succeeded.
 * Any pre-cutover failure → rolled_back (tear down B, restart A).
 */

import {
  pgTable,
  text,
  timestamp,
  boolean,
  bigint,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organization } from "./organization";
import { project } from "./project";
import { servers } from "./servers";

export const dockerMigrationRun = pgTable(
  "docker_migration_run",
  {
    id: text("id").primaryKey(),

    /** Org that owns this run — THE access primitive. */
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),

    /** Source (where the containers run) and target (where they land). May be
     *  equal (same-server). SET NULL so history outlives the server rows. */
    sourceServerId: text("source_server_id").references(() => servers.id, {
      onDelete: "set null",
    }),
    targetServerId: text("target_server_id").references(() => servers.id, {
      onDelete: "set null",
    }),

    /** The adopted Openship project. */
    projectId: text("project_id").references(() => project.id, { onDelete: "set null" }),
    projectName: text("project_name").notNull(),
    serviceNames: jsonb("service_names").$type<string[]>().notNull().default([]),

    /** FSM: queued|adopting|moving_data|deploying|verifying|awaiting_cutover|cutover|succeeded|failed|rolled_back|partial
     *  `partial` = target verified + UP, but some paths didn't move (missing /
     *  denied / errored). Parked like awaiting_cutover (source stopped-but-kept,
     *  cutover gated) until the pending items are resolved + resumed to full. */
    status: text("status").notNull().default("queued"),
    /** "cross_server" | "same_server" */
    mode: text("mode").notNull().default("cross_server"),

    /** The target-side deployment this run kicked. */
    deploymentId: text("deployment_id"),
    /** Stop+remove A's originals after B verifies healthy (opt-in). */
    killOriginals: boolean("kill_originals").notNull().default(false),
    /** Token the user presents to confirm the destructive cutover. */
    confirmationToken: text("confirmation_token"),

    /** Per-service volume plan: Array<{ serviceName, volumes:[{name,sourceId}] }>. */
    volumePlan: jsonb("volume_plan").$type<unknown[]>().default([]),
    /** serviceName → source container id (captured at scan; drives cutover + rollback). */
    scannedContainerIds: jsonb("scanned_container_ids")
      .$type<Record<string, string>>()
      .default({}),

    bytesMoved: bigint("bytes_moved", { mode: "number" }),
    /** Truncated to 4 KiB. */
    errorMessage: text("error_message"),
    /** Durable session log (newline-joined, throttled-flushed, truncated to
     *  256 KiB) so a failed or reloaded run can be debugged after the fact —
     *  the in-memory progress/log buffers don't survive a client reload. */
    logs: text("logs"),

    /** Items that did NOT transfer (a `partial` run's to-do list): each
     *  { key, kind:"volume"|"bind"|"path", source, dest?, serviceName?, reason }.
     *  Resolved (edit path / skip) + resumed to complete the migration. */
    pendingItems: jsonb("pending_items").$type<unknown[]>().default([]),
    /** Snapshot of the sanitized start input, so a `partial` run can be resumed
     *  and a `failed` run can be re-opened pre-filled (edit & retry). */
    inputSnapshot: jsonb("input_snapshot").$type<Record<string, unknown> | null>(),
    /** Volume names this run WROTE on the TARGET (cross-server). After a failed
     *  deploy the rollback leaves these copies behind (never wipes data blindly);
     *  the user can opt to remove them so a retry starts clean instead of hitting
     *  "target already has data". Excludes "keep"-resolved (pre-existing) volumes. */
    targetVolumes: jsonb("target_volumes").$type<string[]>().default([]),

    startedAt: timestamp("started_at").notNull().defaultNow(),
    finishedAt: timestamp("finished_at"),
    /** Bumped at each FSM transition (heartbeat for stale-run detection). */
    lastEventAt: timestamp("last_event_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_docker_migration_run_org_started").on(
      table.organizationId,
      table.startedAt,
    ),
    // Partial index for the boot-time stale-run sweep.
    index("idx_docker_migration_run_in_flight")
      .on(table.status)
      .where(
        sql`${table.status} IN ('queued','adopting','moving_data','deploying','verifying','awaiting_cutover','cutover')`,
      ),
  ],
);
