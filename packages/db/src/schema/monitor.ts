/**
 * Uptime monitor tables.
 *
 * A monitor is a per-project HTTP probe the API's monitor runner executes
 * on a fixed interval:
 *
 *   runner tick → claimDue() → GET each monitor's URL
 *     → monitor_check row recorded (ok/statusCode/responseMs)
 *     → threshold state machine updates monitor.status
 *     → down/recovered transitions open/resolve monitor_incident rows
 *       and emit monitor.down / monitor.recovered notifications
 *
 * Tables:
 *   - monitor           probe config + denormalized runner state
 *   - monitor_check     one row per probe (pruned after 7 days by the runner)
 *   - monitor_incident  one row per continuous downtime window
 */

import { pgTable, text, timestamp, boolean, integer, index } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { organization } from "./organization";
import { project } from "./project";

// ─── monitor ─────────────────────────────────────────────────────────────────
// Probe configuration plus the runner's current view of the target.

export const monitor = pgTable(
  "monitor",
  {
    id: text("id").primaryKey(), // "mon_..."
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    /** Creator, for display only. ON DELETE SET NULL — monitors outlive
     *  the user who added them. */
    createdBy: text("created_by").references(() => user.id, {
      onDelete: "set null",
    }),

    /** Display label ("Marketing site", "API health"). */
    name: text("name").notNull(),
    /** Probed URL — any http(s) URL, including private/internal hosts
     *  (self-hosted only; see the webhook-channel precedent). */
    url: text("url").notNull(),
    /** Seconds between probes. */
    intervalSeconds: integer("interval_seconds").notNull().default(60),
    /** Per-probe abort timeout. */
    timeoutMs: integer("timeout_ms").notNull().default(10000),
    /** Exact status code required for success. Null = any status < 400. */
    expectedStatus: integer("expected_status"),
    /** Consecutive failures before the monitor flips to "down". */
    failureThreshold: integer("failure_threshold").notNull().default(3),

    /** Soft-disable without deleting — preserves check/incident history. */
    enabled: boolean("enabled").notNull().default(true),

    /** "unknown" | "up" | "down". Stored as text so new states need no
     *  schema migration. "unknown" until the first probe completes. */
    status: text("status").notNull().default("unknown"),
    /** Failure streak driving the threshold state machine. Reset on
     *  every successful probe. */
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    /** Null until first probe — claimDue treats null as immediately due. */
    lastCheckedAt: timestamp("last_checked_at"),
    lastStatusCode: integer("last_status_code"),
    lastResponseMs: integer("last_response_ms"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_monitor_project").on(table.projectId),
    // Runner due-scan: enabled monitors whose lastCheckedAt is stale.
    index("idx_monitor_due").on(table.enabled, table.lastCheckedAt),
  ],
);

// ─── monitor_check ───────────────────────────────────────────────────────────
// One row per probe, success or failure. Powers the uptime % and the
// response-time chart. The runner prunes rows older than 7 days so the
// table can't grow unbounded.

export const monitorCheck = pgTable(
  "monitor_check",
  {
    id: text("id").primaryKey(), // "mck_..."
    monitorId: text("monitor_id")
      .notNull()
      .references(() => monitor.id, { onDelete: "cascade" }),

    checkedAt: timestamp("checked_at").notNull().defaultNow(),
    ok: boolean("ok").notNull(),
    /** Null when the probe never got a response (timeout, DNS, refused). */
    statusCode: integer("status_code"),
    responseMs: integer("response_ms"),
    /** Failure message (fetch error, "expected 200 got 503", ...). */
    error: text("error"),
  },
  (table) => [
    // Chart + uptime queries: recent checks for one monitor.
    index("idx_monitor_check_monitor_checked").on(table.monitorId, table.checkedAt),
  ],
);

// ─── monitor_incident ────────────────────────────────────────────────────────
// One row per continuous downtime window: opened when the failure
// threshold is crossed, resolved on the first successful probe after.

export const monitorIncident = pgTable(
  "monitor_incident",
  {
    id: text("id").primaryKey(), // "mi_..."
    monitorId: text("monitor_id")
      .notNull()
      .references(() => monitor.id, { onDelete: "cascade" }),
    /** Denormalized from the monitor so incident queries don't join. */
    organizationId: text("organization_id").notNull(),
    projectId: text("project_id").notNull(),

    startedAt: timestamp("started_at").notNull().defaultNow(),
    /** Null while the incident is ongoing. */
    resolvedAt: timestamp("resolved_at"),
    /** Last failure message observed during the incident. */
    error: text("error"),
    /** Failed probes counted while the incident was open. */
    failedChecks: integer("failed_checks").notNull().default(0),
  },
  (table) => [
    // Incident history: incidents for one monitor newest-first.
    index("idx_monitor_incident_monitor_started").on(table.monitorId, table.startedAt),
  ],
);
