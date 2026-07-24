"use client";

import React, { useCallback, useEffect, useState } from "react";
import {
  Activity,
  ArrowUpDown,
  ChevronDown,
  Gauge,
  Loader2,
  Plus,
  Server,
  Trash2,
  Users,
} from "lucide-react";
import { TrafficChart, TopPaths, StatsCards } from "./general";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { useAnalyticsData } from "@/hooks/useProjectEndpoints";
import { useToast } from "@/context/ToastContext";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { SlidingToggle } from "@/components/ui/SlidingToggle";
import {
  monitorsApi,
  getApiErrorMessage,
  type Monitor,
  type MonitorCheck,
  type MonitorIncident,
  type MonitorStatus,
} from "@/lib/api";

const STATUS_DOT: Record<MonitorStatus, string> = {
  up: "bg-success-solid",
  down: "bg-danger-solid",
  unknown: "bg-muted-foreground",
};

const INTERVAL_VALUES = [30, 60, 300, 900] as const;

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

const ResponseTimeChart = ({ monitor, checks }: { monitor: Monitor; checks: MonitorCheck[] }) => {
  const ordered = [...checks].sort(
    (a, b) => new Date(a.checkedAt).getTime() - new Date(b.checkedAt).getTime(),
  );
  const points = ordered.map((c) => c.responseMs ?? 0);
  const maxMs = Math.max(...points, 1);
  const areaPoints = points.length === 1 ? [points[0], points[0]] : points;
  const gradientId = `monitorGradient-${monitor.id}`;
  const labels = ordered
    .filter((_, i) => i % Math.max(1, Math.ceil(ordered.length / 6)) === 0)
    .map((c) =>
      new Date(c.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    );

  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{maxMs} ms</span>
        <span>0 ms</span>
      </div>
      <div className="relative h-24">
        <svg
          className="absolute inset-0 h-full w-full text-primary"
          viewBox="0 0 1000 200"
          preserveAspectRatio="none"
          style={{ color: "hsl(var(--primary))" }}
        >
          <defs>
            <linearGradient id={gradientId} x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="20%" stopColor="currentColor" stopOpacity="0.4" />
              <stop offset="100%" stopColor="currentColor" stopOpacity="0.05" />
            </linearGradient>
          </defs>
          <path
            d={`M 0 200 ${areaPoints
              .map((ms, i) => {
                const x = areaPoints.length === 1 ? 500 : (i / (areaPoints.length - 1)) * 1000;
                const y = 200 - (ms / maxMs) * 180;
                return `L ${x} ${y}`;
              })
              .join(" ")} L 1000 200 Z`}
            fill={`url(#${gradientId})`}
          />
          <path
            d={areaPoints
              .map((ms, i) => {
                const x = areaPoints.length === 1 ? 500 : (i / (areaPoints.length - 1)) * 1000;
                const y = 200 - (ms / maxMs) * 180;
                return `${i === 0 ? "M" : "L"} ${x} ${y}`;
              })
              .join(" ")}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          />
        </svg>
      </div>
      <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground">
        {labels.map((label, i) => (
          <span key={i}>{label}</span>
        ))}
      </div>
    </div>
  );
};

