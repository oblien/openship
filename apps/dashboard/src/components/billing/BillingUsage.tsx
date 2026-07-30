"use client";

import React, { useEffect, useMemo, useState } from "react";
import { Loader2, ArrowDownUp, ChevronDown, AlertCircle } from "lucide-react";
import { api } from "@/lib/api/client";
import { UsageChart } from "./UsageChart";
import { BillingCapacity } from "./BillingCapacity";
import { useI18n, interpolate } from "@/components/i18n-provider";
import type { BillingState } from "@/lib/api/billing";
import type { Dictionary } from "@/i18n";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

/**
 * Mirror of Oblien's `NamespaceUsageUnitBucket`. Kept inline so the
 * dashboard isn't forced to import from the Oblien SDK directly.
 */
interface UsageBucket {
  timestamp: string;
  cpu_time_minutes: number;
  memory_gb_minutes: number;
  disk_io_gb: number;
  network_gb: number;
  vcpu_hours: number;
  gb_hours: number;
  credits: number;
  records: number;
}

interface UsageTotals {
  cpu_time_minutes: number;
  memory_gb_minutes: number;
  disk_io_gb: number;
  network_gb: number;
  vcpu_hours: number;
  gb_hours: number;
  credits: number;
  records: number;
}

interface UsagePayload {
  namespace: string;
  range: { from: string; to: string };
  group_by: "hour" | "day";
  buckets: UsageBucket[];
  totals: UsageTotals;
}

interface UsageResponse {
  data: {
    from: string;
    to: string;
    groupBy: "hour" | "day";
    usage: UsagePayload | null;
  };
}

type Granularity = "day" | "week";

