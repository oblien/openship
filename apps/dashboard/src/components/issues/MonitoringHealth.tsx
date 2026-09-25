"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bar, BarChart, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import {
  getApiErrorMessage,
  issuesApi,
  jobsApi,
  type CurrentHealthScanResult,
  type WorkloadHealthRow,
} from "@/lib/api";
import { timeAgo } from "@/lib/time";
import { useI18n } from "@/components/i18n-provider";
import { CHART_TOOLTIP_STYLE } from "@/lib/chart-theme";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";
import { getActiveOrganizationId } from "@/lib/api/client";
import type { MonitoringHealthSnapshot } from "@/lib/api/issues";
import { AutomaticMonitoringCard } from "./AutomaticMonitoringCard";

const tone = {
  healthy: { Icon: "check-circle", className: "text-success bg-success-bg", label: "Healthy" },
  unhealthy: { Icon: "warning", className: "text-warning bg-warning-bg", label: "Unhealthy" },
  crash_loop: { Icon: "warning", className: "text-danger bg-danger-bg", label: "Crash loop" },
  down: { Icon: "server-off", className: "text-danger bg-danger-bg", label: "Down" },
  unknown: { Icon: "help-circle", className: "text-muted-foreground bg-muted", label: "Unknown" },
} as const;

/** Fleet health reads a cached snapshot produced by the server-grouped watcher.
 * Polling this view is therefore O(rows returned), never O(Docker connections). */
