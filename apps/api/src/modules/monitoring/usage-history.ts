/**
 * Resource usage over time — the read side of `resource_usage`.
 *
 * Three things here are less obvious than they look, and each has a wrong version
 * that produces a plausible-looking chart:
 *
 * 1. **"All" is summed, not stored.** No project-total row exists, so All is the
 *    per-bucket sum across services. A stored total would be a redundant copy free to
 *    drift, and wrong the moment a service is added or removed mid-window.
 *
 * 2. **Network counters are cumulative, so the series is a DIFFERENCE.** The runtimes
 *    report bytes since container start. Plotting them raw gives a monotonic ramp that
 *    says nothing; differencing consecutive buckets gives throughput. A restart resets
 *    the counter, so a negative difference means "restarted", not "negative traffic" —
 *    clamped to 0.
 *
 * 3. **Gaps must survive aggregation.** The output walks the full bucket range rather
 *    than the rows present, so a stretch with no samples (host down, sampler skipped)
 *    renders as explicit zero buckets instead of silently compressing the x-axis and
 *    making an outage look like continuous service.
 */

import { repos, RESOURCE_BUCKET_MINUTES, SINGLE_APP_SERVICE_KEY } from "@repo/db";
import { NotFoundError } from "@repo/core";
import type { RequestContext } from "../../lib/request-context";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface UsageHistoryBucket {
  /** Bucket start, epoch minutes. */
  minute: number;
  /** Average per-core CPU percent over the bucket. >100 is valid on a multi-core box. */
  cpuPercent: number;
  /** Average resident memory over the bucket, MB. */
  memoryMb: number;
  /** Bytes moved DURING this bucket (differenced from the cumulative counters). */
  networkRxBytes: number;
  networkTxBytes: number;
  /** False when no sample landed here — lets the UI render a gap rather than a zero. */
  hasData: boolean;
}

export interface UsageHistoryResult {
  buckets: UsageHistoryBucket[];
  /** Selectable series, for the All | service picker. */
  services: Array<{ serviceKey: string; name: string }>;
  /** Width of each returned bucket in minutes (>= RESOURCE_BUCKET_MINUTES). */
  granularityMinutes: number;
  /** Which series this is: a serviceKey, or null for All. */
  serviceKey: string | null;
}

/**
 * Target bucket count for a chart. Wider windows aggregate up to stay near this —
 * a 7-day window at raw 5-minute resolution is 2016 points, which is both slow to
 * ship and unreadable at chart width.
 */
const TARGET_BUCKETS = 180;

/** Roll up to a multiple of the base width so bucket edges always line up. */
function granularityFor(fromMinute: number, toMinute: number): number {
  const span = Math.max(1, toMinute - fromMinute);
  const ideal = span / TARGET_BUCKETS;
  const steps = Math.max(1, Math.ceil(ideal / RESOURCE_BUCKET_MINUTES));
  return steps * RESOURCE_BUCKET_MINUTES;
}

function floorTo(minute: number, width: number): number {
  return Math.floor(minute / width) * width;
}

// ─── Read ────────────────────────────────────────────────────────────────────

