/**
 * Visitor geography + daily rollups for a project — the data behind the country
 * map, the visitor counts, top paths, and response mix.
 *
 * Mode dispatch reuses the boundary the rest of analytics already uses,
 * `resolveProjectTrafficSources()`: a project's traffic is observed either at a
 * managed server's OpenResty (self-hosted) or at Oblien's edge (Cloud), and the
 * source objects say which. No new adapter layer — this is the same handoff the
 * timeseries path takes, applied to a different metric.
 *
 *   self-hosted → server_analytics_geo (scraped archive) + a live tail read
 *                 straight off the edge's mgmt API for TODAY
 *   cloud       → Oblien analytics.geo, read through, never persisted here
 *
 * ── On today's row and double counting ──────────────────────────────────────
 *
 * The daily counters are RUNNING TOTALS in the edge's shared dict (48h TTL), not
 * deltas: every scrape re-reads the whole day and the upsert overwrites. So the DB
 * row for today and a live read of today are two snapshots of the SAME counter,
 * and summing them would roughly double today's numbers. Today is therefore taken
 * from the live read when it answers (fresher) and from the DB row otherwise —
 * never both. Past days only ever exist in the DB.
 */

import { repos } from "@repo/db";
import { NotFoundError } from "@repo/core";
import {
  resolveProjectTrafficSources,
  fetchMgmt,
  type ProjectTrafficSource,
} from "../../lib/project-analytics";
import { proxyCloudAnalytics } from "../cloud/cloud-analytics.service";
import { scrapeServerIfStale } from "../system/analytics-scraper";
import type { RequestContext } from "../../lib/request-context";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface GeoCountry {
  /** ISO-3166-1 alpha-2, uppercase. */
  code: string;
  count: number;
  /** Share of `total`, 1dp. */
  pct: number;
}

export interface PathCount {
  path: string;
  count: number;
}

export interface ProjectGeoResult {
  total: number;
  countries: GeoCountry[];
  /**
   * Distinct visitors summed PER DAY across the window — so a visitor who returns
   * on three days counts three times.
   *
   * Not a bug and not fixable by summing differently: the edge dedups within a day
   * (a salted-hash set that rotates with the salt), and per-day counts cannot be
   * combined into a window-distinct figure. Doing that properly needs a mergeable
   * sketch — an HLL per day, unioned at read — which is a much larger change and
   * is deliberately not claimed here.
   *
   * Named `visitorDays` rather than `visitors` for that reason. The whole point of
   * this change was to stop shipping a number whose label overstated it (the old
   * "unique IPs" was a request count), so this must not repeat it one field over.
   * `peakDayVisitors` below is the honest lower bound on window-distinct visitors.
   */
  visitorDays: number;
  /**
   * The largest single-day distinct count in the window — exact for that day, and a
   * true LOWER bound on distinct visitors across the whole window. Together with
   * `visitorDays` (the upper bound) it brackets the real number.
   */
  peakDayVisitors: number;
  topPaths: PathCount[];
  statuses: Record<string, number>;
  /**
   * False when the edge cannot resolve countries at all (no libmaxminddb / no
   * database). The distinction matters: without it "geo is broken" and "nobody
   * visited" both render as an empty map, which is how this went unnoticed.
   * Always true for cloud — Oblien resolves geo at its own edge.
   */
  geoAvailable: boolean;
  /** Visitor count may understate (edge visitor zone under eviction pressure). */
  approximate: boolean;
  /**
   * Whether per-path aggregation is switched on for this project.
   *
   * Needed because "collection is off" and "collection is on but nothing has arrived yet"
   * both produce an empty `topPaths`, and they call for opposite things in the UI — an
   * Enable button versus a wait. Without this the dashboard cannot tell them apart, which
   * is how an opt-in feature looks broken.
   *
   * Always true for cloud: Oblien's edge aggregates paths regardless, so there is nothing
   * to opt into there.
   */
  pathsEnabled: boolean;
  source: "self-hosted" | "cloud" | "none";
}

const EMPTY: ProjectGeoResult = {
  total: 0,
  countries: [],
  visitorDays: 0,
  peakDayVisitors: 0,
  topPaths: [],
  statuses: {},
  geoAvailable: true,
  approximate: false,
  pathsEnabled: false,
  source: "none",
};

const TOP_PATHS_LIMIT = 20;
/** Same reasoning as LIVE_TAIL_TIMEOUT_MS in analytics.service.ts: the tunnel to a
 *  remote edge can hang, and a slow tail must never hold up the whole response. */
const LIVE_READ_TIMEOUT_MS = 3500;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** "YYYYMMDD" in UTC — the key format site_logger.lua writes (os.date("!...")). */
function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");
}

