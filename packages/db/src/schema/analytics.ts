import {
  pgTable,
  text,
  timestamp,
  integer,
  bigint,
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
 * (shared dict is pure RAM - survives reload but not restart).
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
    /**
     * Non-static ("page") requests in this minute — NOT distinct visitors.
     *
     * It comes from `s:{domain}:{min}:u`, which site_logger.lua increments for any
     * request whose URI isn't a static asset. It was surfaced to the dashboard as
     * "unique IPs", which it never was: five page views from one browser count
     * five. Real distinct visitors are `serverAnalyticsGeo.visitors`, which is
     * dedup'd at the edge.
     */
    uniqueRequests: integer("unique_requests").notNull().default(0),

    /**
     * Bytes in / out for this ONE MINUTE. bigint, not integer.
     *
     * int4 caps at 2,147,483,647 — about 2.1 GB, which a single minute reaches at
     * ~286 Mbps. Entirely normal for a site serving video or large downloads. On
     * overflow Postgres raises "integer out of range", the upsert fails, and the
     * scrape for that domain dies — so the busiest domains would be exactly the
     * ones with no analytics. `mode: "number"` is safe here: JS integers are exact
     * to 2^53, ~9 PB per minute.
     */
    bandwidthIn: bigint("bandwidth_in", { mode: "number" }).notNull().default(0),
    bandwidthOut: bigint("bandwidth_out", { mode: "number" }).notNull().default(0),

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

// ─── Server Analytics - Daily Rollups ────────────────────────────────────────

/**
 * Daily per-domain, per-server rollup: countries, distinct visitors, top paths,
 * status-code mix. Scraped from GET /analytics/geo?domain=&day=YYYYMMDD.
 *
 * The table name says `geo` because countries were all it once held. Everything
 * here shares one `g:{domain}:{day}:` key prefix in the edge's shared dict
 * specifically so the whole day is readable in a SINGLE dict scan — which is why
 * these live together rather than in a table each.
 *
 * Daily, not per-minute, for the two high-cardinality metrics: a per-minute
 * visitor set is ~1440x the shared-dict keys for a number nobody plots, and
 * per-minute path counters would evict the request counters they annotate.
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

    /**
     * Distinct visitors for the day — a COUNT, deduplicated at the edge.
     *
     * The edge hashes each address with a per-day salt that never leaves the box
     * and stores only a set-membership marker; this column is the cardinality of
     * that set. No address and no per-visitor row exists at any layer, here or
     * upstream, which is what keeps "we don't collect behavioural analytics on
     * your end users" true while still reporting a real visitor number.
     *
     * APPROXIMATE on a very busy domain: the edge's `visitors` zone LRU-evicts
     * past ~1M distinct/day, which UNDERSTATES. mgmt_api `GET /status` reports
     * that zone's free space so a reader can label it.
     */
    visitors: integer("visitors").notNull().default(0),

    /**
     * Top paths: { "/": 900, "/orders/:id": 120, "other": 40 }.
     *
     * Normalized at the edge — query string stripped (so no token or id ever
     * becomes a key), numeric/UUID segments collapsed to `:id`, key length capped,
     * and the tail past a cardinality cap folded into "other" so a URL-fuzzing
     * scanner can't evict real counters.
     */
    paths: jsonb("paths"),

    /** Status-code mix: { "200": 4210, "404": 17, "502": 3 }. */
    statuses: jsonb("statuses"),

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
