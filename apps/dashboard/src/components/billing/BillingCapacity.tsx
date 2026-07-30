"use client";

import React from "react";
import { Cloud } from "lucide-react";
import { PLANS } from "@repo/core";
import { useI18n, interpolate } from "@/components/i18n-provider";
import type { BillingState, CapacityMeter } from "@/lib/api/billing";

export type { BillingState };

/* ------------------------------------------------------------------ */
/*  Capacity & usage panel                                            */
/*                                                                    */
/*  A per-resource "used vs maximum capacity" view that renders for    */
/*  every tier (free included). Ceilings come from the tier's static   */
/*  oblienLimits so the panel is meaningful immediately; live          */
/*  consumption (and cloud-only ceilings like free routes / bandwidth) */
/*  fills in from `state.capacity` once Openship Cloud reports it. Any  */
/*  meter still awaiting cloud data shows a "syncing" hint rather than  */
/*  a fake zero.                                                        */
/* ------------------------------------------------------------------ */

interface RowSpec {
  key: string;
  label: string;
  meter: CapacityMeter;
  /** Render a raw resource value (already in display units) → string. */
  format: (n: number) => string;
  /** Unit suffix shown after formatted values (e.g. "GB"). */
  unit?: string;
}

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString();
}
function fmtCredits(n: number): string {
  // values arrive in milli-credits
  return Math.floor(n / 1000).toLocaleString();
}
function fmtGb(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: n >= 100 ? 0 : 1 });
}

function pct(used: number, max: number): number {
  if (max <= 0) return 0;
  return Math.min(100, Math.max(0, (used / max) * 100));
}

/** Threshold tone — same scale the overview ring uses. Applied as a text color
 *  so the bar fill can inherit it via `bg-current`. */
function toneClass(p: number): string {
  if (p >= 90) return "text-danger";
  if (p >= 75) return "text-warning";
  return "text-primary";
}

function MeterRow({ label, meter, format, unit }: Omit<RowSpec, "key">) {
  const { t } = useI18n();
  const c = t.billing.capacity;
  const suffix = unit ? ` ${unit}` : "";

  const hasMax = meter.max != null;
  const hasUsed = meter.used != null;
  const p = hasMax && hasUsed ? pct(meter.used!, meter.max!) : 0;
  const tone = toneClass(p);

  return (
    <div className="py-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium text-foreground">{label}</span>
        <span className="text-sm tabular-nums text-muted-foreground">
          {hasUsed ? (
            <>
              <span className="font-semibold text-foreground">
                {format(meter.used!)}
                {suffix}
              </span>
              {hasMax ? (
                <span className="ms-1">
                  {interpolate(c.of, { max: `${format(meter.max!)}${suffix}` })}
                </span>
              ) : (
                <span className="ms-1">· {c.unlimited}</span>
              )}
            </>
          ) : hasMax ? (
            // Ceiling known (from the plan), live usage not yet reported.
            <span className="inline-flex items-center gap-1">
              <Cloud className="size-3" />
              {c.syncing}
              <span className="ms-1 text-foreground">
                · {format(meter.max!)}
                {suffix}
              </span>
            </span>
          ) : (
            <span className="inline-flex items-center gap-1">
              <Cloud className="size-3" />
              {c.syncing}
            </span>
          )}
        </span>
      </div>

      {/* Track — filled only when we have both used + max. */}
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
        {hasMax && hasUsed ? (
          <div
            className={`${tone} h-full rounded-full bg-current transition-[width] duration-500`}
            style={{ width: `${p}%` }}
          />
        ) : hasMax ? (
          // Ceiling known but no usage yet — show a faint indeterminate hint.
          <div className="h-full w-1/4 rounded-full bg-border/60" />
        ) : null}
      </div>
    </div>
  );
}

export const BillingCapacity: React.FC<{ state: BillingState }> = ({ state }) => {
  const { t } = useI18n();
  const c = t.billing.capacity;
  const h = t.billing.header;
  const limits = PLANS[state.tier]?.oblienLimits ?? null;
  const cap = state.capacity;

  // Merge cloud-reported meters with static plan ceilings. Cloud wins for the
  // ceiling when present; otherwise fall back to the tier's oblienLimits so the
  // max is never blank for a metered resource we know the plan caps.
  const meter = (
    reported: CapacityMeter | undefined,
    fallbackMax: number | null,
  ): CapacityMeter => ({
    used: reported?.used ?? null,
    max: reported?.max ?? fallbackMax,
  });

  const rows: RowSpec[] = [];

  // Credits — fully live from the balance (the primary allowance meter).
  rows.push({
    key: "credits",
    label: h.credits,
    meter: { used: state.balance.quotaUsed, max: state.balance.quotaLimit },
    format: fmtCredits,
  });

  // Free edge routes — cloud-only concept (no static plan ceiling).
  if (cap?.routes) {
    rows.push({ key: "routes", label: c.routes, meter: meter(cap.routes, null), format: fmtInt });
  }

  // Workspaces / vCPU / RAM / Disk — ceiling from the tier's oblienLimits,
  // usage from the cloud when available.
  rows.push({
    key: "workspaces",
    label: c.workspaces,
    meter: meter(cap?.workspaces, limits?.max_workspaces ?? null),
    format: fmtInt,
  });
  rows.push({
    key: "vcpus",
    label: h.vcpus,
    meter: meter(cap?.vcpus, limits?.max_vcpus ?? null),
    format: fmtInt,
  });
  rows.push({
    key: "ram",
    label: h.ram,
    meter: {
      used: cap?.ramMb?.used != null ? cap.ramMb.used / 1024 : null,
      max: cap?.ramMb?.max != null ? cap.ramMb.max / 1024 : limits ? limits.max_ram_mb / 1024 : null,
    },
    format: fmtGb,
    unit: "GB",
  });
  rows.push({
    key: "disk",
    label: h.diskCap,
    meter: meter(cap?.diskGb, limits?.max_disk_gb ?? null),
    format: fmtGb,
    unit: "GB",
  });

  // Bandwidth — cloud-only (no static ceiling).
  if (cap?.bandwidthGb) {
    rows.push({
      key: "bandwidth",
      label: h.bandwidth,
      meter: meter(cap.bandwidthGb, null),
      format: fmtGb,
      unit: "GB",
    });
  }

  return (
    <div className="rounded-2xl border border-border/50 bg-card p-6">
      <div className="mb-2">
        <h2 className="text-base font-semibold text-foreground">{c.title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{c.subtitle}</p>
      </div>
      <div className="divide-y divide-border/50">
        {rows.map(({ key, ...row }) => (
          <MeterRow key={key} {...row} />
        ))}
      </div>
    </div>
  );
};

export default BillingCapacity;
