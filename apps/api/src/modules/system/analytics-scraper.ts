/**
 * Analytics scraper — periodic background job that flushes analytics from
 * each managed server's OpenResty shared-dict memory into Postgres.
 *
 * Runs on a setInterval. For each server it:
 *   1. Lists all known domains (from the totals endpoint)
 *   2. Flushes minute-bucket data for each domain (read + delete from OpenResty)
 *   3. Fetches today's geo data for each domain
 *   4. Upserts everything into the analytics tables
 *
 * The flush operation (POST /analytics/flush) atomically reads and deletes
 * minute-bucket keys from OpenResty's shared-dict. This ensures:
 *   - No duplication between live OpenResty data and DB archive
 *   - No data loss on OpenResty restart (already flushed to DB)
 *   - The read path can always combine DB + live without overlap
 */

import { repos } from "@repo/db";
import { systemDebug, formatDuration } from "../../lib/system-debug";
import { fetchMgmt, postMgmt } from "../../lib/project-analytics";

function debug(msg: string): void {
  systemDebug("analytics-scraper", msg);
}

const SCRAPE_INTERVAL = 5 * 60_000; // 5 minutes

let scrapeTimer: ReturnType<typeof setInterval> | null = null;

// ── Per-server scrape ────────────────────────────────────────────────────────

async function scrapeServer(serverId: string): Promise<void> {
  const startedAt = Date.now();
  debug(`scrape:start server=${serverId}`);

  // 1. Health check
  const health = await fetchMgmt(serverId, "/health");
  if (!health) {
    debug(`scrape:skip server=${serverId} — mgmt unreachable`);
    return;
  }

  // 2. Get all domains from totals endpoint
  const totalsResult = await fetchMgmt(serverId, "/analytics/totals") as {
    domains?: { domain: string; requests: number; bandwidth_in: number; bandwidth_out: number }[];
  } | null;

  if (!totalsResult?.domains?.length) {
    debug(`scrape:done server=${serverId} — no domains (${formatDuration(startedAt)})`);
    return;
  }

  const now = Math.floor(Date.now() / 60_000); // current epoch minute

  for (const domainInfo of totalsResult.domains) {
    const domain = domainInfo.domain;

    // 3. Determine time range for incremental scrape
    const lastMinute = await repos.analytics.getLastScrapedMinute(serverId, domain);
    const fromMinute = lastMinute ? lastMinute + 1 : now - 60; // default: last hour
    // Don't flush the current minute — it's still accumulating
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

    if (bucketsResult?.buckets?.length) {
      const rows = bucketsResult.buckets.map((b) => ({
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

  debug(`scrape:done server=${serverId} domains=${totalsResult.domains.length} (${formatDuration(startedAt)})`);
}

// ── Main scrape loop ─────────────────────────────────────────────────────────

async function scrapeAll(): Promise<void> {
  try {
    const servers = await repos.server.list();
    if (servers.length === 0) return;

    debug(`scrape-all:start servers=${servers.length}`);

    for (const server of servers) {
      try {
        await scrapeServer(server.id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        debug(`scrape-all:server-error server=${server.id} ${msg}`);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    debug(`scrape-all:error ${msg}`);
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Start the periodic analytics scraper. */
export function startAnalyticsScraper(): void {
  if (scrapeTimer) return;
  debug("starting analytics scraper");

  // First scrape after a short delay (let SSH connections settle)
  setTimeout(() => void scrapeAll(), 15_000);

  scrapeTimer = setInterval(() => void scrapeAll(), SCRAPE_INTERVAL);
  // Don't prevent graceful shutdown
  scrapeTimer.unref();
}

/** Stop the periodic analytics scraper. */
export function stopAnalyticsScraper(): void {
  if (scrapeTimer) {
    clearInterval(scrapeTimer);
    scrapeTimer = null;
    debug("stopped analytics scraper");
  }
}
