/**
 * Uptime monitor repos — monitors, checks, incidents.
 *
 * Caller layering:
 *   - HTTP controllers (project Monitoring tab) → monitor + check + incident repos
 *   - Monitor runner (lib/monitor-runner)       → claimDue + recordCheckResult
 *                                                 + check insert + incident open/resolve
 *
 * Access scoping is enforced at the controller layer (monitors are nested
 * under a project the caller must own); these repos take projectId as the
 * canonical filter and DO NOT cross-check membership themselves.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { generateId } from "@repo/core";
import type { Database } from "../client";
import { monitor, monitorCheck, monitorIncident } from "../schema/monitor";

// ─── Types ───────────────────────────────────────────────────────────────────

export type Monitor = typeof monitor.$inferSelect;
export type NewMonitor = typeof monitor.$inferInsert;
export type MonitorCheck = typeof monitorCheck.$inferSelect;
export type NewMonitorCheck = typeof monitorCheck.$inferInsert;
export type MonitorIncident = typeof monitorIncident.$inferSelect;
export type NewMonitorIncident = typeof monitorIncident.$inferInsert;

export type MonitorStatus = "unknown" | "up" | "down";

// ─── monitor repo ────────────────────────────────────────────────────────────

export function createMonitorRepo(db: Database) {
  return {
    /** List monitors for a project — newest first. Includes disabled rows
     *  so the Monitoring tab can show their enabled toggle. */
    async listByProject(projectId: string): Promise<Monitor[]> {
      return db
        .select()
        .from(monitor)
        .where(eq(monitor.projectId, projectId))
        .orderBy(desc(monitor.createdAt));
    },

    async findById(id: string): Promise<Monitor | undefined> {
      const [row] = await db.select().from(monitor).where(eq(monitor.id, id)).limit(1);
      return row;
    },

    async create(data: Omit<NewMonitor, "id" | "createdAt" | "updatedAt">): Promise<Monitor> {
      const id = generateId("mon");
      const [row] = await db
        .insert(monitor)
        .values({ id, ...data })
        .returning();
      return row;
    },

    async update(
      id: string,
      data: Partial<Omit<NewMonitor, "id" | "organizationId" | "projectId" | "createdAt">>,
    ): Promise<Monitor | undefined> {
      const [row] = await db
        .update(monitor)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(monitor.id, id))
        .returning();
      return row;
    },

    async remove(id: string): Promise<void> {
      await db.delete(monitor).where(eq(monitor.id, id));
    },

    /**
     * Runner due-scan: enabled monitors that have never been probed or
     * whose last probe is older than their own intervalSeconds. Both the
     * comparison and the lastCheckedAt stamp (recordCheckResult) live in
     * the database clock domain (now()), so a skewed app clock can't make
     * a just-checked monitor look due (or vice versa). Never-checked
     * monitors sort first — they are the most overdue.
     */
    async claimDue(limit = 25): Promise<Monitor[]> {
      return db
        .select()
        .from(monitor)
        .where(
          and(
            eq(monitor.enabled, true),
            sql`(${monitor.lastCheckedAt} IS NULL OR ${monitor.lastCheckedAt} < now() - (${monitor.intervalSeconds} * interval '1 second'))`,
          ),
        )
        .orderBy(sql`${monitor.lastCheckedAt} asc nulls first`)
        .limit(limit);
    },

    /** Stamp the runner state after a probe. Always sets lastCheckedAt —
     *  via SQL now() so it shares a clock with claimDue's comparison. */
    async recordCheckResult(
      id: string,
      data: {
        status: MonitorStatus;
        consecutiveFailures: number;
        lastStatusCode: number | null;
        lastResponseMs: number | null;
      },
    ): Promise<void> {
      await db
        .update(monitor)
        .set({ ...data, lastCheckedAt: sql`now()`, updatedAt: new Date() })
        .where(eq(monitor.id, id));
    },
  };
}

// ─── monitor_check repo ──────────────────────────────────────────────────────

export function createMonitorCheckRepo(db: Database) {
  return {
    async create(data: Omit<NewMonitorCheck, "id" | "checkedAt">): Promise<MonitorCheck> {
      const id = generateId("mck");
      const [row] = await db
        .insert(monitorCheck)
        .values({ id, ...data })
        .returning();
      return row;
    },

    /** Recent checks for one monitor — oldest-first for charting. */
    async listRecent(monitorId: string, hours = 24): Promise<MonitorCheck[]> {
      return db
        .select()
        .from(monitorCheck)
        .where(
          and(
            eq(monitorCheck.monitorId, monitorId),
            sql`${monitorCheck.checkedAt} > now() - (${hours} * interval '1 hour')`,
          ),
        )
        .orderBy(monitorCheck.checkedAt);
    },

    /** Runner retention sweep — delete checks older than N days. */
    async prune(olderThanDays = 7): Promise<void> {
      await db
        .delete(monitorCheck)
        .where(sql`${monitorCheck.checkedAt} < now() - (${olderThanDays} * interval '1 day')`);
    },
  };
}

// ─── monitor_incident repo ───────────────────────────────────────────────────

export function createMonitorIncidentRepo(db: Database) {
  return {
    /** Open an incident when the failure threshold is crossed. Returns
     *  the existing open incident instead of inserting a duplicate. */
    async open(
      data: Omit<NewMonitorIncident, "id" | "startedAt" | "resolvedAt">,
    ): Promise<MonitorIncident> {
      const [existing] = await db
        .select()
        .from(monitorIncident)
        .where(
          and(
            eq(monitorIncident.monitorId, data.monitorId),
            sql`${monitorIncident.resolvedAt} IS NULL`,
          ),
        )
        .limit(1);
      if (existing) return existing;

      const id = generateId("mi");
      const [row] = await db
        .insert(monitorIncident)
        .values({ id, ...data })
        .returning();
      return row;
    },

    /** Keep the ongoing incident's last-failure snapshot current while the
     *  monitor stays down. No-op when no incident is open. */
    async updateOpen(
      monitorId: string,
      data: { error: string | null; failedChecks: number },
    ): Promise<void> {
      await db
        .update(monitorIncident)
        .set(data)
        .where(
          and(eq(monitorIncident.monitorId, monitorId), sql`${monitorIncident.resolvedAt} IS NULL`),
        );
    },

    /** Close an incident on the first successful probe. The runner passes
     *  the final failure count observed while it was open. */
    async resolve(
      id: string,
      data?: { error?: string; failedChecks?: number },
    ): Promise<MonitorIncident | undefined> {
      const [row] = await db
        .update(monitorIncident)
        .set({ ...data, resolvedAt: new Date() })
        .where(eq(monitorIncident.id, id))
        .returning();
      return row;
    },

    /** The ongoing incident for a monitor, if any — newest first so a
     *  stray duplicate can never shadow the current one. */
    async findOpen(monitorId: string): Promise<MonitorIncident | undefined> {
      const [row] = await db
        .select()
        .from(monitorIncident)
        .where(
          and(eq(monitorIncident.monitorId, monitorId), sql`${monitorIncident.resolvedAt} IS NULL`),
        )
        .orderBy(desc(monitorIncident.startedAt))
        .limit(1);
      return row;
    },

    /** Incident history for one monitor — newest first. */
    async listByMonitor(monitorId: string, limit = 50): Promise<MonitorIncident[]> {
      return db
        .select()
        .from(monitorIncident)
        .where(eq(monitorIncident.monitorId, monitorId))
        .orderBy(desc(monitorIncident.startedAt))
        .limit(limit);
    },
  };
}
