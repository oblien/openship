/**
 * Analytics scraper - flushes analytics from a managed server's OpenResty
 * shared-dict memory into Postgres. Runs ON-DEMAND (no background interval):
 * `scrapeServerIfStale` is called when someone views a server's analytics.
 *
 * For a server it:
 *   1. Lists all known domains (from the totals endpoint)
 *   2. Flushes minute-bucket data for each domain (read + delete from OpenResty)
 *   3. Fetches today's geo data for each domain
 *   4. Upserts everything into the analytics tables
 *
 * The flush operation (POST /analytics/flush) atomically reads and deletes
 * minute-bucket keys from OpenResty's shared-dict, so DB + live never overlap.
 * OpenResty buckets carry a 24h TTL, so on-demand scraping loses nothing
 * between views within a day (an OpenResty restart in an unviewed gap loses
 * only that gap's buckets).
 */

import { repos } from "@repo/db";
import { env } from "../../config";
import { cacheStore } from "../../lib/cache-store";
import { systemDebug, formatDuration } from "../../lib/system-debug";
import { fetchMgmt, postMgmt, probeMgmt } from "../../lib/project-analytics";
import { safeErrorMessage } from "@repo/core";

function debug(msg: string): void {
  systemDebug("analytics-scraper", msg);
}

// ── Per-server scrape ────────────────────────────────────────────────────────

async function scrapeServer(serverId: string): Promise<void> {
  const startedAt = Date.now();
  debug(`scrape:start server=${serverId}`);

  // 1. Health check
  const health = await probeMgmt(serverId);
  if (!health) {
    debug(`scrape:skip server=${serverId} - mgmt unreachable`);
    return;
  }

  // 2. Get all domains from totals endpoint
  const totalsResult = await fetchMgmt(serverId, "/analytics/totals") as {
    domains?: { domain: string; requests: number; bandwidth_in: number; bandwidth_out: number }[];
  } | null;
  const domains = Array.isArray(totalsResult?.domains) ? totalsResult.domains : [];

  if (domains.length === 0) {
    debug(`scrape:done server=${serverId} - no domains (${formatDuration(startedAt)})`);
    return;
  }

  const now = Math.floor(Date.now() / 60_000); // current epoch minute

  for (const domainInfo of domains) {
    const domain = domainInfo.domain;

    // 3. Determine time range for incremental scrape
    const lastMinute = await repos.analytics.getLastScrapedMinute(serverId, domain);
    const fromMinute = lastMinute ? lastMinute + 1 : now - 60; // default: last hour
    // Don't flush the current minute - it's still accumulating
    const toMinute = now - 1;

    if (fromMinute > toMinute) continue;

    // 4. Flush minute-bucket analytics (read + delete from OpenResty)
    const bucketsResult = await postMgmt(
      serverId,
      `/analytics/flush?domain=${encodeURIComponent(domain)}&from=${fromMinute}&to=${toMinute}`,
    ) as { buckets?: Array<{
      minute: number;
      requests: number;
      unique_requests: number;
      bandwidth_in: number;
      bandwidth_out: number;
      response_time: number;
      countries?: Record<string, number>;
    }>; flushed?: number } | null;
    const buckets = Array.isArray(bucketsResult?.buckets) ? bucketsResult.buckets : [];

    if (buckets.length > 0) {
      const rows = buckets.map((b) => ({
        serverId,
        domain,
        minute: b.minute,
        requests: b.requests,
        uniqueRequests: b.unique_requests,
        bandwidthIn: b.bandwidth_in,
        bandwidthOut: b.bandwidth_out,
        responseTime: b.response_time,
        countries: b.countries ? b.countries : null,
      }));

      await repos.analytics.upsertBuckets(rows);
      debug(`scrape:buckets server=${serverId} domain=${domain} rows=${rows.length}`);
    }

    // 5. Fetch today's geo data
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, ""); // YYYYMMDD
    const geoResult = await fetchMgmt(
      serverId,
      `/analytics/geo?domain=${encodeURIComponent(domain)}&day=${today}`,
    ) as { countries?: Record<string, number> } | null;

    if (geoResult?.countries && Object.keys(geoResult.countries).length > 0) {
      await repos.analytics.upsertGeo([{
        serverId,
        domain,
        day: today,
        countries: geoResult.countries,
      }]);
    }
  }

  debug(`scrape:done server=${serverId} domains=${domains.length} (${formatDuration(startedAt)})`);
}

// ── On-demand scrape ─────────────────────────────────────────────────────────
//
// No background interval. A server is scraped only when its analytics is
// viewed (analytics.controller → serverAnalytics/serverGeo). Self-throttling:
// staleness-gated so repeated reads within the window don't re-hit the server,
// and in-flight-deduped so concurrent reads share one scrape.

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
      inflightScrape.delete(serverId);
    }
  })();

  inflightScrape.set(serverId, work);
  return work;
}
