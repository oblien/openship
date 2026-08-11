/**
 * Analytics scraper — moves analytics out of a managed server's OpenResty
 * shared-dict memory (RAM, TTL'd) and into Postgres.
 *
 * For a server it:
 *   1. Lists all known domains (from the totals endpoint)
 *   2. Flushes minute-bucket data for each domain (read + delete from OpenResty)
 *   3. Fetches today's daily rollup for each domain (countries, visitors, paths,
 *      statuses — one call, they share a key prefix)
 *   4. Upserts everything into the analytics tables
 *
 * ── Two triggers, two jobs ──────────────────────────────────────────────────
 *
 * `runAnalyticsScrapeSweep` (the `analytics:scrape` system job) is the CORRECTNESS
 * floor: it guarantees the flush happens whether or not anyone is looking.
 *
 * `scrapeServerIfStale` (called from the read handlers) is FRESHNESS: opening the
 * tab should show the last minute, not the last hour.
 *
 * On-demand alone was lossy, and the loss was invisible. Both key classes live in
 * RAM under a TTL, so "nobody opened the tab" and "the data was never persisted"
 * were the same event: no view for >24h expired unflushed minute buckets, and no
 * view for >48h expired an entire day's country/visitor/path rollup — a project
 * nobody opens for a week simply had six missing days behind its country map. An
 * OpenResty *restart* (reload is fine; the dict is RAM) made the exposure window
 * "since the last view", which is unbounded.
 *
 * ── Why the two triggers can't corrupt each other ───────────────────────────
 *
 * They overlap freely by construction, which is what makes adding the job cheap:
 *   - minute buckets: `POST /analytics/collect` reads and DELETES atomically, so a
 *     bucket is handed to exactly one caller. Deltas, never re-counted.
 *   - daily rollup: the edge keeps running TOTALS for the day and the upsert is
 *     last-write-wins, so re-reading is idempotent. It is deliberately NOT a
 *     flush — deleting would lose the totals for every later scrape of the day.
 *   - `scrapeServerIfStale` is staleness-gated (cacheStore, cross-process) and
 *     in-flight deduped, so a job tick landing next to a page view collapses into
 *     one scrape rather than two.
 */

import { repos } from "@repo/db";
import { env } from "../../config";
import { cacheStore } from "../../lib/cache-store";
import { systemDebug, formatDuration } from "../../lib/system-debug";
import { fetchMgmt, postMgmtJson, probeMgmt } from "../../lib/project-analytics";
import { safeErrorMessage } from "@repo/core";
import { reconcileAnalyticsConfig } from "../analytics/analytics-config.service";

function debug(msg: string): void {
  systemDebug("analytics-scraper", msg);
}

// ── Per-server scrape ────────────────────────────────────────────────────────

interface CollectBucket {
  minute: number;
  requests: number;
  unique_requests: number;
  bandwidth_in: number;
  bandwidth_out: number;
  response_time: number;
  countries?: Record<string, number>;
}

interface CollectDomain {
  buckets?: CollectBucket[];
  flushed?: number;
  rollup?: {
    day?: string;
    countries?: Record<string, number>;
    visitors?: number;
    paths?: Record<string, number>;
    statuses?: Record<string, number>;
  };
}

/**
 * Collect one server's analytics into Postgres.
 *
 * ONE round trip and ONE shared-dict scan for the whole box, via
 * `POST /analytics/collect`.
 *
 * It used to loop the single-domain endpoints — a flush plus a rollup read per
 * domain — which cost 2N+1 unbounded `get_keys` scans of a 256 MB zone and 2N+1
 * SSH/exec round trips per sweep. `get_keys` walks the entire zone and holds the
 * dict lock against every nginx worker while it does, so on a 50-domain box that
 * was 101 full scans, on a schedule, to collect what a single pass already had.
 */
