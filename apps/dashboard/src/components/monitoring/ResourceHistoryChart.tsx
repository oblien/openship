"use client";

/**
 * CPU and memory over time.
 *
 * The live stream next door answers "what is it doing right now"; this answers "was
 * memory climbing before the OOM at 3am", which the 5-second stream structurally
 * cannot because it keeps nothing.
 *
 * recharts, because it is already a dependency and already live in
 * `components/billing/UsageChart.tsx`. Deliberately NOT an extension of TrafficChart:
 * that one is single-series, hardcoded to `{hour, requests}`, and its
 * `<linearGradient id="trafficGradient">` is a fixed DOM id that would collide with a
 * second instance on the same page — which this is.
 *
 * Colors come from the theme's semantic CSS vars, not hex literals. `UsageChart` does
 * hardcode hexes; that's the one thing here not copied from it, since a hardcoded blue
 * is unreadable in half the themes.
 *
 * Two Y axes on purpose: percent and megabytes share no scale, and forcing them onto
 * one makes whichever is numerically smaller a flat line against the axis.
 */

import React, { useMemo } from "react";
import {
  Area,
  ComposedChart,
  CartesianGrid,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Activity } from "lucide-react";
import { useI18n } from "@/components/i18n-provider";
import { formatMb } from "./format";
import {
  CHART_CURSOR,
  CHART_TOOLTIP_LABEL_STYLE,
  CHART_TOOLTIP_STYLE,
} from "@/lib/chart-theme";

export interface UsageHistoryBucket {
  minute: number;
  cpuPercent: number;
  memoryMb: number;
  networkRxBytes: number;
  networkTxBytes: number;
  /** False when no sample landed in this bucket. */
  hasData: boolean;
}

interface Props {
  buckets: UsageHistoryBucket[];
  granularityMinutes: number;
  isLoading: boolean;
  /** Which series this is. Omitted when the project has nothing to scope (a single
   *  container), where naming a subset would imply a set that doesn't exist. */
  scopeLabel?: string;
  /**
   * Rendered INSIDE another card (the resources block), so it drops its own shell and
   * title. Nested card surfaces read as a bug, and the parent already says "resources".
   */
  embedded?: boolean;
}

