import type { AnalyticsData } from "@/hooks/useProjectEndpoints";

export interface TrafficPoint {
  from: number;
  to: number;
  timestamp: number;
  requests: number | null;
}

/** Keep actual intervals; an absent interval is a gap, never invented traffic. */
export function buildTrafficSeries(periods: AnalyticsData["trafficByHour"]): TrafficPoint[] {
  const ordered = periods.map((period) => ({
    from: Date.parse(period.from),
    to: Date.parse(period.to),
    requests: period.requests,
  })).filter((period) =>
    Number.isFinite(period.from) && Number.isFinite(period.to) && period.to > period.from &&
    Number.isFinite(period.requests) && period.requests >= 0,
  ).sort((a, b) => a.from - b.from);

  const points: TrafficPoint[] = [];
  for (const period of ordered) {
    const previous = points.at(-1);
    if (previous && previous.to < period.from) {
      points.push({
        from: previous.to,
        to: period.from,
        timestamp: (previous.to + period.from) / 2,
        requests: null,
      });
    }
    points.push({ ...period, timestamp: (period.from + period.to) / 2 });
  }
  return points;
}
