"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { api, getApiErrorMessage } from "@/lib/api/client";
import { UsageChart } from "./UsageChart";
import { useI18n, interpolate } from "@/components/i18n-provider";
import type { BillingState } from "@/lib/api/billing";
import { billingUsageWindow, formatBillingNumber, weeklyCreditUsage, type CloudUsagePayload } from "@/lib/billing-usage";
import { isNewCloudCustomer } from "@/lib/billing-presentation";
import { BillingEmptyState } from "./BillingEmptyState";

interface UsageResponse {
  data: { usage: CloudUsagePayload | null };
}

/** Credits are an authoritative total. CPU, memory, disk activity and network
 * each have their own unit; the provider does not attribute credits among them. */
export function BillingUsage({ state }: { state: BillingState }) {
  return isNewCloudCustomer(state) ? <BillingEmptyState kind="usage" /> : <BillingUsageHistory state={state} />;
}

function BillingUsageHistory({ state }: { state: BillingState }) {
  const { t, locale } = useI18n();
  const copy = t.billing.resourcesGuide;
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(() => {
    const start = state.currentPeriod.start?.slice(0, 10);
    return start && billingUsageWindow(start, today)
      ? start : new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
  });
  const [to, setTo] = useState(today);
  const [granularity, setGranularity] = useState<"day" | "week">("day");
  const [usage, setUsage] = useState<CloudUsagePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [showAccounting, setShowAccounting] = useState(false);

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
    api.get<UsageResponse>("billing/usage", { params: { ...range, groupBy: "day" } })
      .then((res) => { if (!cancelled) setUsage(res.data.usage); })
      .catch((err) => { if (!cancelled) setError(getApiErrorMessage(err, t.billing.usage.loadError)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [from, to, retry, copy.invalidRange, t.billing.usage.loadError]);

  const buckets = useMemo(() => {
    const daily = usage?.buckets ?? [];
    return granularity === "week" ? weeklyCreditUsage(daily) : daily;
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
    <div className="space-y-5">
      <div className="flex flex-col gap-4 rounded-2xl border border-border/50 bg-card p-4 xl:flex-row xl:items-center xl:justify-between">
        <p className="text-sm font-medium">{copy.allProjects}</p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="inline-flex rounded-lg border border-border/50 bg-background p-0.5" role="group" aria-label={t.billing.usage.chart.title}>
            {(["day", "week"] as const).map((value) => <button key={value} type="button"
              onClick={() => setGranularity(value)} aria-pressed={granularity === value}
              className={`rounded-md px-3 py-1.5 text-xs font-medium capitalize ${granularity === value ? "bg-muted text-foreground" : "text-muted-foreground"}`}>
              {t.billing.usage.granularity[value]}
            </button>)}
          </div>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {copy.from}
            <input type="date" value={from} max={to || today} onChange={(event) => setFrom(event.target.value)}
              className="min-w-0 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-sm text-foreground" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {copy.to}
            <input type="date" value={to} min={from} max={today} onChange={(event) => setTo(event.target.value)}
              className="min-w-0 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-sm text-foreground" />
          </label>
        </div>
      </div>

      {error && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-danger/20 bg-danger/5 p-4 text-sm">
        <p className="flex items-center gap-2 text-danger"><AlertCircle className="size-4 shrink-0" aria-hidden="true" />{error}</p>
        <button type="button" onClick={() => setRetry(value => value + 1)} className="font-medium text-primary hover:underline">{t.billing.plansRoute.tryAgain}</button>
      </div>}
      {loading && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden="true" />{t.billing.usage.breakdown.loading}</p>}

      <div className="rounded-2xl border border-border/50 bg-card p-5 sm:p-6">
        <h2 className="text-base font-semibold">{t.billing.usage.breakdown.title}</h2>
        <p className="mb-4 mt-1 text-sm leading-relaxed text-muted-foreground">{copy.usageHint}</p>
        <div className="overflow-x-auto rounded-xl border border-border/50">
          <table className="w-full text-start text-sm">
            <thead className="bg-muted/30 text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-4 py-3 text-start font-medium">{t.billing.usage.breakdown.resource}</th>
                <th scope="col" className="px-4 py-3 text-start font-medium">{t.billing.usage.breakdown.units}</th>
                <th scope="col" className="px-4 py-3 text-start font-medium">{copy.usageMeaning}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => <tr key={row.key} className="border-t border-border/50">
                <th scope="row" className="px-4 py-3 text-start font-medium">{row.label}</th>
                <td className="whitespace-nowrap px-4 py-3 tabular-nums text-foreground">
                  {loading || error || (usage && row.value === undefined) ? "—" : `${formatBillingNumber(row.value ?? 0, locale)} ${row.units}`}
                </td>
                <td className="min-w-44 px-4 py-3 text-xs leading-relaxed text-muted-foreground">{row.hint}</td>
              </tr>)}
            </tbody>
          </table>
        </div>
      </div>
      <details className="rounded-2xl border border-border/50 bg-card p-5 sm:p-6" onToggle={event => setShowAccounting(event.currentTarget.open)}>
        <summary className="cursor-pointer text-sm font-medium text-foreground">{copy.usageDetails}</summary>
        {showAccounting && <>
      <div className="mt-5">
        <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold">{t.billing.usage.chart.title}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{interpolate(copy.creditsChart, { unit: t.billing.usage.granularity[granularity] })}</p>
          </div>
          <div className="xl:text-end">
            <p className="text-xs text-muted-foreground">{copy.selectedRange}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums" aria-live="polite">
              {loading || error ? "—" : formatBillingNumber(totals?.credits ?? 0, locale)}
              <span className="ms-1.5 text-xs font-normal text-muted-foreground">{t.billing.usage.kpi.credits}</span>
            </p>
          </div>
        </div>
        <div className="min-h-[300px]">
          {loading ? <div role="status" className="flex h-[300px] items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-5 animate-spin" aria-hidden="true" />{t.billing.usage.breakdown.loading}
          </div> : error ? <div role="alert" className="flex h-[300px] flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
            <AlertCircle className="size-6" aria-hidden="true" /><p>{error}</p>
            <button type="button" onClick={() => setRetry((value) => value + 1)} className="font-medium text-primary hover:underline">{t.billing.plansRoute.tryAgain}</button>
          </div> : buckets.length === 0 ? <p className="flex h-[300px] items-center justify-center text-sm text-muted-foreground">{t.billing.usage.empty}</p>
            : <UsageChart buckets={buckets} granularity={granularity} />}
        </div>
      </div>

        </>}
      </details>
    </div>
  );
}