export function MonitoringHealth() {
  const { t } = useI18n();
  const { toast } = useToast();
  const [rows, setRows] = useState<WorkloadHealthRow[]>([]);
  const [watching, setWatching] = useState<boolean | null>(null);
  const [watcher, setWatcher] = useState<MonitoringHealthSnapshot["watcher"] | null>(null);
  const [capabilities, setCapabilities] = useState<MonitoringHealthSnapshot["capabilities"] | null>(null);
  const [currentScan, setCurrentScan] = useState<CurrentHealthScanResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [enableError, setEnableError] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [enabling, setEnabling] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [filter, setFilter] = useState<"all" | "problems">("all");
  const [query, setQuery] = useState("");
  const mounted = useRef(false);
  const pendingRead = useRef<Promise<void> | null>(null);

  const load = useCallback((afterChange = false): Promise<void> => {
    // A mutation needs a read started AFTER it completed; ordinary polls share
    // an in-flight request instead of adding overlapping snapshot requests.
    if (pendingRead.current) {
      return afterChange ? pendingRead.current.then(() => load(true)) : pendingRead.current;
    }
    const organizationId = getActiveOrganizationId();
    const current = () => mounted.current && organizationId === getActiveOrganizationId();
    const request = (async () => {
      try {
        const result = await issuesApi.health();
        if (!current()) return;
        setRows(result.data ?? []);
        setWatching(result.watching);
        setWatcher(result.watcher);
        setCapabilities(result.capabilities);
        setCurrentScan(result.currentScan);
        setLoadError(null);
      } catch (err) {
        if (current()) setLoadError(getApiErrorMessage(err, "Could not load the latest health snapshot."));
      } finally {
        if (current()) setLoading(false);
      }
    })();
    pendingRead.current = request;
    void request.finally(() => { if (pendingRead.current === request) pendingRead.current = null; });
    return request;
  }, []);

  useEffect(() => {
    mounted.current = true;
    const refresh = () => { if (document.visibilityState !== "hidden") void load(); };
    refresh();
    const timer = setInterval(refresh, 15_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [load]);

  const toggleWatching = async () => {
    if (enabling || !watcher?.canManage) return;
    const enabled = !watching;
    setEnabling(true);
    setEnableError(null);
    try {
      await jobsApi.update(watcher.key, { enabled });
      await load(true);
      if (!mounted.current) return;
      toast(
        "success",
        enabled
          ? "Automatic monitoring enabled."
          : "Automatic monitoring disabled.",
        "Container health",
      );
    } catch (err) {
      if (!mounted.current) return;
      const message = getApiErrorMessage(err, "Could not change automatic monitoring.");
      setEnableError(message);
      toast("error", message, "Container health");
    } finally {
      if (mounted.current) setEnabling(false);
    }
  };

  const checkHealthNow = async () => {
    if (scanning) return;
    setScanning(true);
    setScanError(null);
    const organizationId = getActiveOrganizationId();
    const current = () => mounted.current && organizationId === getActiveOrganizationId();
    try {
      const result = await issuesApi.scanHealth();
      if (!current()) return;
      setCurrentScan(result.data);
      await load(true);
      if (!current()) return;
      const partial = hasPartialCoverage(result.data);
      toast(
        partial ? "info" : "success",
        partial
          ? "The current check finished with partial coverage. See the details below."
          : "Every discovered workload was checked.",
        "Container health",
      );
    } catch (err) {
      if (!current()) return;
      const message = getApiErrorMessage(err, "Could not check container health.");
      setScanError(message);
      toast("error", message, "Container health");
    } finally {
      if (current()) setScanning(false);
    }
  };

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (filter === "problems" && row.state === "healthy") return false;
      return !q || `${row.projectName} ${row.serviceName} ${row.serverName}`.toLowerCase().includes(q);
    });
  }, [rows, filter, query]);
  const problems = rows.filter((row) => row.state !== "healthy" && row.state !== "unknown").length;
  const metrics = useMemo(() => {
    const counts = { healthy: 0, unhealthy: 0, crash_loop: 0, down: 0, unknown: 0 };
    for (const row of rows) counts[row.state]++;
    const score = rows.length ? Math.round((counts.healthy / rows.length) * 100) : 0;
    const servers = new Map<string, typeof counts>();
    for (const row of rows) {
      const current = servers.get(row.serverName) ?? { healthy: 0, unhealthy: 0, crash_loop: 0, down: 0, unknown: 0 };
      current[row.state]++;
      servers.set(row.serverName, current);
    }
    return {
      counts,
      score,
      serverRows: [...servers].map(([name, values]) => ({ name, ...values })),
    };
  }, [rows]);

  const currentAvailable = capabilities?.current ?? false;
  const newestObservation = rows.reduce<string | null>((latest, row) => {
    if (!latest || new Date(row.observedAt).getTime() > new Date(latest).getTime()) {
      return row.observedAt;
    }
    return latest;
  }, null);
  // A newer automatic observation supersedes coverage from an old manual check.
  const latestManualScan = currentScan && (!newestObservation || currentScan.completedAt >= newestObservation)
    ? currentScan : null;
  const lastCheckedAt = latestManualScan?.completedAt ?? newestObservation;
  const partialCoverage = metrics.counts.unknown > 0 || (latestManualScan ? hasPartialCoverage(latestManualScan) : false);
  let summary = `${rows.length} services watched · ${problems} need attention`;
  if (loading) summary = "Loading the latest fleet snapshot…";
  else if (scanning) summary = "Checking every deployed container…";
  else if (loadError || watching === null) summary = "Could not refresh health. Any rows below are the last known observations.";
  else if (rows.length === 0 && currentScan && partialCoverage) summary = "Check complete · coverage was partial";
  else if (rows.length === 0 && currentScan) summary = "Check complete · no container workloads found";
  else if (rows.length === 0) summary = "Run a check to see what’s healthy right now";
  else if (lastCheckedAt) {
    summary = `${rows.length} workloads · ${partialCoverage ? "partial coverage" : problems === 0 ? "all clear" : `${problems} need attention`} · checked ${timeAgo(lastCheckedAt, t)}`;
  }

  return (
    <div className="space-y-4">
      {!loading && watcher && watching !== null && (
        <AutomaticMonitoringCard
          watcher={watcher}
          watching={watching}
          busy={enabling}
          disabled={scanning}
          error={enableError}
          onToggle={() => void toggleWatching()}
        />
      )}

      <div className="flex flex-col gap-3 rounded-2xl border border-border/50 bg-card p-5 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className={`flex size-10 items-center justify-center rounded-xl ${partialCoverage ? "bg-warning-bg text-warning" : problems > 0 ? "bg-danger-bg text-danger" : rows.length > 0 ? "bg-success-bg text-success" : "bg-primary/10 text-primary"}`}>
            <UiIcon name="activity" className="size-[19px]" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[15px] font-semibold">Container health</h2>
              {!loading && (
                <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${scanning ? "bg-primary/10 text-primary" : partialCoverage ? "bg-warning-bg text-warning" : problems > 0 ? "bg-danger-bg text-danger" : rows.length > 0 ? "bg-success-bg text-success" : "bg-muted text-muted-foreground"}`}>
                  {loadError ? "Unavailable" : scanning ? "Checking" : partialCoverage ? "Partial" : problems > 0 ? `${problems} problems` : rows.length > 0 ? "Healthy at last check" : "Not checked"}
                </span>
              )}
              {!loading && currentAvailable && (
                <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {watching ? "Automatic" : "On demand"}
                </span>
              )}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground" aria-live="polite">{summary}</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {!loading && currentAvailable && (
            <Button variant="outline" onClick={() => void checkHealthNow()} disabled={scanning || enabling}>
              <UiIcon name="refresh" className={scanning ? "animate-spin" : ""} />
              {scanning ? "Checking…" : "Check now"}
            </Button>
          )}
        </div>
      </div>

      {scanError && (
        <div role="alert" className="flex items-start gap-2.5 rounded-xl border border-danger-border bg-danger-bg px-4 py-3 text-sm text-danger">
          <UiIcon name="warning" className="mt-0.5 size-4 shrink-0" />
          <div><p className="font-medium">Current health check failed</p><p className="mt-0.5 text-xs text-danger/80">{scanError}</p></div>
        </div>
      )}

      {latestManualScan && hasPartialCoverage(latestManualScan) && (
        <div className="flex items-start gap-2.5 rounded-xl border border-warning-border bg-warning-bg px-4 py-3 text-warning">
          <UiIcon name="help-circle" className="mt-0.5 size-4 shrink-0" />
          <div>
            <p className="text-sm font-medium">Current check completed with partial coverage</p>
            <p className="mt-0.5 text-xs leading-relaxed">
              {coverageText(latestManualScan)}. Unknown workloads are shown as unknown.
            </p>
          </div>
        </div>
      )}

      {loadError && (
        <div role="alert" className="flex flex-col gap-3 rounded-xl border border-danger-border bg-danger-bg px-4 py-3 sm:flex-row sm:items-center">
          <div className="flex min-w-0 flex-1 items-start gap-2.5">
            <UiIcon name="warning" className="mt-0.5 size-4 shrink-0 text-danger" />
            <div>
              <p className="text-sm font-medium text-danger">Health data is temporarily unavailable</p>
              <p className="mt-0.5 text-xs text-danger/80">{loadError}</p>
            </div>
          </div>
          <button type="button" onClick={() => void load(true)} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-danger-border px-3 py-1.5 text-xs font-medium text-danger transition-colors hover:bg-danger/10">
            <UiIcon name="refresh" className="size-3.5" /> Retry
          </button>
        </div>
      )}

      {!loading && rows.length > 0 && (
        <>
          <div className="grid gap-4 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.35fr)]">
            <div className="rounded-2xl border border-border/50 bg-card p-5">
              <div className="mb-2">
                <h3 className="text-[14px] font-semibold text-foreground">Fleet health</h3>
                <p className="text-xs text-muted-foreground">
                  {latestManualScan
                    ? `Current state checked ${timeAgo(latestManualScan.completedAt, t)}`
                    : watching === false
                      ? "Last recorded state before monitoring was paused"
                      : "Latest state from continuous monitoring"}
                </p>
              </div>
              <div className="grid grid-cols-[180px_1fr] items-center gap-3">
                <div className="relative h-[180px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={statusSlices(metrics.counts)} dataKey="value" nameKey="label" innerRadius="67%" outerRadius="88%" paddingAngle={2} stroke="var(--color-card)" strokeWidth={3} isAnimationActive={false}>
                        {statusSlices(metrics.counts).map((slice) => <Cell key={slice.key} fill={slice.color} />)}
                      </Pie>
                      <Tooltip contentStyle={CHART_TOOLTIP_STYLE} formatter={(value: unknown, name: unknown) => [Number(value), String(name)]} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center"><span className={`text-3xl font-semibold tabular-nums ${metrics.score === 100 ? "text-success" : metrics.score >= 90 ? "text-warning" : "text-danger"}`}>{metrics.score}%</span><span className="text-[11px] text-muted-foreground">healthy</span></div>
                </div>
                <div className="space-y-2.5">{statusSlices(metrics.counts).map((slice) => <div key={slice.key} className="flex items-center gap-2 text-xs"><span className="size-2 rounded-full" style={{ backgroundColor: slice.color }} /><span className="flex-1 text-muted-foreground">{slice.label}</span><span className="font-medium tabular-nums text-foreground">{slice.value}</span></div>)}</div>
              </div>
            </div>

            <div className="rounded-2xl border border-border/50 bg-card p-5">
              <div className="mb-3 flex items-end justify-between gap-3"><div><h3 className="text-[14px] font-semibold text-foreground">Health by server</h3><p className="text-xs text-muted-foreground">Current distribution of workload states across hosts</p></div><span className="text-xs tabular-nums text-muted-foreground">{metrics.serverRows.length} servers</span></div>
              <div style={{ height: Math.max(190, metrics.serverRows.length * 42) }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={metrics.serverRows} layout="vertical" margin={{ top: 4, right: 8, bottom: 4, left: 8 }} barCategoryGap="28%">
                    <XAxis type="number" hide allowDecimals={false} />
                    <YAxis type="category" dataKey="name" width={105} tick={{ fill: "var(--color-muted-foreground)", fontSize: 11 }} tickLine={false} axisLine={false} />
                    <Tooltip contentStyle={CHART_TOOLTIP_STYLE} cursor={{ fill: "var(--color-muted)" }} />
                    <Bar dataKey="healthy" name="Healthy" stackId="health" fill="var(--color-success-solid)" radius={[4, 0, 0, 4]} isAnimationActive={false} />
                    <Bar dataKey="unhealthy" name="Unhealthy" stackId="health" fill="var(--color-warning-solid)" isAnimationActive={false} />
                    <Bar dataKey="crash_loop" name="Crash loop" stackId="health" fill="var(--color-danger-solid)" isAnimationActive={false} />
                    <Bar dataKey="down" name="Down" stackId="health" fill="var(--color-danger)" isAnimationActive={false} />
                    <Bar dataKey="unknown" name="Unknown" stackId="health" fill="var(--color-muted-foreground)" radius={[0, 4, 4, 0]} isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            {statusSlices(metrics.counts).map((slice) => <button key={slice.key} type="button" onClick={() => setFilter(slice.key === "healthy" ? "all" : "problems")} className="rounded-xl border border-border/50 bg-card px-4 py-3 text-start transition-colors hover:bg-muted/30"><div className="mb-2 size-2 rounded-full" style={{ backgroundColor: slice.color }} /><p className="text-2xl font-semibold tabular-nums text-foreground">{slice.value}</p><p className="text-xs text-muted-foreground">{slice.label}</p></button>)}
          </div>
        </>
      )}

      {!loading && rows.length > 0 && (
        <div className="flex flex-col gap-2 sm:flex-row">
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search services, projects or servers" className="h-10 flex-1 rounded-xl border border-border/50 bg-card px-4 text-sm outline-none focus:ring-2 focus:ring-primary/20" />
          <div className="inline-flex rounded-xl bg-muted/35 p-1">
            {(["all", "problems"] as const).map((value) => <button key={value} onClick={() => setFilter(value)} className={`h-8 rounded-lg px-3 text-xs font-medium ${filter === value ? "border border-border/60 bg-card" : "text-muted-foreground"}`}>{value === "all" ? "All services" : "Needs attention"}</button>)}
          </div>
        </div>
      )}

      <div className="overflow-hidden rounded-2xl border border-border/50 bg-card">
        {loading ? <p className="p-8 text-center text-sm text-muted-foreground">Loading health snapshot…</p> : visible.length > 0 ? (
          <ul className="divide-y divide-border/50">{visible.map((row) => {
            const status = tone[row.state]; const Icon = status.Icon;
            return <li key={`${row.projectId}:${row.serviceKey}`} className="flex items-center gap-3 px-4 py-3">
              <span className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${status.className}`}><UiIcon name={Icon} className="size-4" /></span>
              <div className="min-w-0 flex-1"><Link href={`/projects/${row.projectId}/health`} className="text-sm font-medium hover:underline">{row.serviceName}</Link><p className="truncate text-xs text-muted-foreground">{row.projectName} · {row.serverName}</p></div>
              <div className="text-end"><p className={`text-xs font-medium ${status.className.split(" ")[0]}`}>{status.label}</p><p className="text-[11px] text-muted-foreground">{timeAgo(row.observedAt, t)}</p></div>
            </li>;
          })}</ul>
        ) : rows.length === 0 ? <HealthEmptyState watching={watching} currentScan={currentScan} /> : <p className="p-8 text-center text-sm text-muted-foreground">No services match this filter.</p>}
      </div>
    </div>
  );
}