function bounded<T>(work: Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const capped = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), LIVE_READ_TIMEOUT_MS);
  });
  return Promise.race([work.catch(() => fallback), capped]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function addInto(target: Record<string, number>, src: unknown): void {
  if (!src || typeof src !== "object") return;
  for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) target[k] = (target[k] ?? 0) + v;
  }
}

/** Counts map → sorted, percentaged country list. */
function toCountries(counts: Record<string, number>): { countries: GeoCountry[]; total: number } {
  // FILTER FIRST, then total. Two uppercase letters only — the edge reader already
  // drops bookkeeping keys, but a row written before that filter existed can still
  // hold one (e.g. `pn`, the distinct-path counter, which is often larger than any
  // single country). Totalling before filtering let such a key inflate `total` and
  // skew every percentage downward while itself staying invisible in the list.
  const entries = Object.entries(counts).filter(([code]) => /^[A-Z]{2}$/.test(code));
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  const countries = entries
    .map(([code, count]) => ({
      code,
      count,
      pct: total > 0 ? Math.round((count / total) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.count - a.count);
  return { countries, total };
}

function toTopPaths(counts: Record<string, number>): PathCount[] {
  return Object.entries(counts)
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_PATHS_LIMIT);
}

// ─── Self-hosted ─────────────────────────────────────────────────────────────

interface DailyRollup {
  countries?: unknown;
  visitors?: number;
  paths?: unknown;
  statuses?: unknown;
}

/** Does this server's edge actually resolve countries? Best-effort; assume yes on
 *  a failed probe so an unreachable box doesn't render as "geo broken". */
async function probeGeoAvailable(serverId: string): Promise<{ geo: boolean; approximate: boolean }> {
  const status = await bounded(
    fetchMgmt<{
      geo?: { available?: boolean };
      dicts?: Record<string, { capacity?: number; free_space?: number }>;
    }>(serverId, "/status"),
    null,
  );
  if (!status) return { geo: true, approximate: false };
  const v = status.dicts?.visitors;
  // Under ~10% headroom the visitor zone is evicting, so its cardinality
  // understates. Report it rather than presenting the artifact as a measurement.
  const approximate =
    !!v?.capacity && typeof v.free_space === "number" && v.free_space < v.capacity * 0.1;
  return { geo: status.geo?.available !== false, approximate };
}

async function collectSelfHosted(
  sources: Extract<ProjectTrafficSource, { kind: "self-hosted" }>[],
  fromMs: number,
  toMs: number,
  pathsEnabled: boolean,
): Promise<ProjectGeoResult> {
  const today = dayKey(Date.now());
  const fromDay = dayKey(fromMs);
  const toDay = dayKey(toMs);

  const countries: Record<string, number> = {};
  const paths: Record<string, number> = {};
  const statuses: Record<string, number> = {};
  // Upper bound (sum of per-day distinct) and lower bound (largest single day) —
  // see the field docs on ProjectGeoResult.
  let visitorDays = 0;
  let peakDayVisitors = 0;
  let geoAvailable = true;
  let approximate = false;

  // Viewing IS what drives a scrape (there is no background interval) — same
  // fire-and-forget, self-throttled call the per-server routes make.
  for (const serverId of new Set(sources.map((s) => s.serverId))) {
    void scrapeServerIfStale(serverId);
  }

  const probes = new Map<string, Promise<{ geo: boolean; approximate: boolean }>>();
  for (const serverId of new Set(sources.map((s) => s.serverId))) {
    probes.set(serverId, probeGeoAvailable(serverId));
  }

  await Promise.all(
    sources.map(async ({ serverId, domain }) => {
      const rows = await repos.analytics.queryGeoRange({ serverId, domain, fromDay, toDay });

      // Live read of TODAY only, and it REPLACES today's DB row rather than adding
      // to it — see the double-counting note in the file header.
      const liveToday =
        toDay >= today && today >= fromDay
          ? await bounded(
              fetchMgmt<DailyRollup>(
                serverId,
                `/analytics/geo?domain=${encodeURIComponent(domain)}&day=${today}`,
              ),
              null,
            )
          : null;

      for (const row of rows) {
        if (row.day === today && liveToday) continue; // live wins for today
        addInto(countries, row.countries);
        addInto(paths, row.paths);
        addInto(statuses, row.statuses);
        const v = row.visitors ?? 0;
        visitorDays += v;
        peakDayVisitors = Math.max(peakDayVisitors, v);
      }
      if (liveToday) {
        addInto(countries, liveToday.countries);
        addInto(paths, liveToday.paths);
        addInto(statuses, liveToday.statuses);
        const v = typeof liveToday.visitors === "number" ? liveToday.visitors : 0;
        visitorDays += v;
        peakDayVisitors = Math.max(peakDayVisitors, v);
      }

      const probe = await probes.get(serverId)!;
      if (!probe.geo) geoAvailable = false;
      if (probe.approximate) approximate = true;
    }),
  );

  const { countries: list, total } = toCountries(countries);
  return {
    total,
    countries: list,
    visitorDays,
    peakDayVisitors,
    topPaths: toTopPaths(paths),
    statuses,
    geoAvailable,
    approximate,
    pathsEnabled,
    source: "self-hosted",
  };
}

// ─── Cloud ───────────────────────────────────────────────────────────────────

/**
 * Oblien returns `{ success, data: { total, countries: [{code,count,pct}] } }`, and
 * the cloud proxy wraps that again. Walk down nested data/result wrappers rather
 * than reading a fixed depth — the same wrapper-depth trap `extractCloudBuckets`
 * in analytics.service.ts documents, where reading one level short yielded a
 * single bogus entry whose numeric fields were all undefined.
 */
function extractCloudGeo(result: unknown): { total: number; countries: GeoCountry[] } {
  let node: unknown = result;
  for (let depth = 0; depth < 5 && node && typeof node === "object"; depth++) {
    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj.countries)) {
      const countries = (obj.countries as Array<Record<string, unknown>>)
        .map((c) => ({
          code: String(c.code ?? "").toUpperCase(),
          count: Number(c.count ?? 0),
          pct: Number(c.pct ?? 0),
        }))
        .filter((c) => /^[A-Z]{2}$/.test(c.code) && Number.isFinite(c.count));
      const total =
        typeof obj.total === "number"
          ? obj.total
          : countries.reduce((a, c) => a + c.count, 0);
      return { total, countries: countries.sort((a, b) => b.count - a.count) };
    }
    node = obj.data ?? obj.result;
  }
  return { total: 0, countries: [] };
}

