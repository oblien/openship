import { eq, and, gte, lte, lt, desc, sql } from "drizzle-orm";
import type { Database } from "../client";
import { serverAnalytics, serverAnalyticsGeo } from "../schema";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ServerAnalyticsRow = typeof serverAnalytics.$inferSelect;
export type NewServerAnalytics = typeof serverAnalytics.$inferInsert;
export type ServerAnalyticsGeoRow = typeof serverAnalyticsGeo.$inferSelect;
export type NewServerAnalyticsGeo = typeof serverAnalyticsGeo.$inferInsert;

// ─── Repository ──────────────────────────────────────────────────────────────

export function createAnalyticsRepo(db: Database) {
  return {
    // ── Minute-bucket analytics ────────────────────────────────────────

    /**
     * Upsert a batch of minute-bucket analytics rows.
     * Uses ON CONFLICT to update counters if the (server_id, domain, minute)
     * combination already exists.
     */
    async upsertBuckets(rows: NewServerAnalytics[]): Promise<void> {
      if (rows.length === 0) return;
      await db
        .insert(serverAnalytics)
        .values(rows)
        .onConflictDoNothing({
          target: [serverAnalytics.serverId, serverAnalytics.domain, serverAnalytics.minute],
        });
    },

    /** Query minute-bucket analytics for a domain within a time range. */
    async queryBuckets(opts: {
      serverId: string;
      domain: string;
      fromMinute: number;
      toMinute: number;
    }): Promise<ServerAnalyticsRow[]> {
      return db
        .select()
        .from(serverAnalytics)
        .where(
          and(
            eq(serverAnalytics.serverId, opts.serverId),
            eq(serverAnalytics.domain, opts.domain),
            gte(serverAnalytics.minute, opts.fromMinute),
            lte(serverAnalytics.minute, opts.toMinute),
          ),
        )
        .orderBy(serverAnalytics.minute);
    },

    /** Get the most recent analytics rows for a domain (for dashboard overview). */
    async recentBuckets(opts: {
      serverId: string;
      domain: string;
      limit?: number;
    }): Promise<ServerAnalyticsRow[]> {
      return db
        .select()
        .from(serverAnalytics)
        .where(
          and(
            eq(serverAnalytics.serverId, opts.serverId),
            eq(serverAnalytics.domain, opts.domain),
          ),
        )
        .orderBy(desc(serverAnalytics.minute))
        .limit(opts.limit ?? 60);
    },

    /** Get the highest scraped minute for a server+domain (for incremental scraping). */
    async getLastScrapedMinute(
      serverId: string,
      domain: string,
    ): Promise<number | null> {
      const [row] = await db
        .select({ minute: serverAnalytics.minute })
        .from(serverAnalytics)
        .where(
          and(
            eq(serverAnalytics.serverId, serverId),
            eq(serverAnalytics.domain, domain),
          ),
        )
        .orderBy(desc(serverAnalytics.minute))
        .limit(1);
      return row?.minute ?? null;
    },

    // ── Daily geo aggregates ─────────────────────────────────────────────

    /**
     * Upsert a day's rollup (countries + visitors + paths + statuses).
     *
     * LAST WRITE WINS, deliberately: the edge holds each day's counters as running
     * totals with a 48h TTL, so every scrape re-reads the whole day rather than a
     * delta. Adding here would multiply-count the same requests on each scrape.
     *
     * Every column is in the `set`, not just `countries` — a partial set silently
     * froze the other three at whatever the row was first created with.
     */
    async upsertGeo(rows: NewServerAnalyticsGeo[]): Promise<void> {
      if (rows.length === 0) return;
      for (const row of rows) {
        await db
          .insert(serverAnalyticsGeo)
          .values(row)
          .onConflictDoUpdate({
            target: [serverAnalyticsGeo.serverId, serverAnalyticsGeo.domain, serverAnalyticsGeo.day],
            set: {
              countries: sql`excluded.countries`,
              visitors: sql`excluded.visitors`,
              paths: sql`excluded.paths`,
              statuses: sql`excluded.statuses`,
            },
          });
      }
    },

    /** Query geo data for a domain on a specific day. */
    async queryGeo(opts: {
      serverId: string;
      domain: string;
      day: string;
    }): Promise<ServerAnalyticsGeoRow | undefined> {
      return db.query.serverAnalyticsGeo.findFirst({
        where: and(
          eq(serverAnalyticsGeo.serverId, opts.serverId),
          eq(serverAnalyticsGeo.domain, opts.domain),
          eq(serverAnalyticsGeo.day, opts.day),
        ),
      });
    },

    /** List recent geo days for a domain. */
    async recentGeoDays(opts: {
      serverId: string;
      domain: string;
      limit?: number;
    }): Promise<ServerAnalyticsGeoRow[]> {
      return db
        .select()
        .from(serverAnalyticsGeo)
        .where(
          and(
            eq(serverAnalyticsGeo.serverId, opts.serverId),
            eq(serverAnalyticsGeo.domain, opts.domain),
          ),
        )
        .orderBy(desc(serverAnalyticsGeo.day))
        .limit(opts.limit ?? 30);
    },

    /**
     * Daily rollups for a domain across an INCLUSIVE day range ("YYYYMMDD").
     *
     * String comparison is correct here, not a hack: YYYYMMDD is fixed-width and
     * zero-padded, so lexical order is chronological order.
     */
    async queryGeoRange(opts: {
      serverId: string;
      domain: string;
      fromDay: string;
      toDay: string;
    }): Promise<ServerAnalyticsGeoRow[]> {
      return db
        .select()
        .from(serverAnalyticsGeo)
        .where(
          and(
            eq(serverAnalyticsGeo.serverId, opts.serverId),
            eq(serverAnalyticsGeo.domain, opts.domain),
            gte(serverAnalyticsGeo.day, opts.fromDay),
            lte(serverAnalyticsGeo.day, opts.toDay),
          ),
        )
        .orderBy(serverAnalyticsGeo.day);
    },

    // ── Retention ────────────────────────────────────────────────────────
    //
    // Nothing pruned these before, and minute buckets are one row per domain per
    // MINUTE — ~525k rows/domain/year, kept forever. The two horizons differ by
    // three orders of magnitude in row cost, so they get separate cutoffs: daily
    // rollups are one row per domain per day and can be kept far longer than the
    // minute series that feeds the live chart.

    /** Delete minute buckets older than `beforeMinute` (epoch minutes). */
    async pruneBuckets(beforeMinute: number): Promise<number> {
      const rows = await db
        .delete(serverAnalytics)
        .where(lt(serverAnalytics.minute, beforeMinute))
        .returning();
      return rows.length;
    },

    /** Delete daily rollups older than `beforeDay` ("YYYYMMDD"). */
    async pruneGeo(beforeDay: string): Promise<number> {
      const rows = await db
        .delete(serverAnalyticsGeo)
        .where(lt(serverAnalyticsGeo.day, beforeDay))
        .returning();
      return rows.length;
    },
  };
}
