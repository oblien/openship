import { eq, and, gte, lte, lt, asc } from "drizzle-orm";
import type { Database } from "../client";
import { resourceUsage } from "../schema";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ResourceUsageRow = typeof resourceUsage.$inferSelect;
export type NewResourceUsage = typeof resourceUsage.$inferInsert;

// ─── Repository ──────────────────────────────────────────────────────────────

export function createResourceUsageRepo(db: Database) {
  return {
    /**
     * Insert a sweep's samples in one statement.
     *
     * `onConflictDoNothing`, not an upsert: a sample is a point measurement of a
     * moment, so the FIRST reading for a bucket is the honest one. Overwriting would
     * let an out-of-band re-run silently rewrite history, and adding would double it.
     * That also makes the whole sweep safely re-runnable.
     */
    async insertSamples(rows: NewResourceUsage[]): Promise<void> {
      if (rows.length === 0) return;
      await db
        .insert(resourceUsage)
        .values(rows)
        .onConflictDoNothing({
          target: [resourceUsage.projectId, resourceUsage.serviceKey, resourceUsage.minute],
        });
    },

    /**
     * Samples for a project over an inclusive epoch-minute window.
     *
     * Ascending by minute so the caller can difference consecutive buckets for the
     * cumulative network counters without sorting first. `serviceKey` omitted returns
     * EVERY service, which is what the "All" read needs in order to sum per bucket.
     */
    async querySamples(opts: {
      projectId: string;
      serviceKey?: string;
      fromMinute: number;
      toMinute: number;
    }): Promise<ResourceUsageRow[]> {
      return db
        .select()
        .from(resourceUsage)
        .where(
          and(
            eq(resourceUsage.projectId, opts.projectId),
            gte(resourceUsage.minute, opts.fromMinute),
            lte(resourceUsage.minute, opts.toMinute),
            ...(opts.serviceKey ? [eq(resourceUsage.serviceKey, opts.serviceKey)] : []),
          ),
        )
        .orderBy(asc(resourceUsage.minute));
    },

    /**
     * Delete samples older than `beforeMinute` (epoch minutes).
     *
     * This is the densest of the analytics tables — one row per service per 5-minute
     * bucket is ~288/day/service — so it gets the shortest retention horizon of the
     * three the prune job manages.
     */
    async pruneOlderThan(beforeMinute: number): Promise<number> {
      const rows = await db
        .delete(resourceUsage)
        .where(lt(resourceUsage.minute, beforeMinute))
        .returning();
      return rows.length;
    },
  };
}
