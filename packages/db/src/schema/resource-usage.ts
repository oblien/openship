import {
  pgTable,
  text,
  timestamp,
  integer,
  bigint,
  real,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { project } from "./project";

/**
 * The bucket width, in minutes, and therefore the resolution of every stored
 * series. The sampler floors each sample's epoch-minute to a multiple of this, so a
 * whole sweep shares one key and a re-run inside the window is a no-op.
 *
 * It is a constant rather than a config knob because it is baked into the stored
 * keys: changing it does not re-bucket history, it just makes old and new rows mean
 * different things.
 */
export const RESOURCE_BUCKET_MINUTES = 5;

/**
 * The `serviceKey` a single-container project's usage is filed under.
 *
 * Mirrors the health watch's constant of the same name, deliberately — the two
 * features describe the same workload and must agree on its identity. NOT the
 * container name: that embeds the deployment id, so every redeploy would mint a new
 * key and orphan the series.
 */
export const SINGLE_APP_SERVICE_KEY = "__app__";

/**
 * Per-service resource usage samples, bucketed at `RESOURCE_BUCKET_MINUTES`.
 *
 * Why this is a sampled series and not a counter series like `server_analytics`:
 * traffic is counted for free (the edge increments a shared-dict key on every
 * request), so minute granularity is free and exact. Resource usage has to be
 * PROBED, and `docker stats` occupies the daemon for roughly a second per container
 * because it must collect two CPU samples to compute a delta. So the sampling
 * cadence IS the resolution, and 5 minutes is the compromise between catching a
 * spike and not pinning every daemon on the estate.
 *
 * Follows `server_analytics`' conventions throughout: an integer epoch-minute bucket
 * key rather than a timestamp, a unique index on (scope, bucket) so writes are
 * idempotent, `real` for pre-averaged values, and `bigint mode:"number"` for byte
 * counters that would overflow int4.
 *
 * ── What is NOT stored ──────────────────────────────────────────────────────
 *
 * There is no project-total row. For a compose project the total is the per-bucket
 * SUM of its services, computed at read: a stored copy would be redundant, free to
 * drift from the rows it duplicates, and wrong the moment a service is added or
 * removed mid-window. A single-container project has no service rows at all, so its
 * one series is filed under SINGLE_APP_SERVICE_KEY and the total is that series.
 */
export const resourceUsage = pgTable(
  "resource_usage",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),

    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),

    /**
     * `service.id`, or SINGLE_APP_SERVICE_KEY for a single-container project.
     *
     * NOT NULL text rather than a nullable `service_id` FK: Postgres treats NULLs as
     * DISTINCT in a unique index, so a nullable column cannot carry the "this is the
     * project itself" case without the partial-index workaround migration 0083
     * needed. A sentinel string keeps one plain unique index correct.
     *
     * Consequence accepted deliberately: deleting a service leaves its samples
     * behind until retention prunes them. That is the right trade — history should
     * survive the thing it describes, and the project cascade still bounds it.
     */
    serviceKey: text("service_key").notNull(),

    /** Bucket start, in epoch minutes, floored to a RESOURCE_BUCKET_MINUTES multiple. */
    minute: integer("minute").notNull(),

    /**
     * Per-CORE percent, as the runtimes report it — so >100 is correct and expected
     * on a multi-core box, and must not be clamped. Readers divide by the host's
     * core count when they want "share of this machine".
     */
    cpuPercent: real("cpu_percent").notNull().default(0),

    memoryMb: real("memory_mb").notNull().default(0),

    /**
     * CUMULATIVE bytes since the container started, not a per-bucket delta — that is
     * simply what the runtimes expose. Readers difference consecutive buckets and
     * clamp negatives to zero, because a restart resets the counter and would
     * otherwise render as a large negative spike.
     *
     * Always 0 on bare deployments: per-process network accounting needs eBPF or a
     * dedicated netns, so a reader must not present 0 here as "no traffic".
     */
    networkRxBytes: bigint("network_rx_bytes", { mode: "number" }).notNull().default(0),
    networkTxBytes: bigint("network_tx_bytes", { mode: "number" }).notNull().default(0),

    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    // Makes a repeated sample for the same bucket a no-op rather than a double count.
    uniqueIndex("uq_resource_usage_project_service_minute").on(
      t.projectId,
      t.serviceKey,
      t.minute,
    ),
    // The read path is always "this project over this window".
    index("idx_resource_usage_project_minute").on(t.projectId, t.minute),
  ],
);
