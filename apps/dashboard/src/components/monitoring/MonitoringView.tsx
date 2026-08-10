"use client";

/**
 * The Monitoring tab's layout, with every input arriving as a PROP.
 *
 * Split out from `MonitoringTab` (which now only wires hooks) for one concrete
 * reason: the layout could not be looked at without a running control plane, a
 * deployed project, and real traffic — so it shipped twice on nothing but a
 * typecheck. Prop-driven, it renders from fixtures, and `/dev/monitoring` does
 * exactly that.
 *
 * ── Layout decisions ────────────────────────────────────────────────────────
 *
 * Seven stacked full-width cards became four blocks, because the first version had
 * no hierarchy: eight near-identical tiles (four live metrics + four traffic stats),
 * two line charts, and a map squeezed into 55% of a card, all in one column.
 *
 *   • Stats are a COMPACT strip, not cards. They're reference numbers, not the
 *     subject, and at card weight they out-shouted the charts.
 *   • Live resources and their history share ONE card. "Now" and "over time" are the
 *     same subject; two cards implied two topics and hid the relationship.
 *   • The map is FULL WIDTH with the donut and legend beneath it. At 55% width a
 *     world map is too small to find a country on, and the thing you read values off
 *     was pushed out of view.
 *   • Top paths and responses sit SIDE BY SIDE. Both are short lists; each at full
 *     width was mostly empty space and another screen of scrolling.
 */

import React from "react";
import { ArrowUpDown, Gauge, Server, Users } from "lucide-react";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { ResourceCards } from "./ResourceCards";
import { ResourceHistoryChart, type UsageHistoryBucket } from "./ResourceHistoryChart";
import { VisitorMap } from "./VisitorMap";
import { DomainSwitcher } from "@/components/routing/DomainSwitcher";
import { ResponseMix } from "./ResponseMix";
import { CollapsibleCard } from "./CollapsibleCard";
import { formatCount } from "./format";
import type { ProjectUsage } from "@/hooks/useProjectUsageStream";
import type { AnalyticsData, AnalyticsGeoResponse } from "@/hooks/useProjectEndpoints";

export interface MonitoringViewProps {
  analytics: AnalyticsData | null;
  isLoadingAnalytics: boolean;
  geo: AnalyticsGeoResponse | null;
  isLoadingGeo: boolean;
  history: {
    buckets: UsageHistoryBucket[];
    services: Array<{ serviceKey: string; name: string }>;
    granularityMinutes: number;
  } | null;
  isLoadingHistory: boolean;
  /** Whether this platform persists a usage-history series at all. Desktop samples
   *  nothing (no background sampler), so the chart would only ever show its empty
   *  state — hide it there. Defaults to true; the live "right now" card is unaffected. */
  historySupported?: boolean;
  usage: ProjectUsage | null;
  isUsageConnected: boolean;
  usageError: string | null;
  onReconnectUsage: () => void;
  /**
   * Scope for the resource views. null = All (the summed stack).
   *
   * Owned by the CALLER, not here: it keys the history fetch, so the component that
   * owns the fetch must own the state. The view raises changes.
   */
  serviceKey: string | null;
  onServiceKeyChange: (key: string | null) => void;
  trafficChart: React.ReactNode;
  /** Headline for the traffic block's collapsed summary, e.g. "99.4K requests". Shown on
   *  the fold so the block still carries a number while closed. */
  trafficSummary?: string;
  /** Null when there are no paths to show — the block is omitted rather than empty. */
  topPaths: React.ReactNode;
  /** Active fixture variant, or null for real data. */
  previewVariant?: string | null;
  /** Provided only in dev builds; its absence is what hides the control entirely. */
  onPreviewChange?: (v: "compose" | "single" | "static" | "no-geo" | null) => void;
  /** Every domain this project serves. The picker is hidden below two — with one domain
   *  "All" and "that domain" are the same thing. */
  domains?: string[];
  /** null = All. Scopes every analytics query on the tab, not just the map. */
  domainScope?: string | null;
  onDomainScopeChange?: (domain: string | null) => void;
  /** Live-hit plumbing, forwarded to the map. Omitted → no switch, which is what keeps
   *  the fixture preview from advertising a stream with nothing behind it. */
  live?: React.ComponentProps<typeof VisitorMap>["live"];
}

/**
 * Does this project have a workload whose resources can be measured?
 *
 * A static site is served by the shared edge from a volume — there is no container
 * per project, so there is nothing to sample. Previously that rendered as four zeroed
 * metrics and an empty history chart, which reads as "your app is using nothing"
 * rather than "this question doesn't apply here". Same for a runtime that can't
 * measure at all.
 *
 * A transient failure is deliberately NOT included: `usageError` means the host was
 * unreachable *this moment*, which is actionable and must stay visible.
 */
