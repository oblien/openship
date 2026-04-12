import {
  pgTable,
  text,
  timestamp,
  integer,
  real,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { servers } from "./servers";

// ─── Server Analytics ────────────────────────────────────────────────────────

/**
 * Per-domain, per-minute analytics snapshots scraped from OpenResty's
 * shared-dict counters via the management API (127.0.0.1:9145).
 *
 * The API scraper periodically fetches analytics from each managed server
 * and upserts rows here. This provides persistence across OpenResty restarts
 * (shared dict is pure RAM — survives reload but not restart).
 */
export const serverAnalytics = pgTable(
  "server_analytics",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),

    /** Server that produced the analytics */
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),

    /** Domain the analytics belong to (lowercase, no www prefix) */
    domain: text("domain").notNull(),

    /** Minute bucket (epoch minutes since Unix epoch) */
    minute: integer("minute").notNull(),

    // ── Counters ──────────────────────────────────────────────────────────

    requests: integer("requests").notNull().default(0),
    uniqueRequests: integer("unique_requests").notNull().default(0),
    bandwidthIn: integer("bandwidth_in").notNull().default(0),
    bandwidthOut: integer("bandwidth_out").notNull().default(0),

    /** Average response time in seconds (float) */
    responseTime: real("response_time").notNull().default(0),

    /** Per-minute country breakdown: { "US": 42, "DE": 17, ... } */
    countries: jsonb("countries"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_analytics_server_domain_minute").on(
      t.serverId,
      t.domain,
      t.minute,
    ),
    index("idx_analytics_domain_minute").on(t.domain, t.minute),
  ],
);

// ─── Server Analytics — Daily Geo Aggregates ─────────────────────────────────

/**
 * Daily country-level aggregates per domain per server.
 * Scraped from GET /analytics/geo?domain=&day=YYYYMMDD.
 */
export const serverAnalyticsGeo = pgTable(
  "server_analytics_geo",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),

    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),

    domain: text("domain").notNull(),

    /** Day string "YYYYMMDD" */
    day: text("day").notNull(),

    /** Country breakdown: { "US": 1234, "DE": 567, ... } */
    countries: jsonb("countries").notNull(),

    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_analytics_geo_server_domain_day").on(
      t.serverId,
      t.domain,
      t.day,
    ),
  ],
);