export const ResourceHistoryChart: React.FC<Props> = ({
  buckets,
  granularityMinutes,
  isLoading,
  scopeLabel,
  embedded = false,
}) => {
  const { t, locale } = useI18n();
  const m = t.projects.monitoring;

  const timeFmt = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        hour: "2-digit",
        minute: "2-digit",
        // A window wide enough to have coarse buckets spans days, so the day matters
        // more than the minute.
        ...(granularityMinutes >= 60 ? { month: "short", day: "numeric" } : {}),
      }),
    [locale, granularityMinutes],
  );

  const data = useMemo(
    () =>
      buckets.map((b) => ({
        ...b,
        label: timeFmt.format(new Date(b.minute * 60_000)),
        // A bucket with no sample is a GAP, not a zero. Feeding null makes recharts
        // break the line there; feeding 0 would draw a dive to the axis and read as
        // "the container idled" when in fact nothing was measured.
        cpu: b.hasData ? b.cpuPercent : null,
        mem: b.hasData ? b.memoryMb : null,
      })),
    [buckets, timeFmt],
  );

  const hasAny = buckets.some((b) => b.hasData);

  const Shell: React.FC<{ children: React.ReactNode }> = ({ children }) =>
    embedded ? <div>{children}</div> : <div className="rounded-2xl bg-card p-5">{children}</div>;

  if (isLoading) {
    return (
      <Shell>
        <div className="mb-4 h-4 w-40 rounded bg-muted" />
        <div className="h-56 w-full rounded-xl bg-muted" />
      </Shell>
    );
  }

  return (
    <Shell>
      {/* The divider only makes sense when this sits inside another card; standalone it
          would be a rule floating above the title. */}
      <div
        className={`flex items-start justify-between gap-3 ${
          embedded ? "mb-3 border-t border-border/50 pt-4" : "mb-4"
        }`}
      >
        <div className="flex items-center gap-2">
          <Activity className="size-4 text-primary" />
          <h3 className="text-sm font-medium text-foreground">{m.historyTitle}</h3>
        </div>
        {scopeLabel && <span className="text-xs text-muted-foreground">{scopeLabel}</span>}
      </div>

      {!hasAny ? (
        // A just-deployed project legitimately has no history: the sampler runs every
        // few minutes, so this is a wait state, not a failure. Same illustration language
        // and `--th-*` tokens as TopPathsEmptyState so an empty card reads as part of the
        // app; the preview line reuses `--color-primary` — the real CPU series' color.
        <div className="py-2 text-center">
          <div className="relative mx-auto mb-5 h-32 w-52 max-w-full">
            <svg className="absolute inset-0 h-full w-full" viewBox="0 0 220 140" fill="none">
              {/* Card stack, same three-layer motif as the other empty states */}
              <rect x="52" y="40" width="118" height="76" rx="12" fill="var(--th-sf-04)" />
              <rect x="42" y="32" width="118" height="76" rx="12" fill="var(--th-sf-03)" stroke="var(--th-bd-subtle)" strokeWidth="1" />
              <rect x="32" y="24" width="118" height="76" rx="12" fill="var(--th-card-bg)" stroke="var(--th-bd-default)" strokeWidth="1" />

              {/* A time series inside the card — what it shows once samples land. Dashed
                  gridlines + an axis + a rising primary line, so it reads as "usage over
                  time" without any numbers. */}
              <line x1="44" y1="52" x2="140" y2="52" stroke="var(--th-on-06)" strokeWidth="1" strokeDasharray="3 3" />
              <line x1="44" y1="66" x2="140" y2="66" stroke="var(--th-on-06)" strokeWidth="1" strokeDasharray="3 3" />
              <line x1="44" y1="80" x2="140" y2="80" stroke="var(--th-on-06)" strokeWidth="1" strokeDasharray="3 3" />
              <path d="M44 40 V90 H140" stroke="var(--th-on-12)" strokeWidth="1.5" fill="none" />

              <path d="M48 82 66 72 84 76 102 60 120 54 138 46 138 90 48 90Z" fill="var(--color-primary)" fillOpacity="0.08" />
              <path d="M48 82 66 72 84 76 102 60 120 54 138 46" stroke="var(--color-primary)" strokeOpacity="0.5" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              <circle cx="66" cy="72" r="2" fill="var(--color-primary)" fillOpacity="0.4" />
              <circle cx="102" cy="60" r="2" fill="var(--color-primary)" fillOpacity="0.4" />

              {/* The single accent: the next point, ringed and dashed — "waiting to be
                  collected", matching the house CTA ring. */}
              <circle cx="138" cy="46" r="9" fill="var(--th-card-bg)" stroke="var(--th-on-20)" strokeWidth="1.5" strokeDasharray="3 2.5" />
              <circle cx="138" cy="46" r="3.5" fill="var(--color-primary)" />

              {/* Decorative dots + sparkle, matching the family */}
              <circle cx="18" cy="52" r="4" fill="var(--th-on-10)" />
              <circle cx="26" cy="112" r="4.5" fill="var(--th-on-08)" />
              <circle cx="12" cy="86" r="2.5" fill="var(--th-on-06)" />
              <circle cx="200" cy="40" r="3" fill="var(--th-on-12)" />
              <circle cx="196" cy="116" r="3.5" fill="var(--th-on-06)" />
              <path d="M14 68l1.8-3.6 1.8 3.6-3.6-1.8 3.6 0-3.6 1.8z" fill="var(--th-on-16)" />
            </svg>
          </div>

          <h4
            className="mb-2 text-base font-medium text-foreground/80"
            style={{ letterSpacing: "-0.2px" }}
          >
            {m.historyEmptyTitle}
          </h4>
          <p className="mx-auto mb-5 max-w-sm text-xs leading-relaxed text-muted-foreground/70">
            {m.historyEmpty}
          </p>

          {/* Not a CTA — there is nothing to enable, sampling is automatic. A live pulse
              answers "is this actually working?" without over-claiming a cadence. */}
          <div className="mx-auto inline-flex items-center gap-2 rounded-full bg-muted/60 px-3 py-1.5 text-xs font-medium text-muted-foreground">
            <span className="relative flex size-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/60" />
              <span className="relative inline-flex size-2 rounded-full bg-primary" />
            </span>
            {m.historyWaiting}
          </div>
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <ComposedChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
              stroke="var(--color-border)"
              interval="preserveStartEnd"
              minTickGap={40}
            />
            <YAxis
              yAxisId="cpu"
              tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
              stroke="var(--color-border)"
              tickFormatter={(v: number) => `${v}%`}
              width={44}
            />
            <YAxis
              yAxisId="mem"
              orientation="right"
              tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
              stroke="var(--color-border)"
              tickFormatter={(v: number) => formatMb(v)}
              width={60}
            />
            <Tooltip
              contentStyle={CHART_TOOLTIP_STYLE}
              labelStyle={CHART_TOOLTIP_LABEL_STYLE}
              cursor={CHART_CURSOR}
              formatter={(value: unknown, name: unknown) =>
                name === m.memory
                  ? [formatMb(Number(value)), m.memory]
                  : [`${Number(value).toFixed(1)}%`, m.cpu]
              }
            />
            {/* Memory as a filled area (a level), CPU as a line on top (a rate) —
                so the two read as different kinds of quantity rather than competing
                for the same visual weight. */}
            <Area
              yAxisId="mem"
              type="monotone"
              dataKey="mem"
              name={m.memory}
              stroke="var(--color-info)"
              fill="var(--color-info)"
              fillOpacity={0.15}
              strokeWidth={1.5}
              // `connectNulls={false}` is the point: a gap must stay a gap.
              connectNulls={false}
              isAnimationActive={false}
            />
            <Line
              yAxisId="cpu"
              type="monotone"
              dataKey="cpu"
              name={m.cpu}
              stroke="var(--color-primary)"
              strokeWidth={2}
              dot={false}
              connectNulls={false}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </Shell>
  );
};
