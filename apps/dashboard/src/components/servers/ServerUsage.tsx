"use client";

import { useEffect, useState } from "react";
import { useMonitorStream } from "@/hooks/useMonitorStream";
import { UsageTrend } from "@/components/resources/UsageTrend";
import { Icon as UiIcon } from "@repo/ui/icons";
import type { CloudWorkspaceUsage } from "@repo/contracts";
import type { CloudAllocation } from "@repo/core";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { systemApi } from "@/lib/api/system";
import { getApiErrorMessage } from "@/lib/api/client";
import { formatBillingNumber } from "@/lib/billing-usage";
import { ServerProjects } from "./ServerProjects";
import { ResourceRing } from "@/components/billing/ResourceMeter";

/** Host measurements are separate from the provider's reserved allocation. */
export function ServerUsage({
  serverId,
  resources,
  showProjects = false,
  metrics = true,
  projectTitle,
  refreshKey,
  resourcePool = false,
  liveEnabled = true,
  unavailableHint,
}: {
  serverId: string;
  resources?: CloudAllocation | null;
  showProjects?: boolean;
  metrics?: boolean;
  projectTitle?: string;
  refreshKey?: string | number;
  resourcePool?: boolean;
  liveEnabled?: boolean;
  unavailableHint?: string;
}) {
  const { t, locale } = useI18n();
  const copy = t.billing.workspaces;
  const [usage, setUsage] = useState<CloudWorkspaceUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const live = useMonitorStream(
    resourcePool && metrics && liveEnabled ? serverId : null,
    resourcePool && metrics && liveEnabled,
    "usage",
  );
  // Provider frames may omit a metric (notably guest disk). Keep each metric's
  // last measured sample, then fall back to the host snapshot; allocation is
  // only a denominator, never a substitute for measured consumption.
  const samples = [live.usage, ...live.history.slice().reverse(), usage]
    .filter((sample) => sample != null)
    .sort((a, b) => Date.parse(b.measuredAt) - Date.parse(a.measuredAt));
  const measured = samples[0];
  const cpuSample = samples.find((sample) => sample?.cpuPercent != null);
  const memorySample = samples.find((sample) => sample?.memoryUsedMb != null);
  const diskSample = samples.find((sample) => sample?.diskUsedMb != null);
  const resourceCopy = t.servers.resources;
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setUsage(null);
    void systemApi
      .serverUsage(serverId)
      .then((value) => {
        if (active) setUsage(value);
      })
      .catch((error) => {
        if (active) setError(getApiErrorMessage(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [serverId, attempt, refreshKey]);
  const number = (value: number) => formatBillingNumber(value, locale);
  const gb = (value: number | null | undefined) => (value == null ? null : value / 1024);
  const measuredMemoryMb =
    memorySample?.memoryUsedMb != null && memorySample?.memoryAvailableMb != null
      ? memorySample.memoryUsedMb + memorySample.memoryAvailableMb
      : null;
  const rows = [
    {
      label: copy.cpuUsage,
      value: cpuSample?.cpuPercent ?? null,
      measuredAt: cpuSample?.measuredAt,
      max: 100,
      unit: "%",
      history: live.history.map((sample) => sample.cpuPercent),
    },
    {
      label: t.billing.header.ram,
      value: gb(memorySample?.memoryUsedMb),
      measuredAt: memorySample?.measuredAt,
      max: gb(resources?.memoryMb ?? measuredMemoryMb),
      unit: "GB",
      history: live.history.map((sample) => gb(sample.memoryUsedMb)),
    },
    {
      label: copy.diskUsage,
      value: gb(diskSample?.diskUsedMb),
      measuredAt: diskSample?.measuredAt,
      max: gb(resources?.diskMb ?? diskSample?.diskTotalMb),
      unit: "GB",
      history: live.history.map((sample) => gb(sample.diskUsedMb)),
    },
  ];
  const refreshButton = (
    <Button
      variant="ghost"
      size="icon"
      disabled={loading}
      aria-label={t.billing.resourceOverview.refresh}
      onClick={() => {
        setAttempt((value) => value + 1);
        if (resourcePool && metrics && liveEnabled) live.reconnect();
      }}
    >
      <UiIcon
        name="refresh"
        className={`size-4 ${loading ? "motion-safe:animate-spin" : ""}`}
        aria-hidden
      />
    </Button>
  );
  return (
    <div className="space-y-5">
      {metrics && (
        <section className="@container/workspace-usage rounded-2xl bg-card p-5" aria-busy={loading}>
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-base font-medium">
                {resourcePool ? resourceCopy.usageTitle : copy.liveUsage}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {resourcePool ? t.servers.resources.usageHint : copy.usageHint}
              </p>
            </div>
            {resourcePool && liveEnabled ? (
              <span
                className={`flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs ${live.isConnected && !live.error ? "bg-primary/10 text-primary" : "bg-muted/50 text-muted-foreground"}`}
              >
                <span
                  className={`size-1.5 rounded-full ${live.isConnected && !live.error ? "bg-primary" : "bg-muted-foreground"}`}
                  aria-hidden
                />
                {live.paused
                  ? resourceCopy.paused
                  : live.isConnected && !live.error
                    ? resourceCopy.live
                    : live.error
                      ? resourceCopy.lastReading
                      : resourceCopy.connecting}
              </span>
            ) : !resourcePool ? (
              refreshButton
            ) : null}
          </div>
          {resourcePool && liveEnabled && live.error && (
            <div
              role="status"
              className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-muted/30 p-3"
            >
              <p className="text-xs text-muted-foreground">{resourceCopy.streamUnavailable}</p>
              <Button variant="secondary" size="sm" onClick={live.reconnect}>
                {t.billing.plansRoute.tryAgain}
              </Button>
            </div>
          )}
          {error && (
            <p role="alert" className="mt-3 text-sm text-danger">
              {error}
            </p>
          )}
          {!loading && usage && !usage.available && !live.usage && (
            <p role="status" className="mt-3 text-sm text-muted-foreground">
              {unavailableHint ?? usage.reason}
            </p>
          )}
          <div className="mt-4 grid gap-3 @min-[36rem]/workspace-usage:grid-cols-3">
            {rows.map((row) => (
              <div
                key={row.label}
                className="flex min-w-0 items-center gap-4 rounded-xl bg-muted/35 p-4 @min-[36rem]/workspace-usage:block"
              >
                <div className="flex min-w-0 flex-1 items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground">{row.label}</p>
                    {loading && !live.usage ? (
                      <div className="mt-2 h-6 w-24 max-w-full animate-pulse rounded bg-muted" />
                    ) : (
                      <p className="mt-1 text-xl font-medium tabular-nums">
                        {row.value == null ? "—" : number(row.value)}{" "}
                        <span className="text-sm font-normal text-muted-foreground">
                          {row.unit}
                          {row.max != null && row.unit !== "%"
                            ? ` / ${number(row.max)} ${row.unit}`
                            : ""}
                        </span>
                      </p>
                    )}
                    {row.measuredAt && row.measuredAt !== measured?.measuredAt && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {copy.measuredAt} {new Date(row.measuredAt).toLocaleString(locale)}
                      </p>
                    )}
                  </div>
                  <ResourceRing label={row.label} used={row.value} max={row.max} />
                </div>
                {resourcePool && (
                  <div className="w-20 shrink-0 @min-[36rem]/workspace-usage:mt-4 @min-[36rem]/workspace-usage:w-full">
                    <UsageTrend values={row.history} max={row.max ?? null} />
                  </div>
                )}
              </div>
            ))}
          </div>
          {measured && (
            <p className="mt-3 text-xs text-muted-foreground">
              {copy.measuredAt} {new Date(measured.measuredAt).toLocaleString(locale)}
            </p>
          )}
        </section>
      )}
      {showProjects && (
        <ServerProjects
          usage={usage}
          loading={loading}
          error={metrics ? null : error}
          refresh={!metrics || resourcePool ? refreshButton : undefined}
          resourcePool={resourcePool}
          title={projectTitle}
          unavailableHint={unavailableHint}
        />
      )}
    </div>
  );
}