async function scrapeServer(serverId: string): Promise<void> {
  const startedAt = Date.now();
  debug(`scrape:start server=${serverId}`);

  // 1. Health check
  const health = await probeMgmt(serverId);
  if (!health) {
    debug(`scrape:skip server=${serverId} - mgmt unreachable`);
    return;
  }

  // 2. Domain discovery. Still its own call: the collect endpoint needs to be TOLD
  //    which domains and which minute window, because the window is per-domain
  //    (each resumes from its own last persisted minute).
  const totalsResult = await fetchMgmt(serverId, "/analytics/totals") as {
    domains?: { domain: string }[];
  } | null;
  const domains = Array.isArray(totalsResult?.domains) ? totalsResult.domains : [];

  if (domains.length === 0) {
    debug(`scrape:done server=${serverId} - no domains (${formatDuration(startedAt)})`);
    return;
  }

  // 3. Per-domain incremental window. `now - 1` because the current minute is still
  //    accumulating and flushing it would truncate it.
  const now = Math.floor(Date.now() / 60_000);
  const toMinute = now - 1;
  const requested: Array<{ domain: string; from: number; to: number }> = [];
  for (const { domain } of domains) {
    const lastMinute = await repos.analytics.getLastScrapedMinute(serverId, domain);
    const fromMinute = lastMinute ? lastMinute + 1 : now - 60; // default: last hour
    if (fromMinute > toMinute) continue;
    requested.push({ domain, from: fromMinute, to: toMinute });
  }
  if (requested.length === 0) {
    debug(`scrape:done server=${serverId} - nothing new (${formatDuration(startedAt)})`);
    return;
  }

  // 4. One call: flushes every domain's minute buckets (read + delete, atomic per
  //    key) and reads every domain's daily rollup, off a single dict scan.
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, ""); // YYYYMMDD
  const collected = await postMgmtJson(serverId, "/analytics/collect", {
    day: today,
    domains: requested,
  }) as { domains?: Record<string, CollectDomain> } | null;

  const byDomain = collected?.domains;
  if (!byDomain) {
    debug(`scrape:done server=${serverId} - collect returned nothing (${formatDuration(startedAt)})`);
    return;
  }

  let bucketRows = 0;
  let rollupRows = 0;

  for (const { domain } of requested) {
    const result = byDomain[domain];
    if (!result) continue;

    const buckets = Array.isArray(result.buckets) ? result.buckets : [];
    if (buckets.length > 0) {
      await repos.analytics.upsertBuckets(
        buckets.map((b) => ({
          serverId,
          domain,
          minute: b.minute,
          requests: b.requests,
          uniqueRequests: b.unique_requests,
          bandwidthIn: b.bandwidth_in,
          bandwidthOut: b.bandwidth_out,
          responseTime: b.response_time,
          countries: b.countries ?? null,
        })),
      );
      bucketRows += buckets.length;
    }

    // The daily rollup is NOT a flush: the edge holds running totals for the day
    // (48h TTL), so each scrape re-reads the full day and the upsert overwrites.
    // Deleting would lose the totals for every later scrape of the same day.
    const rollup = result.rollup;
    if (!rollup) continue;
    const countries = rollup.countries ?? {};
    const paths = rollup.paths ?? {};
    const statuses = rollup.statuses ?? {};
    const visitors = typeof rollup.visitors === "number" ? rollup.visitors : 0;
    // Write when ANY dimension has data. Gating on countries alone (as this did)
    // meant a box with geo unavailable — every containerized edge, until the DB got
    // baked into the image — persisted nothing at all, discarding the visitor, path
    // and status counts it did have.
    const hasData =
      Object.keys(countries).length > 0 ||
      Object.keys(paths).length > 0 ||
      Object.keys(statuses).length > 0 ||
      visitors > 0;
    if (hasData) {
      await repos.analytics.upsertGeo([
        { serverId, domain, day: rollup.day ?? today, countries, visitors, paths, statuses },
      ]);
      rollupRows += 1;
    }
  }

  debug(
    `scrape:done server=${serverId} domains=${requested.length} ` +
      `buckets=${bucketRows} rollups=${rollupRows} (${formatDuration(startedAt)})`,
  );
}

// ── Read-triggered scrape ────────────────────────────────────────────────────
//
// Freshness, not durability — the sweep below owns durability. A server is also
// scraped when its analytics is viewed (analytics.controller → serverAnalytics /
// serverGeo, geo.service → collectSelfHosted). Self-throttling: staleness-gated so
// repeated reads within the window don't re-hit the server, and in-flight-deduped
// so concurrent reads share one scrape.

const SCRAPE_STALE_SECONDS = 60;
const SCRAPE_NS = "analytics-scrape";

// In-flight dedup MUST stay in-process: a live Promise isn't serializable, so
// it can't live in cacheStore. This only coalesces concurrent calls within
// THIS process. The cross-process staleness throttle below uses cacheStore
// (Redis when present, in-memory otherwise) keyed per server.
const inflightScrape = new Map<string, Promise<void>>();

