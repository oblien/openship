import { eq, and, gte, lte, desc, sql } from "drizzle-orm";
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

    /** Upsert daily geo data. */
    async upsertGeo(rows: NewServerAnalyticsGeo[]): Promise<void> {
      if (rows.length === 0) return;
      for (const row of rows) {
        await db
          .insert(serverAnalyticsGeo)
          .values(row)
          .onConflictDoUpdate({
            target: [serverAnalyticsGeo.serverId, serverAnalyticsGeo.domain, serverAnalyticsGeo.day],
            set: { countries: sql`excluded.countries` },
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
  };
}
