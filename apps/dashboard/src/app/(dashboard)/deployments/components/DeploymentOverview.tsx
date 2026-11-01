"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { DeploymentHistoryFilter, DeploymentHistorySummary } from "@repo/core";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { CHART_TOOLTIP_STYLE, CHART_TOOLTIP_LABEL_STYLE } from "@/lib/chart-theme";

interface Props {
  summary: DeploymentHistorySummary | null;
  loading: boolean;
  days: number;
  onDaysChange: (days: number) => void;
  onFilterChange: (filter: DeploymentHistoryFilter | "all") => void;
  onProjectChange: (id: string) => void;
  projects: Array<{ id: string; name: string }>;
  onRefresh: () => void;
}

export function DeploymentOverview({
  summary,
  loading,
  days,
  onDaysChange,
  onFilterChange,
  onProjectChange,
  projects,
  onRefresh,
}: Props) {
  const { t, locale } = useI18n();
  const c = t.deployments.monitoring;
  const data = loading ? null : summary;
  const completed = data ? data.success + data.failed : 0;
  const number = (value: number | undefined) =>
    value === undefined ? "—" : value.toLocaleString(locale);
  const series = [
    { key: "success", label: t.deployments.stats.success, color: "var(--color-success-solid)" },
    { key: "failed", label: t.deployments.stats.failed, color: "var(--color-danger-solid)" },
    { key: "active", label: t.deployments.stats.inProgress, color: "var(--color-warning-solid)" },
    {
      key: "canceled",
      label: t.deployments.filters.canceled,
      color: "var(--color-muted-foreground)",
    },
  ];
  const metrics = [
    { label: c.attempts, value: number(data?.total), filter: "all", detail: c.window },
    {
      label: c.successRate,
      value: completed ? `${Math.round((data!.success / completed) * 100)}%` : "—",
      filter: "success",
      detail: c.rateHint,
    },
    {
      label: t.deployments.stats.failed,
      value: number(data?.failed),
      filter: "failed",
      detail: c.failedHint,
    },
    {
      label: t.deployments.stats.inProgress,
      value: number(data?.active),
      filter: "active",
      detail: c.activeHint,
    },
  ] as const;
  return (
    <section aria-label={c.title} className="mb-6 space-y-4" aria-busy={loading}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-medium text-foreground">{c.title}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{c.scope}</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-xl bg-muted/60 p-1" role="group" aria-label={c.period}>
            {[7, 30, 90].map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={days === value}
                onClick={() => onDaysChange(value)}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium focus-visible:ring-2 focus-visible:ring-ring ${days === value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
              >
                {interpolate(c.days, { count: String(value) })}
              </button>
            ))}
          </div>
          <Button variant="secondary" size="sm" disabled={loading} onClick={onRefresh}>
            {c.refresh}
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {metrics.map((metric) => (
          <button
            key={metric.filter}
            type="button"
            disabled={!data}
            onClick={() => onFilterChange(metric.filter)}
            className="flex flex-col items-start rounded-2xl bg-card p-5 text-start transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
          >
            <span className="text-xs text-muted-foreground">{metric.label}</span>
            <span className="mt-2 block text-3xl font-medium tabular-nums text-foreground">
              {metric.value}
            </span>
            <span className="mt-2 block text-xs text-muted-foreground">{metric.detail}</span>
          </button>
        ))}
      </div>
      {!loading && !summary ? (
        <p role="status" className="rounded-2xl bg-card p-5 text-sm text-muted-foreground">
          {c.unavailable}
        </p>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
          <div className="min-w-0 rounded-2xl bg-card p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-sm font-medium">{c.trend}</h3>
              <span className="text-xs text-muted-foreground">
                {c.avgBuild}:{" "}
                {data?.avgBuildDurationMs == null
                  ? "—"
                  : `${Math.round(data.avgBuildDurationMs / 1000).toLocaleString(locale)}s`}
              </span>
            </div>
            <div className="mt-4 h-48" aria-label={c.trend}>
              {data && data.total > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.daily} accessibilityLayer>
                    <CartesianGrid
                      vertical={false}
                      stroke="var(--color-border)"
                      strokeOpacity={0.4}
                    />
                    <XAxis
                      dataKey="date"
                      tickLine={false}
                      axisLine={false}
                      minTickGap={28}
                      tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
                      tickFormatter={(date) =>
                        new Date(`${date}T00:00:00Z`).toLocaleDateString(locale, {
                          month: "short",
                          day: "numeric",
                          timeZone: "UTC",
                        })
                      }
                    />
                    <YAxis
                      allowDecimals={false}
                      tickLine={false}
                      axisLine={false}
                      width={30}
                      tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
                    />
                    <Tooltip
                      contentStyle={CHART_TOOLTIP_STYLE}
                      labelStyle={CHART_TOOLTIP_LABEL_STYLE}
                      cursor={{ fill: "var(--color-muted)", opacity: 0.3 }}
                    />
                    {series.map((item) => (
                      <Bar
                        key={item.key}
                        dataKey={item.key}
                        name={item.label}
                        stackId="outcomes"
                        fill={item.color}
                        maxBarSize={24}
                      />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  {loading ? t.deployments.header.loading : c.empty}
                </div>
              )}
            </div>
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground">
              {series.map((item) => (
                <span key={item.key} className="flex items-center gap-1.5">
                  <span className="size-2 rounded-full" style={{ background: item.color }} />
                  {item.label}
                </span>
              ))}
            </div>
          </div>
          <div className="rounded-2xl bg-card p-5">
            <h3 className="text-sm font-medium">{c.projects}</h3>
            <p className="mt-1 text-xs text-muted-foreground">{c.projectHint}</p>
            <div className="mt-3 space-y-1">
              {data?.projects.slice(0, 6).map((project) => (
                <button
                  key={project.projectId}
                  type="button"
                  onClick={() => onProjectChange(project.projectId)}
                  className="flex w-full items-center justify-between gap-3 rounded-xl px-2 py-2.5 text-start hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="truncate text-sm">
                    {projects.find((p) => p.id === project.projectId)?.name ??
                      t.deployments.card.unknownProject}
                  </span>
                  <span
                    className={`shrink-0 text-xs tabular-nums ${project.failed ? "text-danger" : "text-muted-foreground"}`}
                  >
                    {project.failed}/{project.total} {c.failedShort}
                  </span>
                </button>
              ))}
              {data?.projects.length === 0 && (
                <p className="py-4 text-sm text-muted-foreground">{c.empty}</p>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