/**
 * Scrape a server's analytics now — UNLESS it was scraped within the last
 * `SCRAPE_STALE_SECONDS` or a scrape is already in flight. Safe to call
 * fire-and-forget on every analytics read; it self-throttles and never throws.
 *
 * Self-hosted only: the SaaS has no managed servers / OpenResty to scrape, so
 * this hard-stops in cloud mode — a shared analytics read must never reach out
 * to a server from the SaaS.
 */
export function scrapeServerIfStale(serverId: string): Promise<void> {
  if (env.CLOUD_MODE) return Promise.resolve();

  const existing = inflightScrape.get(serverId);
  if (existing) return existing;

  const work = (async () => {
    // The in-flight entry is released in THIS finally, wrapping the whole body,
    // not in the inner one.
    //
    // It used to sit in the inner `finally`, below a `return` that exits on the
    // throttled path — so a throttled call never released its entry, and the
    // resolved promise stayed in the map. Every later call for that server then
    // short-circuited on `existing` and returned it, meaning the FIRST throttled
    // read permanently disabled scraping for that server until the API restarted.
    // Silent, and it presented as "analytics stopped updating hours ago".
    try {
      const store = await cacheStore<number>(SCRAPE_NS, { maxSize: 5_000 });
      const key = `lastAt:${serverId}`;
      // Presence of the key = scraped within the window → throttled, skip.
      if (await store.get(key)) return;
      try {
        await scrapeServer(serverId);
      } catch (err) {
        debug(`scrape-on-demand:error server=${serverId} ${safeErrorMessage(err)}`);
      } finally {
        // TTL-throttle the next scrape; the key expiring makes the server
        // eligible again without any manual timestamp bookkeeping.
        await store
          .set(key, Date.now(), SCRAPE_STALE_SECONDS)
          .catch(() => {});
      }
    } finally {
      inflightScrape.delete(serverId);
    }
  })();

  inflightScrape.set(serverId, work);
  return work;
}

// ── Scheduled sweep (the `analytics:scrape` system job) ──────────────────────

/**
 * Flush every managed server's analytics into Postgres.
 *
 * This is what makes persistence unconditional. Without it the only trigger was a
 * page view, so a project nobody opened lost whatever expired out of the edge's
 * shared dict in the meantime — silently, because an unflushed minute and a minute
 * with no traffic are indistinguishable once the key is gone.
 *
 * Serial, not `Promise.all`. Each server means an SSH connect (or a `docker exec`
 * into its edge) plus one call per domain, and hammering every box at once on a
 * 50-server control plane is how a metrics sweep becomes an outage. The work is
 * not latency-sensitive — nobody is waiting on this tick.
 *
 * Reuses `scrapeServerIfStale` rather than calling `scrapeServer` directly, so the
 * staleness gate applies: if someone viewed a server 30 seconds ago there is
 * nothing left to collect, and the tick correctly no-ops for that server.
 *
 * Never throws — `scrapeServerIfStale` swallows per-server failures, so one
 * unreachable box can't fail the job or stop the remaining servers.
 */
export async function runAnalyticsScrapeSweep(): Promise<{
  servers: number;
  skipped: number;
}> {
  // Redundant with the job's `available` gate on purpose: this is the hard stop, so
  // a future caller can't make the multi-tenant SaaS dial a tenant's box.
  if (env.CLOUD_MODE) return { servers: 0, skipped: 0 };

  const startedAt = Date.now();
  const servers = await repos.server.list();
  let swept = 0;

  for (const server of servers) {
    await scrapeServerIfStale(server.id);
    swept += 1;
  }

  // Re-assert the per-host collection switches while we are already here.
  //
  // They live in the edge's shared dict, which a FULL restart empties (a `-s reload`
  // preserves it — verified). Absent means off, so a rebooted box silently stops collecting
  // paths while the database still says it should. Doing it on this sweep bounds that drift
  // to 30 minutes instead of to the project's next route apply, which for a stable project
  // can be weeks. One round trip per server; the write is idempotent.
  const cfg = await reconcileAnalyticsConfig().catch((err) => {
    debug(`sweep:config-reconcile failed ${safeErrorMessage(err)}`);
    return { servers: 0, hosts: 0 };
  });

  debug(
    `sweep:done servers=${swept} config=${cfg.servers}/${cfg.hosts}hosts ` +
      `(${formatDuration(startedAt)})`,
  );
  return { servers: swept, skipped: servers.length - swept };
}
