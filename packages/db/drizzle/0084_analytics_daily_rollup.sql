-- Widen the daily analytics rollup: distinct visitors, top paths, status mix.
--
-- The visitor pipeline already persisted per-country counts, and the dashboard
-- already rendered cards for "unique IPs" and a top-paths table. Neither was real:
-- `top_paths` was hardcoded `[]` in the service layer, and "unique IPs" was
-- `unique_requests` — the count of non-static REQUESTS — so five page views from
-- one browser read as five visitors. These columns are what makes those two
-- numbers mean what the UI has been claiming.
--
-- All three land HERE, on the daily table, rather than on the per-minute one:
-- visitors and paths are the high-cardinality metrics, and holding them per-minute
-- would multiply the edge's shared-dict key count by ~1440 to feed a chart nobody
-- asked for — evicting, in the process, the request counters they annotate.
-- Countries already live here for the same reason, and the edge keeps all four
-- under one `g:{domain}:{day}:` key prefix so a reader gets the whole day in a
-- single dict scan.
--
-- Additive with defaults on purpose: `migrations-additive.test.ts` rejects a
-- NOT NULL column without a DEFAULT, because an older cross-version dump omits the
-- column entirely and Drizzle then emits DEFAULT for it — with no default that's a
-- NULL into NOT NULL on the newer receiver, i.e. a broken cloud/project transfer.

-- Distinct visitors for the day, deduplicated AT THE EDGE and stored as a count.
--
-- Privacy is a property of where the dedup happens: the edge hashes each address
-- with a salt that is generated on that box, rotates daily, and never leaves its
-- shared memory. Only the cardinality of that set is written here. No address and
-- no per-visitor row exists at any layer, which is what keeps the published
-- "we don't collect behavioural analytics on your end users" true while still
-- reporting a real visitor number.
--
-- Understates on a very busy domain: the edge's `visitors` zone LRU-evicts past
-- roughly 1M distinct/day. mgmt_api `GET /status` reports that zone's free space so
-- a reader can label the number approximate instead of presenting an eviction
-- artifact as a measurement.
ALTER TABLE "server_analytics_geo" ADD COLUMN IF NOT EXISTS "visitors" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint

-- Top paths: { "/": 900, "/orders/:id": 120, "other": 40 }.
--
-- Normalized at the edge before it ever becomes a key: query string stripped (so a
-- ?token= or ?session= can never be persisted here), numeric and UUID segments
-- collapsed to `:id`, key length capped, and the tail past a cardinality cap folded
-- into "other" — otherwise a scanner walking /wp-admin variants mints thousands of
-- permanent keys and evicts the real counters.
ALTER TABLE "server_analytics_geo" ADD COLUMN IF NOT EXISTS "paths" jsonb;
--> statement-breakpoint

-- Status-code mix: { "200": 4210, "404": 17, "502": 3 }. Status was captured into
-- the edge's raw-request ring buffer (RAM, 1h) but never aggregated, so error rate
-- was unanswerable from any persisted data. Bounded by construction.
ALTER TABLE "server_analytics_geo" ADD COLUMN IF NOT EXISTS "statuses" jsonb;
--> statement-breakpoint

-- Widen the per-minute bandwidth counters from int4 to int8.
--
-- These are bytes for ONE MINUTE, and int4 caps at 2,147,483,647 — about 2.1 GB,
-- which a single minute reaches at roughly 286 Mbps. That is unremarkable for a
-- site serving video or large downloads. Past it Postgres raises "integer out of
-- range", the upsert for that minute fails, and the scrape for the whole domain
-- dies with it — so the busiest domains on a box would be precisely the ones with
-- no analytics, and it would look like the feature simply didn't work for them.
--
-- Now that collection runs unattended on a schedule rather than only when someone
-- opens the tab, that failure would happen in a job with nobody reading the error.
--
-- Widening is lossless and there is no application change: the edge already
-- accumulates these as Lua numbers (doubles, exact to 2^53) and Drizzle reads them
-- back with mode:"number", which is exact over the same range.
ALTER TABLE "server_analytics" ALTER COLUMN "bandwidth_in" TYPE bigint;
--> statement-breakpoint
ALTER TABLE "server_analytics" ALTER COLUMN "bandwidth_out" TYPE bigint;
