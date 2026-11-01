"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ResourceLabel } from "./ResourceMeter";
import { api, getApiErrorMessage } from "@/lib/api/client";
import { UsageChart } from "./UsageChart";
import { useI18n, interpolate } from "@/components/i18n-provider";
import type { BillingState } from "@/lib/api/billing";
import {
  billingUsageWindow,
  formatBillingNumber,
  weeklyUsage,
  type CloudUsagePayload,
} from "@/lib/billing-usage";
import { isNewCloudCustomer } from "@/lib/billing-presentation";
import { BillingEmptyState } from "./BillingEmptyState";

interface UsageResponse {
  data: { usage: CloudUsagePayload | null };
}

/** Monthly servers chart measured CPU time; saved metered plans chart credits.
 * Each physical measurement keeps its own unit. */
export function BillingUsage({ state }: { state: BillingState }) {
  return isNewCloudCustomer(state) ? (
    <BillingEmptyState kind="usage" />
  ) : (
    <BillingUsageHistory state={state} />
  );
}

function BillingUsageHistory({ state }: { state: BillingState }) {
  const { t, locale } = useI18n();
  const copy = t.billing.resourcesGuide;
  const monthly = state.compute?.billingMode === "monthly";
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(() => {
    const start = state.currentPeriod.start?.slice(0, 10);
    return start && billingUsageWindow(start, today)
      ? start
      : new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
  });
  const [to, setTo] = useState(today);
  const [granularity, setGranularity] = useState<"day" | "week">("day");
  const [usage, setUsage] = useState<CloudUsagePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setUsage(null);
    setError(null);
    const range = billingUsageWindow(from, to);
    if (!range) {
      setError(copy.invalidRange);
      setLoading(false);
      return;
    }
    setLoading(true);
    api
      .get<UsageResponse>("billing/usage", {
        params: { ...range, groupBy: "day", workspaceId: state.workspace?.id },
      })
      .then((res) => {
        if (!cancelled) setUsage(res.data.usage);
      })
      .catch((err) => {
        if (!cancelled) setError(getApiErrorMessage(err, t.billing.usage.loadError));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [state.workspace?.id, from, to, retry, copy.invalidRange, t.billing.usage.loadError]);

  const buckets = useMemo(() => {
    const daily = usage?.buckets ?? [];
    return granularity === "week" ? weeklyUsage(daily) : daily;
  }, [usage, granularity]);
  const resources = t.billing.usage.resources;
  const totals = usage?.totals;
  const rows = [
    { key: "cpu", ...resources.cpu, value: totals?.vcpu_hours, hint: copy.cpuHint },
    { key: "memory", ...resources.memory, value: totals?.gb_hours, hint: copy.memoryHint },
    { key: "disk", ...resources.disk, value: totals?.disk_io_gb, hint: copy.diskHint },
    { key: "network", ...resources.network, value: totals?.network_gb, hint: copy.networkHint },
  ];

  return (
    <section className="@container/history space-y-5 rounded-2xl bg-card p-5" aria-busy={loading}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-medium text-foreground">{t.billing.usage.chart.title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{copy.allProjects}</p>
        </div>
        <div className="grid w-full grid-cols-2 gap-2 @min-[36rem]/history:w-auto">
          <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
            {copy.from}
            <Input
              variant="filled"
              type="date"
              value={from}
              max={to || today}
              onChange={(event) => setFrom(event.target.value)}
              className="h-10 min-w-0"
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
            {copy.to}
            <Input
              variant="filled"
              type="date"
              value={to}
              min={from}
              max={today}
              onChange={(event) => setTo(event.target.value)}
              className="h-10 min-w-0"
            />
          </label>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-danger/10 p-3 text-sm"
        >
          <p className="flex min-w-0 items-center gap-2 text-danger">
            <UiIcon name="alert-circle" className="size-4 shrink-0" aria-hidden="true" />
            {error}
          </p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setRetry((value) => value + 1)}
          >
            {t.billing.plansRoute.tryAgain}
          </Button>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs text-muted-foreground">{monthly ? t.billing.resourceOverview.cpu : copy.selectedRange}</p>
          <p className="mt-1 text-xl font-medium tabular-nums text-foreground" aria-live="polite">
            {loading || error ? "—" : monthly ? totals?.vcpu_hours == null ? "—" : formatBillingNumber(totals.vcpu_hours, locale) : formatBillingNumber(totals?.credits ?? 0, locale)}
            <span className="ms-1.5 text-sm font-normal text-muted-foreground">
              {monthly ? "vCPU-h" : t.billing.usage.kpi.credits}
            </span>
          </p>
        </div>
        <div
          className="inline-flex gap-1 rounded-xl bg-muted/40 p-1"
          role="group"
          aria-label={t.billing.usage.chart.title}
        >
          {(["day", "week"] as const).map((value) => (
            <Button
              key={value}
              type="button"
              size="sm"
              variant={granularity === value ? "secondary" : "ghost"}
              className="capitalize"
              onClick={() => setGranularity(value)}
              aria-pressed={granularity === value}
            >
              {t.billing.usage.granularity[value]}
            </Button>
          ))}
        </div>
      </div>
      <div>
        {loading ? (
          <div
            role="status"
            aria-label={t.billing.usage.breakdown.loading}
            className="flex h-60 items-end gap-2 pb-5 motion-safe:animate-pulse"
          >
            {[35, 45, 40, 55, 70, 50, 60, 80, 65, 90, 70, 80].map((height, index) => (
              <div
                key={index}
                aria-hidden="true"
                style={{ height: `${height}%` }}
                className="flex-1 rounded-t-lg bg-muted/60"
              />
            ))}
          </div>
        ) : error ? (
          <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
            {t.billing.resourceOverview.unavailable}
          </div>
        ) : buckets.length === 0 ? (
          <div className="flex h-40 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
            <UiIcon name="chart-bar" className="size-6" aria-hidden="true" />
            {t.billing.usage.empty}
          </div>
        ) : (
          <UsageChart buckets={buckets} granularity={granularity} metric={monthly ? "vcpu_hours" : "credits"} />
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          {monthly ? t.billing.compute.usageIncluded : interpolate(copy.creditsChart, { unit: t.billing.usage.granularity[granularity] })}
        </p>
      </div>

      <div className="border-t border-border/40 pt-4">
        <h3 className="text-sm font-medium text-foreground">{t.billing.usage.breakdown.title}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{copy.usageHint}</p>
        <table className="mt-4 w-full text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="pb-2 text-start font-medium">
                {t.billing.usage.breakdown.resource}
              </th>
              <th scope="col" className="pb-2 text-end font-medium">
                {t.billing.usage.breakdown.units}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-t border-border/40">
                <th scope="row" className="py-3 text-start font-normal">
                  <ResourceLabel label={row.label} hint={row.hint} />
                </th>
                <td className="py-3 ps-3 text-end tabular-nums text-foreground">
                  {loading || error || (usage && row.value === undefined)
                    ? "—"
                    : formatBillingNumber(row.value ?? 0, locale)}
                  <span className="ms-1.5 text-xs text-muted-foreground">{row.units}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
