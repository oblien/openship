"use client";

import { Icon as UiIcon } from "@repo/ui/icons";
import React, { useId, useMemo, useState } from "react";
import {
  Area, Bar, ComposedChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { useI18n } from "@/components/i18n-provider";
import type { AnalyticsData } from "@/hooks/useProjectEndpoints";
import { CHART_CURSOR, CHART_TOOLTIP_LABEL_STYLE, CHART_TOOLTIP_STYLE } from "@/lib/chart-theme";
import { buildTrafficSeries } from "./traffic-series";

interface Props {
  trafficData: AnalyticsData["trafficByHour"];
  isLoading: boolean;
  totalRequests?: number;
  scopeLabel?: string;
  compact?: boolean;
}

/** Overview and Monitoring render the same timestamped hourly request buckets. */
export const TrafficChart: React.FC<Props> = ({
  trafficData, isLoading, totalRequests, scopeLabel, compact = false,
}) => {
  const { t, locale } = useI18n();
  const labels = t.projectDetail.general.traffic;
  const [chartType, setChartType] = useState<"bar" | "area">("area");
  const gradientId = useId();
  const data = useMemo(() => buildTrafficSeries(trafficData), [trafficData]);
  const timeFormat = useMemo(() => new Intl.DateTimeFormat(locale, {
    hour: "2-digit", minute: "2-digit",
  }), [locale]);
  const dateFormat = useMemo(() => new Intl.DateTimeFormat(locale, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  }), [locale]);
  const first = data[0];
  const last = data.at(-1);
  const range = first && last ? `${dateFormat.format(first.from)} – ${dateFormat.format(last.to)}` : undefined;
  const tickStep = first && last ? Math.max(1, Math.ceil((last.to - first.from) / 3_600_000 / 4)) * 3_600_000 : 0;
  const ticks: number[] = [];
  if (first && last) {
    ticks.push(first.from);
    for (let time = Math.ceil(first.from / tickStep) * tickStep; time < last.to; time += tickStep) {
      if (time > first.from) ticks.push(time);
    }
    ticks.push(last.to);
  }
  const detail = [
    scopeLabel,
    range,
    typeof totalRequests === "number" ? `${totalRequests.toLocaleString(locale)} ${t.projects.monitoring.requests}` : null,
  ].filter(Boolean).join(" · ");

  return (
    <section className={`rounded-2xl bg-card ${compact ? "px-4 py-3.5" : "p-4 sm:p-5"}`}>
      <div className="mb-2.5 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2" title={detail}>
          <UiIcon name="chart-bar" className="size-3.5 shrink-0 text-primary" />
          <h3 className="truncate text-sm font-medium text-foreground">
            {compact ? t.projects.overview.traffic : labels.title}
          </h3>
          <span className="hidden text-xs text-muted-foreground sm:inline">{labels.last24Hours}</span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5 rounded-lg bg-muted/50 p-0.5">
          {(["area", "bar"] as const).map((type) => (
            <button
              key={type}
              type="button"
              aria-pressed={chartType === type}
              onClick={() => setChartType(type)}
              className={`rounded-md px-2.5 py-1 text-xs transition-colors ${chartType === type
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground"}`}
            >
              {labels[type]}
            </button>
          ))}
        </div>
      </div>
      {isLoading ? (
        <div className={compact ? "h-[140px]" : "h-[220px]"} role="status">
          <span className="sr-only">{labels.loading}</span>
          <div aria-hidden="true" className="flex h-full items-end gap-[3px] px-1 pb-5">
            {Array.from({ length: 32 }, (_, i) => (
              <div
                key={i}
                className="flex-1 rounded-sm bg-muted-foreground/15 animate-pulse motion-reduce:animate-none"
                style={{
                  height: `${18 + Math.abs(Math.sin(i * 0.7)) * 70}%`,
                  animationDelay: `${i * 40}ms`,
                }}
              />
            ))}
          </div>
        </div>
      ) : !first || !last ? (
        <div className={`flex items-center justify-center text-center ${compact ? "h-[140px]" : "h-[220px]"}`}>
          <div>
            <p className="text-xs text-muted-foreground">{labels.noDataTitle}</p>
            {!compact && <p className="mt-1 text-xs text-muted-foreground">{labels.noDataBody}</p>}
          </div>
        </div>
      ) : (
        <div className="min-w-0" aria-label={`${labels.title}: ${range}`}>
          <ResponsiveContainer width="100%" height={compact ? 140 : 220}>
            <ComposedChart data={data} margin={{ top: 4, right: 4, left: 4, bottom: 0 }} accessibilityLayer>
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--color-primary)" stopOpacity={0.25} />
                  <stop offset="100%" stopColor="var(--color-primary)" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <XAxis
                dataKey="timestamp"
                type="number"
                scale="time"
                domain={[first.from, last.to]}
                ticks={ticks}
                tickFormatter={(value: number) => timeFormat.format(value)}
                tick={{ fontSize: "var(--text-xs)", fill: "var(--color-muted-foreground)" }}
                height={20}
                tickLine={false}
                axisLine={false}
                minTickGap={32}
                interval="preserveStartEnd"
              />
              <YAxis
                hide
                domain={[0, "auto"]}
              />
              <Tooltip
                contentStyle={{ ...CHART_TOOLTIP_STYLE, fontSize: "var(--text-xs)" }}
                labelStyle={CHART_TOOLTIP_LABEL_STYLE}
                cursor={CHART_CURSOR}
                labelFormatter={(_label, payload) => {
                  const point = payload[0]?.payload;
                  if (!point) return "";
                  const currentHour = Math.floor(point.from / 3_600_000) === Math.floor(Date.now() / 3_600_000);
                  return `${dateFormat.format(point.from)} – ${timeFormat.format(point.to)}` +
                    (currentHour ? ` · ${t.projects.monitoring.currentHour}` : "");
                }}
                formatter={(value) => [Number(value).toLocaleString(locale), t.projects.monitoring.requests]}
              />
              {chartType === "bar" ? (
                <Bar
                  dataKey="requests"
                  fill="var(--color-primary)"
                  fillOpacity={0.7}
                  maxBarSize={28}
                  radius={[3, 3, 0, 0]}
                  isAnimationActive={false}
                />
              ) : (
                <Area
                  dataKey="requests"
                  type="linear"
                  stroke="var(--color-primary)"
                  fill={`url(#${gradientId})`}
                  strokeWidth={2}
                  dot={data.length === 1}
                  activeDot={{ r: 3 }}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
};