function HealthEmptyState({
  watching,
  currentScan,
}: {
  watching: boolean | null;
  currentScan: CurrentHealthScanResult | null;
}) {
  const incomplete = currentScan ? hasPartialCoverage(currentScan) : false;
  const title = incomplete
    ? "Some workloads could not be checked"
    : currentScan
      ? "No deployed container workloads found"
      : watching
        ? "Waiting for the first fleet snapshot"
        : "No health check yet";
  const description = incomplete
    ? "The current check had partial coverage. Review the warning above, then retry when the affected hosts are reachable."
    : currentScan
      ? "The current check completed successfully, but this organization has no eligible deployed containers to inspect."
      : watching
        ? "Continuous monitoring is active. Service states will appear after the next reconciliation sweep, or you can check now."
        : "Run a check to see the live state of every deployed container.";

  return (
    <div className="flex flex-col items-center px-6 py-10 text-center">
      <div className={`flex size-11 items-center justify-center rounded-2xl ${watching ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}>
        <UiIcon name="activity" className="size-5" />
      </div>
      <p className="mt-3 text-sm font-medium text-foreground">{title}</p>
      <p className="mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">
        {description}
      </p>
    </div>
  );
}

function hasPartialCoverage(scan: CurrentHealthScanResult): boolean {
  const { unreachable, unresolved, skipped, errors, indeterminate } = scan.summary;
  return unreachable + unresolved + skipped + errors + indeterminate > 0;
}

function coverageText(scan: CurrentHealthScanResult): string {
  const parts: string[] = [];
  const { unreachable, unresolved, skipped, errors, indeterminate } = scan.summary;
  if (unreachable) parts.push(`${unreachable} ${unreachable === 1 ? "host was" : "hosts were"} unreachable`);
  if (unresolved) parts.push(`${unresolved} ${unresolved === 1 ? "project has" : "projects have"} an unresolved target`);
  if (indeterminate) parts.push(`${indeterminate} ${indeterminate === 1 ? "workload is" : "workloads are"} unknown`);
  if (skipped) parts.push(`${skipped} ${skipped === 1 ? "deep inspection was" : "deep inspections were"} skipped`);
  if (errors) parts.push(`${errors} ${errors === 1 ? "check failed" : "checks failed"}`);
  return parts.join(" · ");
}

function statusSlices(counts: Record<WorkloadHealthRow["state"], number>) {
  return [
    { key: "healthy" as const, label: "Healthy", value: counts.healthy, color: "var(--color-success-solid)" },
    { key: "unhealthy" as const, label: "Unhealthy", value: counts.unhealthy, color: "var(--color-warning-solid)" },
    { key: "crash_loop" as const, label: "Crash loop", value: counts.crash_loop, color: "var(--color-danger-solid)" },
    { key: "down" as const, label: "Down", value: counts.down, color: "var(--color-danger)" },
    { key: "unknown" as const, label: "Unknown", value: counts.unknown, color: "var(--color-muted-foreground)" },
  ];
}
