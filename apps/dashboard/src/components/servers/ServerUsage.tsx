"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Icon as UiIcon } from "@repo/ui/icons";
import type { CloudWorkspaceUsage } from "@repo/contracts";
import type { CloudAllocation } from "@repo/core";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { systemApi } from "@/lib/api/system";
import { getApiErrorMessage } from "@/lib/api/client";
import { formatBillingNumber } from "@/lib/billing-usage";
import { ResourceRing } from "@/components/billing/ResourceMeter";

/** Host measurements are separate from the provider's reserved allocation. */
export function ServerUsage({
  serverId,
  resources,
  showProjects = false,
  metrics = true,
}: {
  serverId: string;
  resources?: CloudAllocation | null;
  showProjects?: boolean;
  metrics?: boolean;
}) {
  const { t, locale } = useI18n();
  const copy = t.billing.workspaces;
  const [usage, setUsage] = useState<CloudWorkspaceUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
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
  }, [serverId, attempt]);
  const number = (value: number) => formatBillingNumber(value, locale);
  const showDisk =
    usage?.projects.some((project) => project.diskMb !== null) || usage?.sharedDiskMb != null;
  const gb = (value: number | null | undefined) => (value == null ? null : value / 1024);
  const measuredMemoryMb =
    usage?.memoryUsedMb != null && usage?.memoryAvailableMb != null
      ? usage.memoryUsedMb + usage.memoryAvailableMb
      : null;
  const rows = [
    { label: copy.cpuUsage, value: usage?.cpuPercent ?? null, max: 100, unit: "%" },
    {
      label: t.billing.header.ram,
      value: gb(usage?.memoryUsedMb),
      max: gb(resources?.memoryMb ?? measuredMemoryMb),
      unit: "GB",
    },
    {
      label: copy.diskUsage,
      value: gb(usage?.diskUsedMb),
      max: gb(usage?.diskTotalMb),
      unit: "GB",
    },
  ];
  const refreshButton = (
    <Button
      variant="ghost"
      size="icon"
      disabled={loading}
      aria-label={t.billing.resourceOverview.refresh}
      onClick={() => setAttempt((value) => value + 1)}
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
              <h2 className="text-base font-medium">{copy.liveUsage}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{copy.usageHint}</p>
            </div>
            {refreshButton}
          </div>
          {error && (
            <p role="alert" className="mt-3 text-sm text-danger">
              {error}
            </p>
          )}
          {!loading && usage && !usage.available && (
            <p role="status" className="mt-3 text-sm text-muted-foreground">
              {usage.reason}
            </p>
          )}
          <div className="mt-4 grid gap-3 @min-[36rem]/workspace-usage:grid-cols-3">
            {rows.map((row) => (
              <div
                key={row.label}
                className="flex min-w-0 items-center justify-between gap-3 rounded-xl bg-muted/35 p-3.5"
              >
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">{row.label}</p>
                  {loading ? (
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
                </div>
                <ResourceRing label={row.label} used={row.value} max={row.max} />
              </div>
            ))}
          </div>
          {usage?.available && (
            <p className="mt-3 text-xs text-muted-foreground">
              {copy.measuredAt} {new Date(usage.measuredAt).toLocaleString(locale)}
            </p>
          )}
        </section>
      )}
      {showProjects && (
        <section className="rounded-2xl bg-card p-5" aria-busy={loading}>
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-base font-medium">{t.billing.resourcesGuide.projects}</h2>
              {showDisk && (
                <p className="mt-1 text-xs text-muted-foreground">{copy.projectDiskHint}</p>
              )}
            </div>
            {!metrics && refreshButton}
          </div>
          {!metrics && error && (
            <p role="alert" className="mt-3 text-sm text-danger">
              {error}
            </p>
          )}
          <div className="mt-4 space-y-2">
            {loading ? (
              [0, 1].map((key) => (
                <div key={key} className="h-12 animate-pulse rounded-xl bg-muted/40" />
              ))
            ) : usage ? (
              <>
                {usage.projects.map((project) => (
                  <Link
                    key={project.id}
                    href={`/projects/${encodeURIComponent(project.id)}`}
                    className="flex min-w-0 items-center justify-between gap-4 rounded-xl bg-muted/30 px-4 py-3 text-sm hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    <span className="truncate font-medium">{project.name}</span>
                    <span className="flex shrink-0 items-center gap-3 tabular-nums text-muted-foreground">
                      {showDisk &&
                        (project.diskMb == null ? "—" : `${number(project.diskMb / 1024)} GB`)}
                      <UiIcon name="arrow-up-right" className="size-3.5" aria-hidden />
                    </span>
                  </Link>
                ))}
                {usage.projects.length === 0 && (
                  <div className="rounded-xl bg-muted/30 p-4">
                    <p className="text-sm text-muted-foreground">{copy.noProjects}</p>
                    <Button asChild variant="secondary" size="sm" className="mt-3">
                      <Link href="/library">
                        {t.dashboard.pages.projects.emptyState.createProject}
                      </Link>
                    </Button>
                  </div>
                )}
                {usage.sharedDiskMb != null && (
                  <div className="flex justify-between gap-4 px-4 py-2 text-xs text-muted-foreground">
                    <span>{copy.sharedDisk}</span>
                    <span className="shrink-0 whitespace-nowrap tabular-nums">
                      {number(usage.sharedDiskMb / 1024)} GB
                    </span>
                  </div>
                )}
              </>
            ) : (
              <p className="py-2 text-sm text-muted-foreground">
                {t.billing.resourceOverview.unavailable}
              </p>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