function hasMeasurableWorkload(usage: ProjectUsage | null, error: string | null): boolean {
  if (error) return true; // transient — keep the card so the error and Retry show
  if (!usage) return true; // still connecting; the card owns its own skeleton
  if (!usage.supported) return false;
  return usage.services.length > 0;
}

const StatTile: React.FC<{
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
}> = ({ icon, label, value, hint }) => (
  <div className="flex min-w-0 items-center gap-3 px-4 py-3">
    <div className="shrink-0 text-muted-foreground">{icon}</div>
    <div className="min-w-0">
      <p className="truncate text-xs text-muted-foreground">{label}</p>
      <p className="truncate text-lg font-semibold leading-tight tabular-nums text-foreground">
        {value}
      </p>
      {hint && <p className="truncate text-[11px] text-muted-foreground/70">{hint}</p>}
    </div>
  </div>
);

export const MonitoringView: React.FC<MonitoringViewProps> = ({
  analytics,
  isLoadingAnalytics,
  geo,
  isLoadingGeo,
  history,
  isLoadingHistory,
  historySupported = true,
  usage,
  isUsageConnected,
  usageError,
  onReconnectUsage,
  serviceKey,
  onServiceKeyChange,
  trafficChart,
  trafficSummary,
  topPaths,
  previewVariant = null,
  onPreviewChange,
  domains = [],
  domainScope = null,
  onDomainScopeChange,
  live,
}) => {
  const { t } = useI18n();
  const m = t.projects.monitoring;

  const showResources = hasMeasurableWorkload(usage, usageError);
  const services = history?.services ?? [];
  // No label when there is nothing to scope: a single-container app has no services,
  // so tagging its history "All services" describes a set that doesn't exist.
  const scopeLabel =
    services.length <= 1
      ? undefined
      : serviceKey === null
        ? m.allServices
        : (services.find((s) => s.serviceKey === serviceKey)?.name ?? serviceKey);

  // Visitors: self-hosted sums per-day distinct over the window (an upper bound);
  // cloud dedups upstream and reports a window figure. Neither is the old "unique
  // IPs", which counted page requests — so the LABEL differs with the source.
  const isCloudGeo = geo?.source === "cloud";
  const visitors = isCloudGeo
    ? (analytics?.summary?.uniqueVisitors ?? null)
    : (geo?.visitorDays ?? analytics?.summary?.uniqueVisitors ?? null);
  const visitorsLabel = isCloudGeo ? m.visitors : m.visitorDays;

  const hasAnalytics = !!analytics;

  return (
    <div className="space-y-5">
      {/* Unmissable while fixtures are driving the page — every number below is fake,
          and mistaking it for real data is the one failure this must not enable. */}
      {previewVariant && onPreviewChange && (
        <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-warning-border bg-warning-bg px-4 py-3">
          <span className="text-sm font-medium text-foreground">{m.previewActive}</span>
          <div className="flex flex-wrap gap-1">
            {(["compose", "single", "static", "no-geo"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => onPreviewChange(v)}
                aria-pressed={previewVariant === v}
                className={`rounded-lg px-2.5 py-1 text-xs transition-colors ${
                  previewVariant === v
                    ? "bg-primary text-primary-foreground"
                    : "bg-card text-muted-foreground hover:text-foreground"
                }`}
              >
                {v}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => onPreviewChange(null)}
            className="ml-auto rounded-lg px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {m.previewExit}
          </button>
        </div>
      )}

      {/* ── Reference numbers, as a strip ─────────────────────────────────── */}
      <div className="grid grid-cols-2 divide-border/50 overflow-hidden rounded-2xl bg-card sm:grid-cols-4 sm:divide-x">
        <StatTile
          icon={<Server className="size-4" />}
          label={t.projects.stats.serverRequests}
          value={hasAnalytics ? formatCount(analytics!.summary.totalRequests) : isLoadingAnalytics ? "…" : "0"}
          hint={
            hasAnalytics
              ? interpolate(t.projects.stats.requestsSubtext, {
                  total: formatCount(analytics!.summary.totalRequests),
                  avg: String(analytics!.summary.avgRequestsPerHour ?? 0),
                })
              : undefined
          }
        />
        <StatTile
          icon={<Users className="size-4" />}
          label={visitorsLabel}
          value={visitors == null ? (isLoadingGeo ? "…" : "0") : formatCount(visitors)}
          hint={geo?.approximate ? m.approximate : undefined}
        />
        <StatTile
          icon={<Gauge className="size-4" />}
          label={t.projects.stats.avgResponse}
          value={
            hasAnalytics
              ? `${analytics!.performance.avgResponseTimeMs.toFixed(0)}ms`
              : isLoadingAnalytics
                ? "…"
                : "—"
          }
          hint={t.projects.stats.responseTime}
        />
        <StatTile
          icon={<ArrowUpDown className="size-4" />}
          label={t.projects.stats.bandwidthOut}
          value={hasAnalytics ? analytics!.bandwidth.totalOutFormatted : isLoadingAnalytics ? "…" : "0 B"}
          hint={
            hasAnalytics
              ? interpolate(t.projects.stats.bandwidthInSubtext, {
                  value: analytics!.bandwidth.totalInFormatted,
                })
              : undefined
          }
        />
      </div>

      {/* ── Resources: now AND over time, one subject, one card ───────────── */}
      {showResources && (
        <div className="space-y-4 rounded-2xl bg-card p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-medium text-foreground">{m.resourcesTitle}</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">{m.resourcesSubtitle}</p>
            </div>
            {/* Scope lives in the header of what it governs, not in a card of its own. */}
            {services.length > 1 && (
              <div className="flex flex-wrap items-center gap-1">
                <ScopeButton
                  label={m.allServices}
                  active={serviceKey === null}
                  onClick={() => onServiceKeyChange(null)}
                />
                {services.map((s) => (
                  <ScopeButton
                    key={s.serviceKey}
                    label={s.name}
                    active={serviceKey === s.serviceKey}
                    onClick={() => onServiceKeyChange(s.serviceKey)}
                  />
                ))}
              </div>
            )}
          </div>

          <ResourceCards
            usage={usage}
            isConnected={isUsageConnected}
            error={usageError}
            onReconnect={onReconnectUsage}
            focusServiceKey={serviceKey}
          />
        </div>
      )}

      {!isLoadingAnalytics && !hasAnalytics && (
        <div className="rounded-2xl bg-card px-5 py-4">
          <p className="text-sm font-medium text-foreground">{m.noDataTitle}</p>
          <p className="mt-1 text-sm text-muted-foreground">{m.noDataDescription}</p>
          {/* Dev-only escape hatch. Without it the populated layout is unreachable
              until a project has a deploy, collected samples and real traffic — so it
              only ever got reviewed empty, which is not the thing being designed. */}
          {onPreviewChange && (
            <button
              type="button"
              onClick={() => onPreviewChange("compose")}
              className="mt-3 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
            >
              {m.previewSample}
            </button>
          )}
        </div>
      )}

      {/* ── Where it came from, before how much of it ─────────────────────── */}
      <VisitorMap
        data={geo}
        isLoading={isLoadingGeo}
        live={live}
        // Lives in the map's header because that is where it was asked for, but it scopes
        // the WHOLE tab — the traffic chart, paths and responses all follow it.
        // `DomainSwitcher`, not a bare <select>: the native control renders in OS chrome,
        // so it ignored the theme entirely and looked nothing like the toggle beside it.
        // This is also the same switcher the logs header and the Overview URL card use, so
        // a multi-domain project changes domain the same way everywhere in the app.
        domainSelector={
          domains.length > 1 && onDomainScopeChange ? (
            <DomainSwitcher
              domains={domains}
              value={domainScope ?? ""}
              onChange={(d) => onDomainScopeChange(d || null)}
              allowAll
            />
          ) : null
        }
      />

      {/* Traffic over time, COLLAPSED by default.
          The Overview tab already draws this series, so expanded it was ~300px of
          duplication between the map and the two lists below it. Not deleted, because the
          two are not equivalent: Overview's is a 120px hand-rolled sparkline with no
          tooltip pinned to the primary domain, while this one has tooltips and follows the
          domain-scope selector above. So it folds down to one header row that still states
          the total, and the choice is remembered. */}
      <CollapsibleCard
        title={m.trafficTitle}
        summary={trafficSummary}
        storageKey="openship.monitoring.trafficOpen"
      >
        {trafficChart}
      </CollapsibleCard>

      {/* Two short lists, side by side rather than two more full-width screens. */}
      <div className="grid gap-5 lg:grid-cols-2">
        {topPaths}
        <ResponseMix statuses={geo?.statuses} />
      </div>

      {/* History LAST, and only when there is a workload to have a history of.
          It sits at the end rather than beside the live numbers because the two are read
          at different times: the live card answers "is it healthy now", which is why you
          opened the tab; the series is what you go looking for afterwards. Stacked
          together at the top they competed, and the trend pushed the traffic blocks off
          the screen. The scope selector above still governs it — `scopeLabel` names the
          series so the two can't be read as describing different things. */}
      {showResources && historySupported && (
        <ResourceHistoryChart
          buckets={history?.buckets ?? []}
          granularityMinutes={history?.granularityMinutes ?? 5}
          isLoading={isLoadingHistory}
          scopeLabel={scopeLabel}
        />
      )}

    </div>
  );
};

const ScopeButton: React.FC<{ label: string; active: boolean; onClick: () => void }> = ({
  label,
  active,
  onClick,
}) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    className={`rounded-lg px-2.5 py-1 text-xs transition-colors ${
      active
        ? "bg-primary text-primary-foreground"
        : "text-muted-foreground hover:bg-muted hover:text-foreground"
    }`}
  >
    {label}
  </button>
);
