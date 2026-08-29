import {
  pgTable,
  text,
  timestamp,
  integer,
  boolean,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organization } from "./organization";
import { project } from "./project";
import { service } from "./service";
import { servers } from "./servers";

/** Incident kinds, ordered by severity — an incident escalates upward, never down. */
export const INCIDENT_KINDS = [
  "unhealthy",
  "crash_loop",
  "down",
  "server_unreachable",
] as const;
export type IncidentKind = (typeof INCIDENT_KINDS)[number];

/**
 * A container health incident — the durable memory behind the health alerts.
 *
 * The health watch polls every server's Docker daemon once a minute, but a poller
 * that alerts on "this container isn't running" gets muted within a day: a redeploy
 * recreating containers, an operator's `docker stop`, an unreachable host, and a
 * crash loop are all indistinguishable from a real failure at a point in time. So
 * the unit of alerting is an incident — opened once, escalated only when it gets
 * worse, resolved once with a downtime duration — and this table is what makes that
 * survive a control-plane restart (a box down for three days must not re-page on
 * every API restart). It also backs the project Health tab's history.
 */
export const serviceIncident = pgTable(
  "service_incident",
  {
    id: text("id").primaryKey(), // "inc_..."
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /**
     * Null for SERVER-scoped incidents: an unreachable box gets ONE incident, not one
     * per service on it. That fan-out is the single loudest source of alert fatigue.
     */
    projectId: text("project_id").references(() => project.id, { onDelete: "cascade" }),
    /**
     * The resolved service row, when there is one. SET NULL rather than cascade —
     * deleting a service must not erase the record of the outage it had.
     */
    serviceId: text("service_id").references(() => service.id, { onDelete: "set null" }),
    /**
     * Identity that survives a container RECREATE, which is the whole point: every
     * deploy mints a new container id, so keying on container id would open a fresh
     * incident for the same workload after each redeploy. Service id when resolved,
     * else the container name (single-app deploys have no service row);
     * `server:<id>` for server-scoped rows.
     */
    serviceKey: text("service_key").notNull(),
    /** Display name snapshotted at incident time, so a later rename can't rewrite
     *  what an alert or a history row said. */
    serviceName: text("service_name").notNull(),
    serverId: text("server_id").references(() => servers.id, { onDelete: "set null" }),
    containerId: text("container_id"),
    /** unhealthy | crash_loop | down | server_unreachable (severity order). */
    kind: text("kind").$type<IncidentKind>().notNull(),
    /** open | resolved */
    status: text("status").notNull().default("open"),
    reason: text("reason"),
    exitCode: integer("exit_code"),
    restartCount: integer("restart_count").notNull().default(0),
    oomKilled: boolean("oom_killed").notNull().default(false),
    /**
     * Consecutive ticks that agreed on this verdict. An incident only opens (and only
     * notifies) at >= 2, so a sample taken mid-restart or during a slow healthcheck
     * start never pages anyone.
     */
    confirmations: integer("confirmations").notNull().default(0),
    /** A count, not a flag: open, escalation and resolve each notify exactly once. */
    notifyCount: integer("notify_count").notNull().default(0),
    notifiedAt: timestamp("notified_at"),
    logExcerpt: text("log_excerpt"),
    openedAt: timestamp("opened_at").notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at"),
    /**
     * Last tick that actually OBSERVED this workload. NOT advanced while the host is
     * unreachable — during a connectivity loss we know nothing, so nothing is claimed.
     */
    lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // "We are already alerting about this" as a DB invariant rather than sweep
    // bookkeeping: two overlapping ticks (a manual Run now landing on a cron tick)
    // cannot both open one and double-notify.
    uniqueIndex("uq_service_incident_open")
      .on(t.projectId, t.serviceKey)
      .where(sql`${t.status} = 'open' AND ${t.projectId} IS NOT NULL`),
    // Same invariant for server-scoped rows — needs its own index because Postgres
    // treats NULLs as distinct, so the index above would allow a second open row.
    uniqueIndex("uq_service_incident_open_server")
      .on(t.serverId)
      .where(sql`${t.status} = 'open' AND ${t.projectId} IS NULL`),
    index("idx_service_incident_project").on(t.projectId, t.openedAt.desc()),
    // The global Issues feed asks a different question than any existing index
    // answers: every incident in ONE organization, newest first — including
    // server-scoped rows, which a project-keyed index cannot serve at all
    // (`project_id IS NULL`). Matters most for the Resolved tab, which sorts
    // org-wide over the full retention window.
    index("idx_service_incident_org").on(t.organizationId, t.openedAt.desc()),
  ],
);
