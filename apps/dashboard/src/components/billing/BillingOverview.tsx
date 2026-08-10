"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Loader2, Sparkles } from "lucide-react";
import { Area, AreaChart, ResponsiveContainer } from "recharts";
import { PLANS } from "@repo/core";
import { api } from "@/lib/api/client";
import { useI18n, interpolate } from "@/components/i18n-provider";
import type { BillingState } from "@/lib/api/billing";

export type { BillingState };

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

/**
 * Legacy compatibility — older callers (and the mock data layer) still
 * import `BillingData`. The two shapes diverged when we switched to the
 * credits model; keep the alias so the file's named exports stay stable
 * while the rest of the dashboard migrates.
 */
export type BillingData = BillingState;

interface BillingOverviewProps {
  state: BillingState;
}

interface UsageBucket {
  timestamp: string;
  credits: number;
}

interface UsageResponse {
  data: {
    from: string;
    to: string;
    groupBy: "hour" | "day";
    usage: { buckets: UsageBucket[] } | null;
  };
}

interface TopupPack {
  id: string;
  name: string;
  credits_milli: number;
  price_cents: number;
  stripePriceId: string;
  sortOrder: number;
}

interface TopupPacksResponse {
  data: TopupPack[];
}

interface TopupCheckoutResponse {
  data: { checkoutUrl: string };
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function formatCredits(milliCredits: number): string {
  const credits = Math.floor(milliCredits / 1000);
  return credits.toLocaleString();
}

function formatDollars(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

function pctUsed(used: number, limit: number): number {
  if (limit <= 0) return 0;
  return Math.min(100, Math.max(0, (used / limit) * 100));
}

function ringStrokeClass(pct: number): string {
  if (pct >= 90) return "text-danger";
  if (pct >= 75) return "text-warning";
  return "text-primary";
}

function daysUntil(end: Date | string | null): number | null {
  if (!end) return null;
  const endMs = typeof end === "string" ? Date.parse(end) : end.getTime();
  if (Number.isNaN(endMs)) return null;
  const diff = endMs - Date.now();
  if (diff <= 0) return null;
  return Math.ceil(diff / (24 * 60 * 60 * 1000));
}

function statusPillClass(status: string): string {
  const s = status.toLowerCase();
  if (s === "active") return "bg-success-bg text-success border-success-border";
  if (s === "past_due" || s === "unpaid") return "bg-danger-bg text-danger border-danger-border";
  if (s === "canceled" || s === "cancelled") return "bg-muted text-muted-foreground border-border";
  return "bg-muted text-muted-foreground border-border";
}

/* ------------------------------------------------------------------ */
/*  Ring gauge                                                        */
/* ------------------------------------------------------------------ */

/**
 * Circular usage indicator. Built with SVG so it scales cleanly and
 * doesn't pull in a chart library for one shape. Stroke color comes
 * from the parent via `currentColor`; pass the right text-color class
 * (text-primary / text-warning / text-danger) based on threshold.
 */
function RingGauge({
  pct,
  size = 168,
  stroke = 14,
  children,
}: {
  pct: number;
  size?: number;
  stroke?: number;
  children?: React.ReactNode;
}) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - Math.min(100, Math.max(0, pct)) / 100);
  return (
    <div
      className="relative shrink-0"
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {/* Track */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          className="stroke-muted"
          strokeWidth={stroke}
        />
        {/* Progress */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: "stroke-dashoffset 600ms ease" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        {children}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Upgrade button (kept exported — used elsewhere)                   */
/* ------------------------------------------------------------------ */

export function UpgradeButton({ children, onClick, className = "" }: {
  children: React.ReactNode;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`group relative inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-medium text-primary-foreground transition-all ${className}`}
    >
      <span className="pointer-events-none absolute -inset-[1px] rounded-xl bg-gradient-to-r from-primary via-blue-500 to-violet-500 opacity-40 blur-[1px] transition-opacity group-hover:opacity-60" />
      <span className="absolute inset-0 rounded-xl bg-gradient-to-r from-primary to-primary/90" />
      <span className="relative flex items-center gap-1.5">{children}</span>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Hero — ring on left, plan summary on right                        */
/* ------------------------------------------------------------------ */

function BalanceHero({ state }: { state: BillingState }) {
  const { t } = useI18n();
  const { quotaLimit, quotaUsed, quotaRemaining } = state.balance;
  const pct = pctUsed(quotaUsed, quotaLimit);
  const days = daysUntil(state.currentPeriod.end);
  const ringTone = ringStrokeClass(pct);

  return (
    <div className="rounded-2xl border border-border/50 bg-card p-6">
      <div className="flex flex-col items-center gap-7 sm:flex-row sm:items-center sm:gap-8">
        {/* Ring */}
        <div className={ringTone}>
          <RingGauge pct={pct}>
            <span className="text-2xl font-semibold tabular-nums tracking-tight text-foreground">
              {formatCredits(quotaRemaining)}
            </span>
            <span className="mt-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {t.billing.overview.creditsLeft}
            </span>
          </RingGauge>
        </div>

        {/* Usage metrics (plan identity lives in PlanCard above) */}
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="grid grid-cols-2 gap-4 sm:max-w-md">
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {t.billing.overview.usedThisPeriod}
              </p>
              <p className="mt-1 text-sm font-semibold tabular-nums text-foreground">
                {formatCredits(quotaUsed)}
                <span className="ms-1 text-xs font-normal text-muted-foreground">
                  / {formatCredits(quotaLimit)}
                </span>
              </p>
            </div>
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {t.billing.overview.resets}
              </p>
              <p className="mt-1 text-sm font-semibold text-foreground">
                {days !== null
                  ? interpolate(
                      days === 1 ? t.billing.overview.resetsInDay : t.billing.overview.resetsInDays,
                      { n: String(days) },
                    )
                  : t.billing.overview.none}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Recent-activity sparkline                                          */
/* ------------------------------------------------------------------ */

function RecentActivityCard() {
  const { t } = useI18n();
  const [buckets, setBuckets] = useState<UsageBucket[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const to = new Date();
        const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
        const qs = new URLSearchParams({
          from: from.toISOString(),
          to: to.toISOString(),
          groupBy: "day",
        });
        const res = await api.get<UsageResponse>(`billing/usage?${qs.toString()}`);
        if (cancelled) return;
        setBuckets(res.data.usage?.buckets ?? []);
      } catch {
        if (!cancelled) setError(t.billing.overview.usageError);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const data = (buckets ?? []).map((b) => ({
    timestamp: b.timestamp,
    credits: Math.max(0, b.credits / 1000),
  }));

  return (
    <div className="rounded-2xl border border-border/50 bg-card p-6">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{t.billing.overview.recentActivity}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{t.billing.overview.last7Days}</p>
        </div>
        <Link
          href="/billing/usage"
          className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
        >
          {t.billing.overview.viewFullUsage}
          <ArrowUpRight className="size-3" />
        </Link>
      </div>

      <div className="h-20">
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            {error}
          </div>
        ) : data.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            {t.billing.overview.noUsageYet}
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="var(--primary)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <Area
                type="monotone"
                dataKey="credits"
                stroke="var(--primary)"
                strokeWidth={1.75}
                fill="url(#sparkFill)"
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Quick-buy credit packs                                            */
/* ------------------------------------------------------------------ */

function BuyCreditsCard({ available }: { available: boolean }) {
  const { t } = useI18n();
  const [packs, setPacks] = useState<TopupPack[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [buyingPackId, setBuyingPackId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await api.get<TopupPacksResponse>("billing/topup-packs");
        if (cancelled) return;
        const sorted = [...res.data].sort((a, b) => a.sortOrder - b.sortOrder);
        setPacks(sorted.slice(0, 2));
      } catch {
        if (!cancelled) setError(t.billing.overview.packsError);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleBuy(packId: string) {
    setBuyingPackId(packId);
    try {
      const res = await api.post<TopupCheckoutResponse>("billing/topup", { packId });
      window.location.href = res.data.checkoutUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : t.billing.overview.checkoutError);
      setBuyingPackId(null);
    }
  }

  // Buy is enabled ONLY when Openship Cloud reports top-ups available; otherwise
  // packs render as a dimmed "coming soon" preview.
  return (
    <div className="rounded-2xl border border-border/50 bg-card p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-foreground">{t.billing.overview.needMoreCredits}</h3>
            {!available && (
              <span className="inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                {t.billing.pricing.comingSoon}
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t.billing.overview.oneTimeTopups}
          </p>
        </div>
        <Link
          href="/billing/topups"
          className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
        >
          {t.billing.overview.seeAllPacks}
          <ArrowUpRight className="size-3" />
        </Link>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-6">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        </div>
      ) : error ? (
        <p className="py-4 text-xs text-muted-foreground">{error}</p>
      ) : !packs || packs.length === 0 ? (
        <p className="py-4 text-xs text-muted-foreground">{t.billing.overview.noPacks}</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {packs.map((pack) => {
            const body = (
              <>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-foreground">
                    {interpolate(t.billing.overview.creditsAmount, { n: formatCredits(pack.credits_milli) })}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {interpolate(t.billing.overview.oneTime, { price: formatDollars(pack.price_cents) })}
                  </p>
                </div>
                <span
                  className={`ms-3 inline-flex shrink-0 items-center gap-1 ${
                    available
                      ? "text-xs font-medium text-primary"
                      : "rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
                  }`}
                >
                  {available ? (
                    buyingPackId === pack.id ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <>
                        {t.billing.overview.buy}
                        <ArrowUpRight className="size-3 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                      </>
                    )
                  ) : (
                    t.billing.pricing.comingSoon
                  )}
                </span>
              </>
            );
            return available ? (
              <button
                key={pack.id}
                onClick={() => handleBuy(pack.id)}
                disabled={buyingPackId !== null}
                className="group flex items-center justify-between rounded-xl border border-border/60 bg-background/40 px-4 py-3 text-start transition-colors hover:border-primary/40 hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {body}
              </button>
            ) : (
              <div
                key={pack.id}
                className="flex items-center justify-between rounded-xl border border-border/60 bg-background/40 px-4 py-3 opacity-70"
              >
                {body}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Plan card — the primary surface (subscription first)               */
/* ------------------------------------------------------------------ */

/**
 * Subscription-first lead card: the tier the org is on, its status, the
 * included monthly credit (CPU-time) allowance + feature chips, and the
 * upgrade / manage entry point. Credits balance is the secondary card below —
 * general credits exist but aren't the first thing the user sees.
 */
function PlanCard({ state }: { state: BillingState }) {
  const { t } = useI18n();
  const plan = PLANS[state.tier];
  const planName = plan?.name ?? state.tier;
  const isFree = state.tier === "free";
  const allowance = state.monthlyCreditLimit;
  const features = plan?.features ?? [];

  return (
    <div className="rounded-2xl border border-border/50 bg-card p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold text-foreground">
              {interpolate(t.billing.overview.planLabel, { name: planName })}
            </h2>
            <span
              className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize ${statusPillClass(state.status)}`}
            >
              {state.status.replace(/_/g, " ")}
            </span>
          </div>
          {plan?.description && (
            <p className="mt-1 text-sm text-muted-foreground">{plan.description}</p>
          )}
        </div>

        {isFree ? (
          <Link
            href="/billing/plans"
            className="relative inline-flex w-fit items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            <span className="pointer-events-none absolute -inset-[1px] rounded-xl bg-gradient-to-r from-primary via-blue-500 to-violet-500 opacity-40 blur-[1px] transition-opacity hover:opacity-60" />
            <span className="absolute inset-0 rounded-xl bg-gradient-to-r from-primary to-primary/90" />
            <span className="relative flex items-center gap-1.5">
              <Sparkles className="size-3.5" />
              {t.billing.overview.upgradeToPro}
            </span>
          </Link>
        ) : (
          <Link
            href="/billing/plans"
            className="inline-flex items-center gap-1 rounded-lg border border-border/60 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted/40"
          >
            {t.billing.tabs.plans}
            <ArrowUpRight className="size-3" />
          </Link>
        )}
      </div>

      {(allowance != null || features.length > 0) && (
        <div className="mt-4 flex flex-wrap gap-2">
          {allowance != null && (
            <span className="inline-flex items-center rounded-lg bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
              {interpolate(t.billing.overview.creditsAmount, { n: formatCredits(allowance) })}
            </span>
          )}
          {features.map((f) => (
            <span
              key={f}
              className="inline-flex items-center rounded-lg bg-muted px-2.5 py-1 text-xs text-muted-foreground"
            >
              {f}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Component                                                         */
/* ------------------------------------------------------------------ */

export const BillingOverview: React.FC<BillingOverviewProps> = ({ state }) => {
  return (
    <div className="flex flex-col gap-5">
      {/* Subscription/tier leads; credits balance is secondary. */}
      <PlanCard state={state} />
      <BalanceHero state={state} />
      <RecentActivityCard />
      <BuyCreditsCard available={state.topups?.available === true} />
    </div>
  );
};