interface BillingUsageProps {
  state: BillingState;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function toDate(value: Date | string | null): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toIsoDateInput(d: Date): string {
  // YYYY-MM-DD for <input type="date">. Use UTC slice to avoid TZ drift
  // when re-parsing back into a Date for the API call.
  return d.toISOString().slice(0, 10);
}

function startOfTodayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function formatCredits(milli: number): string {
  // Oblien charges in milli-credits; display whole credits with up to 2
  // decimals for small fractional usage.
  const credits = milli / 1000;
  if (credits === 0) return "0";
  if (credits >= 100) return Math.round(credits).toLocaleString();
  return credits.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatNumber(value: number, fractionDigits = 2): string {
  if (value === 0) return "0";
  if (Math.abs(value) >= 100) return Math.round(value).toLocaleString();
  return value.toLocaleString(undefined, { maximumFractionDigits: fractionDigits });
}

/**
 * Aggregate raw daily buckets into weekly buckets (ISO week, Mon-start).
 * Oblien only emits "hour" or "day"; we collapse client-side for the
 * weekly view so we don't double-fetch.
 */
function bucketsToWeekly(buckets: UsageBucket[]): UsageBucket[] {
  if (buckets.length === 0) return [];
  const byWeek = new Map<string, UsageBucket>();
  for (const b of buckets) {
    const ts = new Date(b.timestamp);
    if (Number.isNaN(ts.getTime())) continue;
    // Week key: Monday-of-week ISO date string.
    const day = ts.getUTCDay(); // 0=Sun ... 6=Sat
    const mondayOffset = (day + 6) % 7;
    const monday = new Date(ts);
    monday.setUTCDate(ts.getUTCDate() - mondayOffset);
    monday.setUTCHours(0, 0, 0, 0);
    const key = monday.toISOString();

    const existing = byWeek.get(key);
    if (existing) {
      existing.cpu_time_minutes += b.cpu_time_minutes;
      existing.memory_gb_minutes += b.memory_gb_minutes;
      existing.disk_io_gb += b.disk_io_gb;
      existing.network_gb += b.network_gb;
      existing.vcpu_hours += b.vcpu_hours;
      existing.gb_hours += b.gb_hours;
      existing.credits += b.credits;
      existing.records += b.records;
    } else {
      byWeek.set(key, { ...b, timestamp: key });
    }
  }
  return Array.from(byWeek.values()).sort((a, b) =>
    a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0,
  );
}

/**
 * Compute average credits/day over the last N days of buckets (using the
 * raw daily buckets, regardless of the selected display granularity).
 */
function computeBurnRate(buckets: UsageBucket[], lastNDays = 7): number {
  if (buckets.length === 0) return 0;
  const sorted = [...buckets].sort((a, b) =>
    a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0,
  );
  const tail = sorted.slice(-lastNDays);
  if (tail.length === 0) return 0;
  const sum = tail.reduce((acc, b) => acc + b.credits, 0);
  return sum / tail.length;
}

/**
 * Linear extrapolation: current usage + burnRate * daysRemaining in the
 * current billing period. Returns null when we can't bracket the period.
 */
function projectedUsage(
  quotaUsed: number,
  burnRate: number,
  periodEnd: Date | null,
): number | null {
  if (!periodEnd) return null;
  const now = new Date();
  const msRemaining = periodEnd.getTime() - now.getTime();
  if (msRemaining <= 0) return quotaUsed;
  const daysRemaining = Math.max(0, Math.ceil(msRemaining / ONE_DAY_MS));
  return quotaUsed + burnRate * daysRemaining;
}

/* ------------------------------------------------------------------ */
/*  Resource breakdown rows                                            */
/* ------------------------------------------------------------------ */

interface BreakdownRow {
  key: string;
  label: string;
  units: string;
  unitsValue: number;
  credits: number;
}

/**
 * Oblien's bucket totals are denominated in raw metered units, not
 * credits — Oblien doesn't surface a per-resource credit attribution.
 * We display the metered units and a proportional share of total
 * credits so the table still rolls up to the period spend.
 */
function buildBreakdownRows(
  totals: UsageTotals | null,
  resources: Dictionary["billing"]["usage"]["resources"],
): BreakdownRow[] {
  if (!totals) return [];

  // Use a proxy weight so each row gets a slice of the total credit
  // spend. The weights are intentionally rough — they are only used to
  // distribute a single attributable "credits" number across resources
  // for display. Sum of weights does not have to match credits 1:1; we
  // normalise below.
  const rawRows: Array<{ key: keyof typeof resources; unitsValue: number; weight: number }> = [
    { key: "cpu", unitsValue: totals.vcpu_hours, weight: totals.vcpu_hours },
    { key: "memory", unitsValue: totals.gb_hours, weight: totals.gb_hours },
    { key: "disk", unitsValue: totals.disk_io_gb, weight: totals.disk_io_gb },
    { key: "network", unitsValue: totals.network_gb, weight: totals.network_gb },
  ];

  const totalWeight = rawRows.reduce((acc, r) => acc + r.weight, 0);
  const totalCredits = totals.credits;

  return rawRows.map((r) => ({
    key: r.key,
    label: resources[r.key].label,
    units: resources[r.key].units,
    unitsValue: r.unitsValue,
    credits: totalWeight > 0 ? (r.weight / totalWeight) * totalCredits : 0,
  }));
}

/* ------------------------------------------------------------------ */
/*  Component                                                         */
/* ------------------------------------------------------------------ */

export const BillingUsage: React.FC<BillingUsageProps> = ({ state }) => {
  const { t } = useI18n();
  /* --- Date range (default → current billing period) -------------- */
  const periodStart = toDate(state.currentPeriod.start);
  const periodEnd = toDate(state.currentPeriod.end);

  const defaultFrom = useMemo(() => {
    return periodStart ?? new Date(startOfTodayUtc().getTime() - 30 * ONE_DAY_MS);
  }, [periodStart]);
  const defaultTo = useMemo(() => {
    return periodEnd ?? startOfTodayUtc();
  }, [periodEnd]);

  const [from, setFrom] = useState<Date>(defaultFrom);
  const [to, setTo] = useState<Date>(defaultTo);
  const [granularity, setGranularity] = useState<Granularity>("day");

  const [usage, setUsage] = useState<UsagePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  /* --- Fetch usage on mount + when filters change ----------------- */
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    async function load() {
      try {
        // Oblien only supports `hour | day` bucket granularity. We
        // always ask for `day` and aggregate to weeks client-side.
        const res = await api.get<UsageResponse>("billing/usage", {
          params: {
            from: from.toISOString(),
            to: to.toISOString(),
            groupBy: "day",
          },
        });
        if (!cancelled) setUsage(res.data.usage);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : t.billing.usage.loadError);
          setUsage(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [from, to]);

  /* --- Derived view models --------------------------------------- */
  const rawBuckets = usage?.buckets ?? [];
  const displayBuckets = useMemo(
    () => (granularity === "week" ? bucketsToWeekly(rawBuckets) : rawBuckets),
    [rawBuckets, granularity],
  );

  const burnRate = useMemo(() => computeBurnRate(rawBuckets, 7), [rawBuckets]);
  const projection = useMemo(
    () => projectedUsage(state.balance.quotaUsed, burnRate, periodEnd),
    [state.balance.quotaUsed, burnRate, periodEnd],
  );

  const breakdownRows = useMemo(() => {
    const rows = buildBreakdownRows(usage?.totals ?? null, t.billing.usage.resources);
    rows.sort((a, b) => (sortDir === "desc" ? b.credits - a.credits : a.credits - b.credits));
    return rows;
  }, [usage, sortDir, t]);

  const totalCredits = usage?.totals.credits ?? 0;

  /* --- Date range handlers --------------------------------------- */
  const onFromChange = (value: string) => {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) setFrom(d);
  };
  const onToChange = (value: string) => {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) setTo(d);
  };

  return (
    <div className="space-y-6">
      {/* ── Toolbar ─────────────────────────────────────────────── */}
      <UsageToolbar
        granularity={granularity}
        onGranularityChange={setGranularity}
        from={from}
        to={to}
        onFromChange={onFromChange}
        onToChange={onToChange}
      />

      {/* ── KPI strip ───────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label={t.billing.usage.kpi.balance}
          value={formatCredits(state.balance.quotaRemaining)}
          suffix={interpolate(t.billing.usage.kpi.balanceSuffix, { limit: formatCredits(state.balance.quotaLimit) })}
        />
        <KpiCard
          label={t.billing.usage.kpi.consumed}
          value={formatCredits(state.balance.quotaUsed)}
          suffix={t.billing.usage.kpi.credits}
        />
        <KpiCard
          label={t.billing.usage.kpi.burnRate}
          value={formatCredits(burnRate)}
          suffix={t.billing.usage.kpi.burnRateSuffix}
        />
        <KpiCard
          label={t.billing.usage.kpi.projected}
          value={projection === null ? "—" : formatCredits(projection)}
          suffix={projection === null ? t.billing.usage.kpi.noPeriod : t.billing.usage.kpi.credits}
        />
      </div>

      {/* ── Capacity & usage (free routes + resource ceilings) ──── */}
      <BillingCapacity state={state} />

      {/* ── Chart ───────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-border/50 bg-card p-6">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-foreground">{t.billing.usage.chart.title}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {interpolate(t.billing.usage.chart.subtitle, { unit: t.billing.usage.granularity[granularity] })}
            </p>
          </div>
        </div>
        <div className="min-h-[360px]">
          {loading ? (
            <ChartLoadingState />
          ) : error ? (
            <ChartErrorState message={error} />
          ) : displayBuckets.length === 0 ? (
            <ChartEmptyState />
          ) : (
            <div className="h-[360px] w-full">
              <UsageChart buckets={displayBuckets} granularity={granularity} />
            </div>
          )}
        </div>
      </div>

      {/* ── Breakdown table ─────────────────────────────────────── */}
      <div className="rounded-2xl border border-border/50 bg-card p-6">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-foreground">{t.billing.usage.breakdown.title}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t.billing.usage.breakdown.subtitle}
            </p>
          </div>
        </div>
        <div className="overflow-hidden rounded-xl border border-border/50">
          <table className="w-full text-sm">
            <thead className="bg-muted/30">
              <tr className="text-start text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3 font-medium">{t.billing.usage.breakdown.resource}</th>
                <th className="px-4 py-3 font-medium">{t.billing.usage.breakdown.units}</th>
                <th className="px-4 py-3 font-medium">
                  <button
                    type="button"
                    onClick={() => setSortDir((d) => (d === "desc" ? "asc" : "desc"))}
                    className="inline-flex items-center gap-1 font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {t.billing.usage.breakdown.credits}
                    <ArrowDownUp className="size-3" />
                  </button>
                </th>
                <th className="px-4 py-3 text-end font-medium">{t.billing.usage.breakdown.percentOfTotal}</th>
              </tr>
            </thead>
            <tbody>
              {breakdownRows.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-sm text-muted-foreground">
                    {loading ? t.billing.usage.breakdown.loading : t.billing.usage.breakdown.empty}
                  </td>
                </tr>
              ) : (
                breakdownRows.map((row) => {
                  const pct = totalCredits > 0 ? (row.credits / totalCredits) * 100 : 0;
                  return (
                    <tr key={row.key} className="border-t border-border/50">
                      <td className="px-4 py-3 font-medium text-foreground">{row.label}</td>
                      <td className="px-4 py-3 tabular-nums text-muted-foreground">
                        {formatNumber(row.unitsValue)} {row.units}
                      </td>
                      <td className="px-4 py-3 tabular-nums text-foreground">
                        {formatCredits(row.credits)}
                      </td>
                      <td className="px-4 py-3 text-end tabular-nums text-muted-foreground">
                        {pct.toFixed(1)}%
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/*  Subcomponents                                                     */
/* ------------------------------------------------------------------ */

interface UsageToolbarProps {
  granularity: Granularity;
  onGranularityChange: (value: Granularity) => void;
  from: Date;
  to: Date;
  onFromChange: (value: string) => void;
  onToChange: (value: string) => void;
}

function UsageToolbar({
  granularity,
  onGranularityChange,
  from,
  to,
  onFromChange,
  onToChange,
}: UsageToolbarProps) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-border/50 bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
      {/* Workspace filter — disabled stub for v1.0 */}
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t.billing.usage.toolbar.workspace}
        </span>
        <button
          type="button"
          disabled
          title={t.billing.usage.toolbar.workspaceTooltip}
          className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-lg border border-border/50 bg-muted/30 px-3 py-1.5 text-sm font-medium text-muted-foreground opacity-70"
        >
          {t.billing.usage.toolbar.allWorkspaces}
          <ChevronDown className="size-3.5" />
        </button>
      </div>

      {/* Granularity + date range */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex items-center rounded-lg border border-border/50 bg-background p-0.5">
          {(["day", "week"] as const).map((opt) => {
            const active = granularity === opt;
            return (
              <button
                key={opt}
                type="button"
                onClick={() => onGranularityChange(opt)}
                className={`rounded-md px-3 py-1 text-xs font-medium capitalize transition-colors ${
                  active
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {t.billing.usage.granularity[opt]}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2 text-sm">
          <input
            type="date"
            value={toIsoDateInput(from)}
            onChange={(e) => onFromChange(e.target.value)}
            className="rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <span className="text-muted-foreground">{t.billing.usage.toolbar.to}</span>
          <input
            type="date"
            value={toIsoDateInput(to)}
            onChange={(e) => onToChange(e.target.value)}
            className="rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
      </div>
    </div>
  );
}

interface KpiCardProps {
  label: string;
  value: string;
  suffix?: string;
}

function KpiCard({ label, value, suffix }: KpiCardProps) {
  return (
    <div className="rounded-2xl border border-border/50 bg-card p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-semibold tabular-nums text-foreground">{value}</p>
      {suffix && <p className="mt-1 text-xs text-muted-foreground">{suffix}</p>}
    </div>
  );
}

function ChartLoadingState() {
  return (
    <div className="flex h-[360px] w-full items-center justify-center">
      <Loader2 className="size-6 animate-spin text-muted-foreground" />
    </div>
  );
}

function ChartErrorState({ message }: { message: string }) {
  return (
    <div className="flex h-[360px] w-full items-center justify-center">
      <div className="flex flex-col items-center gap-2 text-center">
        <AlertCircle className="size-5 text-danger" />
        <p className="text-sm text-muted-foreground">{message}</p>
      </div>
    </div>
  );
}

function ChartEmptyState() {
  const { t } = useI18n();
  return (
    <div className="flex h-[360px] w-full items-center justify-center rounded-xl border border-dashed border-border/60 bg-muted/20">
      <p className="text-sm text-muted-foreground">{t.billing.usage.empty}</p>
    </div>
  );
}

export default BillingUsage;