async function collectCloud(
  organizationId: string,
  sources: Extract<ProjectTrafficSource, { kind: "cloud" }>[],
  fromMs: number,
  toMs: number,
): Promise<ProjectGeoResult> {
  const settled = await Promise.allSettled(
    sources.map((s) =>
      proxyCloudAnalytics(organizationId, {
        operation: "geo",
        domain: s.domain,
        params: { from: fromMs, to: toMs },
      }),
    ),
  );

  const counts: Record<string, number> = {};
  for (const r of settled) {
    if (r.status !== "fulfilled") continue;
    for (const c of extractCloudGeo(r.value).countries) {
      counts[c.code] = (counts[c.code] ?? 0) + c.count;
    }
  }

  const { countries, total } = toCountries(counts);
  return {
    ...EMPTY,
    total,
    countries,
    // Oblien's geo endpoint returns countries only. Visitors come from the
    // timeseries buckets (unique_visitors) on the overview path, and paths aren't
    // exposed by the SDK at all — left at EMPTY's zeros here rather than faked, and
    // the UI falls through to the overview's own visitor count for cloud projects.
    geoAvailable: true,
    // Nothing to opt into on cloud: Oblien's edge aggregates paths regardless, so the
    // dashboard must not offer an Enable button that would have nothing to switch.
    pathsEnabled: true,
    source: "cloud",
  };
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * Country + daily-rollup data for a project over a window (defaults: last 7 days).
 *
 * An unroutable project (no tracked domain, no server) is a legitimate empty, not
 * an error — a fresh project must render a clean zero state.
 */
export async function getProjectGeo(
  ctx: RequestContext,
  projectId: string,
  from?: string,
  to?: string,
  domain?: string,
): Promise<ProjectGeoResult> {
  const project = await repos.project.findById(projectId);
  if (!project || project.organizationId !== ctx.organizationId) {
    throw new NotFoundError("Project", projectId);
  }

  const toMs = to ? new Date(to).getTime() : Date.now();
  const fromMs = from ? new Date(from).getTime() : toMs - 7 * 24 * 60 * 60 * 1000;
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return EMPTY;

  // `domain` is validated against the project's tracked domains inside the
  // resolver (an unknown value falls back to the primary), so a client can never
  // read analytics for an arbitrary cross-tenant host.
  const sources = await resolveProjectTrafficSources(projectId, { domain });
  if (sources.length === 0) return EMPTY;

  const cloud = sources.filter((s): s is Extract<ProjectTrafficSource, { kind: "cloud" }> => s.kind === "cloud");
  if (cloud.length === sources.length) {
    return collectCloud(ctx.organizationId, cloud, fromMs, toMs);
  }

  const selfHosted = sources.filter(
    (s): s is Extract<ProjectTrafficSource, { kind: "self-hosted" }> => s.kind === "self-hosted",
  );
  return collectSelfHosted(selfHosted, fromMs, toMs, project.collectPaths === true);
}
