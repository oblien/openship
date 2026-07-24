"use client";

import React, { useEffect, useState } from "react";
import { PLANS } from "@repo/core";
import { api } from "@/lib/api/client";
import { useI18n, interpolate } from "@/components/i18n-provider";
import type { BillingState } from "@/lib/api/billing";

/**
 * Billing page header — title/subtitle plus a live resource-stats strip.
 *
 * Client component because the surrounding BillingLayout is an async server
 * component and locale is a client-runtime concern. Everything is READ from
 * Oblien (billing/state + billing/usage) except capacity ceilings (the tier's
 * oblienLimits) and build time (openship-derived — Oblien has no build meter).
 * We never manage resource actions here; this is display only.
 */

interface UsageTotals {
  cpu_time_minutes?: number;
  memory_gb_minutes?: number;
  disk_io_gb?: number;
  network_gb?: number;
  vcpu_hours?: number;
  gb_hours?: number;
}
interface UsageResponse {
  data: { usage: { totals?: UsageTotals } | null };
}

function fmtCredits(milli: number): string {
  return Math.floor(milli / 1000).toLocaleString();
}
function fmtNum(n: number | undefined, digits = 1): string {
  return (n ?? 0).toLocaleString(undefined, { maximumFractionDigits: digits });
}

function Stat({
  label,
  value,
  suffix,
  danger,
}: {
  label: string;
  value: string;
  suffix?: string;
  danger?: boolean;
}) {
  return (
    <div className="rounded-xl border border-border/50 bg-card px-4 py-3">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p
        className={`mt-1 text-lg font-semibold tabular-nums ${danger ? "text-danger" : "text-foreground"}`}
      >
        {value}
      </p>
      {suffix && <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{suffix}</p>}
    </div>
  );
}

export function BillingHeader({ state }: { state?: BillingState | null }) {
  const { t } = useI18n();
  const h = t.billing.header;
  const res = t.billing.usage.resources;
  const periodStart = state?.currentPeriod.start ?? null;
  const [totals, setTotals] = useState<UsageTotals | null>(null);

  useEffect(() => {
    if (!state) return;
    let cancelled = false;
    const to = new Date();
    const from = periodStart
      ? new Date(periodStart)
      : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
    const qs = new URLSearchParams({
      from: from.toISOString(),
      to: to.toISOString(),
      groupBy: "day",
    });
    api
      .get<UsageResponse>(`billing/usage?${qs.toString()}`)
      .then((r) => {
        if (!cancelled) setTotals(r.data.usage?.totals ?? null);
      })
      .catch(() => {
        /* header stats are best-effort; the tabs surface real errors */
      });
    return () => {
      cancelled = true;
    };
  }, [state, periodStart]);

  const limits = state ? (PLANS[state.tier]?.oblienLimits ?? null) : null;
  const dash = "—";

  return (
    <div>
      <h1
        className="text-2xl font-medium text-foreground/80"
        style={{ letterSpacing: "-0.2px" }}
      >
        {t.billing.layout.title}
      </h1>
      <p className="mt-1 text-sm text-muted-foreground/70">{t.billing.layout.subtitle}</p>

      {state && (
        <>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Stat
              label={h.credits}
              value={fmtCredits(state.balance.quotaRemaining)}
              suffix={
                state.overQuota
                  ? h.overQuota
                  : interpolate(h.creditsSuffix, {
                      limit: fmtCredits(state.balance.quotaLimit),
                    })
              }
              danger={state.overQuota}
            />
            <Stat
              label={h.bandwidth}
              value={totals ? `${fmtNum(totals.network_gb, 2)} GB` : dash}
              suffix={h.bandwidthNote}
            />
            <Stat
              label={res.cpu.label}
              value={totals ? fmtNum(totals.vcpu_hours) : dash}
              suffix={res.cpu.units}
            />
            <Stat
              label={res.memory.label}
              value={totals ? fmtNum(totals.gb_hours) : dash}
              suffix={res.memory.units}
            />
            <Stat
              label={res.disk.label}
              value={totals ? `${fmtNum(totals.disk_io_gb, 2)} GB` : dash}
            />
            <Stat
              label={h.build}
              value={fmtNum(state.buildTimeMinutes, 0)}
              suffix={h.min}
            />
          </div>
          {limits && (
            <p className="mt-2 text-[11px] text-muted-foreground/70">
              {h.capacity}: {limits.max_workspaces} {h.workspaces} · {limits.max_vcpus}{" "}
              {h.vcpus} · {Math.round(limits.max_ram_mb / 1024)} GB {h.ram} ·{" "}
              {limits.max_disk_gb} GB {h.diskCap}
            </p>
          )}
        </>
      )}
    </div>
  );
}