const MonitorDetails = ({ projectId, monitor }: { projectId: string; monitor: Monitor }) => {
  const { t } = useI18n();
  const w = t.projects.monitoring;
  const [checks, setChecks] = useState<MonitorCheck[] | null>(null);
  const [incidents, setIncidents] = useState<MonitorIncident[] | null>(null);

  // Re-keyed on lastCheckedAt so the expanded view refreshes with the 30s poll.
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      monitorsApi.listChecks(projectId, monitor.id, 24),
      monitorsApi.listIncidents(projectId, monitor.id),
    ])
      .then(([checksRes, incidentsRes]) => {
        if (cancelled) return;
        setChecks(checksRes.data ?? []);
        setIncidents(incidentsRes.data ?? []);
      })
      .catch(() => {
        if (cancelled) return;
        setChecks([]);
        setIncidents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, monitor.id, monitor.lastCheckedAt]);

  if (checks === null || incidents === null) {
    return (
      <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> {w.loading}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="mb-2 text-[13px] font-medium text-foreground">{w.responseTime}</p>
        {checks.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">{w.noChecks}</p>
        ) : (
          <ResponseTimeChart monitor={monitor} checks={checks} />
        )}
      </div>
      <div>
        <p className="mb-2 text-[13px] font-medium text-foreground">{w.incidents}</p>
        {incidents.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">{w.noIncidents}</p>
        ) : (
          <div className="space-y-2">
            {incidents.map((incident) => (
              <div
                key={incident.id}
                className="flex items-center gap-3 rounded-lg border border-border/50 bg-background px-3 py-2"
              >
                <span className="text-[13px] text-foreground">
                  {new Date(incident.startedAt).toLocaleString()}
                </span>
                <span
                  className={`shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium ${
                    incident.resolvedAt
                      ? "bg-muted text-muted-foreground"
                      : "bg-danger-bg text-danger"
                  }`}
                >
                  {incident.resolvedAt
                    ? formatDuration(
                        new Date(incident.resolvedAt).getTime() -
                          new Date(incident.startedAt).getTime(),
                      )
                    : w.ongoing}
                </span>
                {incident.error && (
                  <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">
                    {incident.error}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

const UptimeMonitors = () => {
  const { id } = useProjectSettings();
  const { showToast } = useToast();
  const { t } = useI18n();
  const w = t.projects.monitoring;

  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // New-monitor form
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [intervalSeconds, setIntervalSeconds] = useState("60");

  const load = useCallback(
    async (silent = false) => {
      if (!id) return;
      if (!silent) setLoading(true);
      try {
        const res = await monitorsApi.list(id);
        setMonitors(res.data ?? []);
      } catch (err) {
        if (!silent) showToast(getApiErrorMessage(err, w.loadFailed), "error", w.toastTitle);
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [id, showToast, w.loadFailed, w.toastTitle],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const iv = setInterval(() => void load(true), 30_000);
    return () => clearInterval(iv);
  }, [load]);

  const canAdd = () => name.trim().length > 0 && /^https?:\/\//i.test(url.trim());

  const handleAdd = async () => {
    if (!id || saving || !canAdd()) return;
    setSaving(true);
    try {
      await monitorsApi.create(id, {
        name: name.trim(),
        url: url.trim(),
        intervalSeconds: Number(intervalSeconds),
      });
      setName("");
      setUrl("");
      setIntervalSeconds("60");
      await load();
      showToast(w.created, "success", w.toastTitle);
    } catch (err) {
      showToast(getApiErrorMessage(err, w.saveFailed), "error", w.toastTitle);
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (monitor: Monitor, enabled: boolean) => {
    if (monitor.enabled === enabled) return;
    setBusyId(monitor.id);
    try {
      await monitorsApi.update(id, monitor.id, { enabled });
      await load(true);
    } catch (err) {
      showToast(getApiErrorMessage(err, w.saveFailed), "error", w.toastTitle);
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (monitor: Monitor) => {
    setBusyId(monitor.id);
    try {
      await monitorsApi.delete(id, monitor.id);
      if (expandedId === monitor.id) setExpandedId(null);
      await load();
      showToast(w.deleted, "success", w.toastTitle);
    } catch (err) {
      showToast(getApiErrorMessage(err, w.deleteFailed), "error", w.toastTitle);
    } finally {
      setBusyId(null);
    }
  };

  const statusLabel: Record<MonitorStatus, string> = {
    up: w.statusUp,
    down: w.statusDown,
    unknown: w.statusUnknown,
  };

  const intervalLabels: Record<(typeof INTERVAL_VALUES)[number], string> = {
    30: w.interval30s,
    60: w.interval1m,
    300: w.interval5m,
    900: w.interval15m,
  };

  return (
    <div className="rounded-2xl border border-border/50 bg-card">
      <div className="flex items-center gap-3 px-5 py-4">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary ring-1 ring-inset ring-primary/15">
          <Activity className="size-[18px]" />
        </div>
        <div>
          <h3 className="text-[14px] font-semibold text-foreground">{w.uptimeTitle}</h3>
          <p className="mt-0.5 text-[12px] text-muted-foreground">{w.uptimeDescription}</p>
        </div>
      </div>

      <div className="space-y-4 border-t border-border/40 px-5 py-4">
        {loading ? (
          <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> {w.loading}
          </div>
        ) : monitors.length === 0 ? (
          <p className="py-1 text-[13px] text-muted-foreground">{w.empty}</p>
        ) : (
          <div className="space-y-2">
            {monitors.map((monitor) => {
              const expanded = expandedId === monitor.id;
              return (
                <div key={monitor.id} className="rounded-xl border border-border/50 bg-muted/20">
                  <div className="flex items-center gap-3 px-4 py-3">
                    <button
                      type="button"
                      onClick={() => setExpandedId(expanded ? null : monitor.id)}
                      aria-expanded={expanded}
                      aria-label={w.detailsAria}
                      className="flex min-w-0 flex-1 items-center gap-3 text-start"
                    >
                      <span
                        title={statusLabel[monitor.status]}
                        className={`size-2.5 shrink-0 rounded-full ${STATUS_DOT[monitor.status] || STATUS_DOT.unknown}`}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium text-foreground">
                          {monitor.name}
                        </span>
                        <span className="block truncate text-[12px] text-muted-foreground">
                          {monitor.url}
                        </span>
                      </span>
                      <span className="hidden shrink-0 text-end sm:block">
                        {monitor.uptime24h != null && (
                          <span className="block text-[12px] text-foreground">
                            {interpolate(w.uptime24h, { pct: monitor.uptime24h.toFixed(2) })}
                          </span>
                        )}
                        {monitor.lastResponseMs != null && (
                          <span className="block text-[12px] text-muted-foreground">
                            {interpolate(w.lastResponse, { ms: String(monitor.lastResponseMs) })}
                          </span>
                        )}
                      </span>
                      <ChevronDown
                        className={`size-4 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`}
                      />
                    </button>
                    <SlidingToggle
                      options={[
                        { value: "on", label: w.enabled },
                        { value: "off", label: w.disabled },
                      ]}
                      value={monitor.enabled ? "on" : "off"}
                      onChange={(value) => handleToggle(monitor, value === "on")}
                      variant="rounded"
                      selectedBg="bg-primary"
                      selectedTextColor="text-primary-foreground"
                      unselectedTextColor="text-muted-foreground"
                      backgroundColor="bg-card"
                      size="sm"
                      className="shrink-0"
                    />
                    <button
                      type="button"
                      onClick={() => handleDelete(monitor)}
                      disabled={busyId === monitor.id}
                      className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:opacity-40"
                    >
                      {busyId === monitor.id ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="size-3.5" />
                      )}
                      {w.remove}
                    </button>
                  </div>
                  {expanded && (
                    <div className="border-t border-border/40 px-4 py-3">
                      <MonitorDetails projectId={id} monitor={monitor} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Add monitor */}
        <div className="rounded-xl border border-dashed border-border/60 p-4">
          <p className="mb-3 text-[13px] font-medium text-foreground">{w.addTitle}</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={w.nameLabel}>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={w.namePlaceholder}
                className={inputCls}
              />
            </Field>
            <Field label={w.urlLabel}>
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder={w.urlPlaceholder}
                className={inputCls}
              />
            </Field>
            <Field label={w.intervalLabel}>
              <select
                value={intervalSeconds}
                onChange={(e) => setIntervalSeconds(e.target.value)}
                className={inputCls}
              >
                {INTERVAL_VALUES.map((value) => (
                  <option key={value} value={value}>
                    {intervalLabels[value]}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <button
            type="button"
            onClick={handleAdd}
            disabled={saving || !canAdd()}
            className="mt-4 inline-flex h-9 items-center gap-1.5 rounded-xl bg-primary px-4 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
            {w.add}
          </button>
        </div>
      </div>
    </div>
  );
};

const inputCls =
  "h-9 w-full rounded-lg border border-border/50 bg-background px-3 text-[13px] text-foreground outline-none focus:border-primary/50";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12px] text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

export const MonitoringTab = () => {
  const { id, selectedDomain } = useProjectSettings();
  const { t } = useI18n();
  // Atomic analytics fetch — own state, own loading, no context coupling.
  // The hook backs onto the same module-level caches as OverviewTab so
  // both tabs share one network request per endpoint.
  const { data: analyticsData, isLoading: isLoadingAnalytics } = useAnalyticsData(
    id,
    selectedDomain,
  );
  const hasAnalytics = !!analyticsData;

  const formatNumber = (num: number): string => {
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return num?.toString() || "0";
  };

  const stats = analyticsData
    ? [
        {
          label: t.projects.stats.serverRequests,
          value: formatNumber(analyticsData.summary?.uniqueRequests),
          icon: <Server className="size-4" />,
          subtext: interpolate(t.projects.stats.requestsSubtext, {
            total: formatNumber(analyticsData.summary?.totalRequests),
            avg: String(analyticsData.summary?.avgRequestsPerHour),
          }),
        },
        {
          label: t.projects.stats.uniqueIPs,
          value: formatNumber(analyticsData.summary?.uniqueIPs),
          icon: <Users className="size-4" />,
          subtext: interpolate(t.projects.stats.uniqueIPsSubtext, {
            pct: String(analyticsData.summary?.uniqueIPsPercentage),
          }),
        },
        {
          label: t.projects.stats.avgResponse,
          value: `${analyticsData.performance?.avgResponseTimeMs?.toFixed(2) || "N/A "}ms`,
          icon: <Gauge className="size-4" />,
          subtext: t.projects.stats.responseTime,
        },
        {
          label: t.projects.stats.bandwidthOut,
          value: analyticsData.bandwidth?.totalOutFormatted || "N/A",
          icon: <ArrowUpDown className="size-4" />,
          subtext: interpolate(t.projects.stats.bandwidthInSubtext, {
            value: analyticsData.bandwidth?.totalInFormatted,
          }),
        },
      ]
    : [
        {
          label: t.projects.stats.serverRequests,
          value: isLoadingAnalytics ? "..." : "0",
          icon: <Server className="size-4" />,
          subtext: isLoadingAnalytics ? t.projects.stats.loading : t.projects.stats.noTraffic,
        },
        {
          label: t.projects.stats.uniqueIPs,
          value: isLoadingAnalytics ? "..." : "0",
          icon: <Users className="size-4" />,
          subtext: isLoadingAnalytics ? t.projects.stats.loading : t.projects.stats.noVisitors,
        },
        {
          label: t.projects.stats.avgResponse,
          value: isLoadingAnalytics ? "..." : "N/A",
          icon: <Gauge className="size-4" />,
          subtext: isLoadingAnalytics ? t.projects.stats.loading : t.projects.stats.waitingRequests,
        },
        {
          label: t.projects.stats.bandwidth,
          value: isLoadingAnalytics ? "..." : "0 B",
          icon: <ArrowUpDown className="size-4" />,
          subtext: isLoadingAnalytics ? t.projects.stats.loading : t.projects.stats.noTransfer,
        },
      ];

  const trafficData = analyticsData?.trafficByHour || [];
  const topPaths = analyticsData?.topPaths || [];
  const dateRange = analyticsData
    ? `${new Date(analyticsData.summary.firstRequest).toLocaleDateString()} - ${new Date(analyticsData.summary.lastRequest).toLocaleDateString()}`
    : undefined;

  return (
    <div className="space-y-5">
      <UptimeMonitors />
      {!isLoadingAnalytics && !hasAnalytics && (
        <div className="rounded-2xl border border-border/50 bg-card px-5 py-4">
          <p className="text-sm font-medium text-foreground">{t.projects.monitoring.noDataTitle}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {t.projects.monitoring.noDataDescription}
          </p>
        </div>
      )}
      <TrafficChart
        trafficData={trafficData}
        isLoading={isLoadingAnalytics}
        dateRange={dateRange}
        totalRequests={analyticsData?.summary.totalRequests}
      />
      <StatsCards stats={stats} />
      {topPaths.length > 0 && <TopPaths paths={topPaths} />}
    </div>
  );
};
