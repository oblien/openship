-- Resource usage history: the persisted series behind the Monitoring tab's
-- CPU/memory chart.
--
-- Usage existed only as a live 5-second SSE stream, so closing the tab discarded
-- everything. "Was memory climbing before the OOM at 3am" was unanswerable, which is
-- the question the data exists to answer.
--
-- ── Why this is a SAMPLED series, not a counter series like server_analytics ──
--
-- Traffic is counted for free: the edge increments a shared-dict key on every
-- request, so per-minute granularity costs nothing and is exact. Resource usage has
-- to be PROBED, and `docker stats` occupies the daemon for roughly a second per
-- container because it must collect two CPU samples to compute a delta — about 500x
-- a `docker inspect`. The sampling cadence therefore IS the resolution, and the cost
-- scales with container count. 5-minute buckets are the compromise between catching
-- a spike and not pinning every daemon on the estate; ~288 rows/day/service.
--
-- ── serviceKey is NOT NULL text, not a nullable service_id FK ────────────────
--
-- Postgres treats NULLs as DISTINCT in a unique index, so a nullable column cannot
-- carry the "this row is the project itself" case without the partial-index
-- workaround migration 0083 needed for service_incident. A sentinel ('__app__',
-- matching the health watch's own constant so both features name the same workload
-- identically) keeps one plain unique index correct.
--
-- Accepted consequence: deleting a service leaves its samples behind until retention
-- prunes them. That is the right trade — history should outlive the thing it
-- describes — and the project cascade still bounds the growth.
--
-- ── What is deliberately absent ─────────────────────────────────────────────
--
-- No project-total row. For a compose project the total is the per-bucket SUM of its
-- services, computed at read. Storing it too would duplicate rows that are free to
-- drift from their own sources, and would be wrong the moment a service is added or
-- removed mid-window.
CREATE TABLE IF NOT EXISTS "resource_usage" (
  "id" text PRIMARY KEY NOT NULL,
  "project_id" text NOT NULL REFERENCES "project"("id") ON DELETE CASCADE,
  -- service.id, or '__app__' for a single-container project.
  "service_key" text NOT NULL,
  -- Bucket start in epoch MINUTES (not a timestamp), floored to a multiple of 5 —
  -- same integer-bucket convention as server_analytics.
  "minute" integer NOT NULL,
  -- Per-CORE percent, as the runtimes report it: >100 is correct on a multi-core box
  -- and must not be clamped. Readers divide by core count for "share of this host".
  "cpu_percent" real DEFAULT 0 NOT NULL,
  "memory_mb" real DEFAULT 0 NOT NULL,
  -- CUMULATIVE since container start, not per-bucket deltas — that is what the
  -- runtimes expose. Readers difference consecutive buckets and clamp negatives to
  -- zero, because a restart resets the counter and would otherwise plot as a large
  -- negative spike. bigint: a long-lived busy container passes int4 in days.
  -- Always 0 for bare deploys (per-process accounting needs eBPF or a netns), so a
  -- reader must not present 0 here as "no network traffic".
  "network_rx_bytes" bigint DEFAULT 0 NOT NULL,
  "network_tx_bytes" bigint DEFAULT 0 NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- Makes a repeated sample for the same bucket a no-op (insert ... on conflict do
-- nothing) rather than a double count, so the whole sweep is safely re-runnable.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_resource_usage_project_service_minute"
  ON "resource_usage" ("project_id", "service_key", "minute");
--> statement-breakpoint

-- Every read is "this project over this window".
CREATE INDEX IF NOT EXISTS "idx_resource_usage_project_minute"
  ON "resource_usage" ("project_id", "minute");
