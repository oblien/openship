"use client";

/**
 * Variant switcher around `MonitoringView`, driven entirely by fixtures.
 *
 * Every variant is a state that is awkward or slow to reproduce against a real
 * install, which is exactly why they were never reviewed:
 *
 *   compose  — 5 services, one crash-looping, one stopped, a memory ramp and a
 *              sampler gap in the history
 *   single   — one container: no scope tabs, no per-service dots
 *   static   — NO container at all. The resource block must disappear entirely,
 *              not render four zeroes
 *   no-geo   — the edge can't resolve countries: advisory, not an empty map
 *   empty    — a project with no traffic and no samples yet
 *   loading  — every skeleton at once
 */

import React from "react";
import { TrafficChart, TopPaths } from "../../projects/[id]/components/general";
import { MonitoringView } from "@/components/monitoring/MonitoringView";
import {
  MOCK_SERVICES,
  mockAnalytics,
  mockComposeUsage,
  mockGeo,
  mockGeoUnavailable,
  mockHistoryBuckets,
  mockSingleUsage,
  mockStaticUsage,
} from "@/components/monitoring/fixtures";

type Variant = "compose" | "single" | "static" | "no-geo" | "empty" | "loading";

const VARIANTS: Array<{ id: Variant; label: string; note: string }> = [
  { id: "compose", label: "Compose stack", note: "5 services · one crash-looping · one stopped · history with a gap" },
  { id: "single", label: "Single container", note: "no scope tabs, no per-service dots" },
  { id: "static", label: "Static site", note: "nothing to measure — resource block must be absent" },
  { id: "no-geo", label: "Edge without GeoIP", note: "advisory instead of an empty map" },
  { id: "empty", label: "No data yet", note: "fresh project: no traffic, no samples" },
  { id: "loading", label: "Loading", note: "every skeleton at once" },
];

export function MonitoringPreview() {
  const [variant, setVariant] = React.useState<Variant>("compose");
  const [serviceKey, setServiceKey] = React.useState<string | null>(null);

  const loading = variant === "loading";
  const empty = variant === "empty";

  const analytics = loading || empty ? null : mockAnalytics();
  const geo = loading || empty ? null : variant === "no-geo" ? mockGeoUnavailable() : mockGeo();

  const usage =
    loading || empty
      ? null
      : variant === "static"
        ? mockStaticUsage
        : variant === "single"
          ? mockSingleUsage
          : mockComposeUsage;

  const history =
    loading || empty
      ? null
      : {
          buckets: variant === "static" ? [] : mockHistoryBuckets(),
          // Scope tabs only appear for >1 service, so single/static get none.
          services: variant === "compose" ? MOCK_SERVICES : [],
          granularityMinutes: 5,
        };

  const topPaths = geo
    ? geo.topPaths.map((p) => {
        const total = geo.topPaths.reduce((s, x) => s + x.count, 0);
        return { ...p, percentage: ((p.count / total) * 100).toFixed(1) };
      })
    : [];

  const note = VARIANTS.find((v) => v.id === variant)!.note;

  return (
    <div className="space-y-5 p-5">
      <div className="rounded-2xl border border-warning-border bg-warning-bg p-4">
        <p className="text-sm font-medium text-foreground">
          Monitoring layout preview — fixtures, not real data
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Dev-only route; 404s in a production build. Nothing here reads the API. The same
          fixtures are reachable on a real project via{" "}
          <code className="rounded bg-card px-1">?mock=compose</code> (also{" "}
          <code className="rounded bg-card px-1">single</code>,{" "}
          <code className="rounded bg-card px-1">static</code>,{" "}
          <code className="rounded bg-card px-1">no-geo</code>).
        </p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {VARIANTS.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => {
                setVariant(v.id);
                setServiceKey(null);
              }}
              aria-pressed={variant === v.id}
              className={`rounded-lg px-3 py-1.5 text-xs transition-colors ${
                variant === v.id
                  ? "bg-primary text-primary-foreground"
                  : "bg-card text-muted-foreground hover:text-foreground"
              }`}
            >
              {v.label}
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted-foreground/80">{note}</p>
      </div>

      <MonitoringView
        analytics={analytics}
        isLoadingAnalytics={loading}
        geo={geo}
        isLoadingGeo={loading}
        history={history}
        isLoadingHistory={loading}
        usage={usage}
        isUsageConnected={!loading && !empty}
        usageError={null}
        onReconnectUsage={() => {}}
        serviceKey={serviceKey}
        onServiceKeyChange={setServiceKey}
        trafficChart={
          <TrafficChart
            trafficData={analytics?.trafficByHour ?? []}
            isLoading={loading}
            dateRange={
              analytics
                ? `${new Date(analytics.summary.firstRequest).toLocaleDateString()} - ${new Date(analytics.summary.lastRequest).toLocaleDateString()}`
                : undefined
            }
            totalRequests={analytics?.summary.totalRequests}
          />
        }
        topPaths={topPaths.length > 0 ? <TopPaths paths={topPaths} /> : null}
      />
    </div>
  );
}