export async function getProjectUsageHistory(
  ctx: RequestContext,
  projectId: string,
  opts: { from?: string; to?: string; serviceKey?: string } = {},
): Promise<UsageHistoryResult> {
  const project = await repos.project.findById(projectId);
  if (!project || project.organizationId !== ctx.organizationId) {
    throw new NotFoundError("Project", projectId);
  }

  const toMs = opts.to ? new Date(opts.to).getTime() : Date.now();
  const fromMs = opts.from ? new Date(opts.from).getTime() : toMs - 24 * 60 * 60 * 1000;

  const services = await repos.service.listByProject(projectId);
  const selectable = services.map((s) => ({ serviceKey: s.id, name: s.name }));

  const empty: UsageHistoryResult = {
    buckets: [],
    services: selectable,
    granularityMinutes: RESOURCE_BUCKET_MINUTES,
    serviceKey: opts.serviceKey ?? null,
  };
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return empty;

  const width = granularityFor(
    Math.floor(fromMs / 60_000),
    Math.floor(toMs / 60_000),
  );
  const fromMinute = floorTo(Math.floor(fromMs / 60_000), width);
  const toMinute = floorTo(Math.floor(toMs / 60_000), width);

  // A serviceKey the caller doesn't own must not silently return another project's
  // data. Validated against this project's own services (plus the single-app
  // sentinel); anything else falls back to All rather than erroring, matching how the
  // traffic resolver treats an untracked domain.
  const validKeys = new Set([...selectable.map((s) => s.serviceKey), SINGLE_APP_SERVICE_KEY]);
  const serviceKey =
    opts.serviceKey && validKeys.has(opts.serviceKey) ? opts.serviceKey : undefined;

  const rows = await repos.resourceUsage.querySamples({
    projectId,
    serviceKey,
    fromMinute,
    // Through the END of the last bucket, not its start — otherwise the final bucket
    // only ever contains the one sample that landed exactly on its boundary.
    toMinute: toMinute + width - 1,
  });

  // ── Difference the cumulative network counters, PER SERIES ────────────────
  //
  // Per series, not globally: services' counters are independent, and differencing
  // across an interleaved stream would subtract one service's total from another's.
  const lastNet = new Map<string, { rx: number; tx: number }>();
  const deltas = rows.map((r) => {
    const prev = lastNet.get(r.serviceKey);
    lastNet.set(r.serviceKey, { rx: r.networkRxBytes, tx: r.networkTxBytes });
    return {
      ...r,
      // Clamp at 0: a counter that went backwards means the container restarted, not
      // that it un-sent bytes. First sample of a series has no predecessor → 0.
      rxDelta: prev ? Math.max(0, r.networkRxBytes - prev.rx) : 0,
      txDelta: prev ? Math.max(0, r.networkTxBytes - prev.tx) : 0,
    };
  });

  // ── Accumulate into output buckets ────────────────────────────────────────
  //
  // CPU and memory are AVERAGED, network is SUMMED — they answer different questions
  // ("how loaded was it" vs "how much moved"). Averaging bytes would understate a
  // wide bucket; summing a gauge would be meaningless.
  //
  // For All, each bucket's CPU is the sum across services, then averaged over the
  // number of sample ROUNDS in the bucket — so a 3-service stack sampled twice in a
  // 15-minute bucket reports the stack's typical load, not 6x it.
  interface Acc {
    cpuSum: number;
    memSum: number;
    rx: number;
    tx: number;
    /** Distinct sample rounds (bucket minutes) seen, the divisor for the averages. */
    rounds: Set<number>;
  }
  const acc = new Map<number, Acc>();
  for (const r of deltas) {
    const key = floorTo(r.minute, width);
    let a = acc.get(key);
    if (!a) {
      a = { cpuSum: 0, memSum: 0, rx: 0, tx: 0, rounds: new Set() };
      acc.set(key, a);
    }
    a.cpuSum += r.cpuPercent;
    a.memSum += r.memoryMb;
    a.rx += r.rxDelta;
    a.tx += r.txDelta;
    a.rounds.add(r.minute);
  }

  // Walk the FULL range so gaps are explicit zero buckets, not a compressed axis.
  const buckets: UsageHistoryBucket[] = [];
  for (let m = fromMinute; m <= toMinute; m += width) {
    const a = acc.get(m);
    const rounds = a ? a.rounds.size : 0;
    buckets.push({
      minute: m,
      cpuPercent: rounds > 0 ? Math.round((a!.cpuSum / rounds) * 100) / 100 : 0,
      memoryMb: rounds > 0 ? Math.round((a!.memSum / rounds) * 100) / 100 : 0,
      networkRxBytes: a?.rx ?? 0,
      networkTxBytes: a?.tx ?? 0,
      hasData: rounds > 0,
    });
  }

  return {
    buckets,
    services: selectable,
    granularityMinutes: width,
    serviceKey: serviceKey ?? null,
  };
}
