"use client";

import React from "react";
import { Cloud } from "lucide-react";
import { PLANS, RESOURCE_TIER_SPECS, formatCpuCores, formatMemoryMb } from "@repo/core";
import { useI18n, interpolate } from "@/components/i18n-provider";
import type { BillingState, CapacityMeter } from "@/lib/api/billing";

export type { BillingState };

/* ------------------------------------------------------------------ */
/*  Capacity & usage panel                                            */
/*                                                                    */
/*  A per-resource "used vs maximum capacity" view that renders for    */
/*  every tier (free included). Ceilings come from the tier's `limits` */
/*  in the pricing catalog — the same numbers enforcement reads — so   */
/*  the panel is meaningful immediately; live consumption (and         */
/*  cloud-only ceilings like free routes) fills in from               */
/*  `state.capacity` once Openship Cloud reports it. Any meter still   */
/*  awaiting cloud data shows a "syncing" hint rather than a fake zero.*/
/*                                                                    */
/*  EVERY METER HERE CAN FILL. The vCPU / RAM / disk rows this panel   */
/*  used to draw took their ceiling from `oblienLimits`, which are     */
/*  PER-WORKSPACE caps rather than a namespace pool — a used/max bar   */
/*  was the wrong shape for them at any value, and their `used` was    */
/*  never reported, so they were four permanently-empty rows. The      */
/*  bandwidth row was worse: nothing enforced it. Per-service machine  */
/*  size is now a plain labelled VALUE at the foot of the panel, which */
/*  is what it actually is.                                            */
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
  // Values arrive in milli-credits. The result is read as COMPUTE MINUTES: one
  // compute minute is one credit (`MILLI_PER_COMPUTE_MINUTE`), which is why the
  // divisor is unchanged even though the label now says compute — the plans
  // publish minutes, so the meter beside them has to speak minutes too.
  return Math.floor(n / 1000).toLocaleString();
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

/** A ceiling with no meter: a labelled value, no bar. Used for figures that are
 *  a per-unit SIZE rather than a pool — drawing a progress track under one would
 *  imply a total that gets consumed. */
function ValueRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-3">
      <span className="text-sm font-medium text-foreground">{label}</span>
      <span className="text-sm font-semibold tabular-nums text-foreground">{value}</span>
    </div>
  );
}

export const BillingCapacity: React.FC<{ state: BillingState }> = ({ state }) => {
  const { t } = useI18n();
  const c = t.billing.capacity;
  const h = t.billing.header;
  // Customer-facing ceilings, from the same catalog entry enforcement reads.
  const limits = PLANS[state.tier]?.limits ?? null;
  const cap = state.capacity;

  // Merge cloud-reported meters with the plan's ceilings. Cloud wins for the
  // ceiling when present; otherwise fall back to the tier's `limits` so the max
  // is never blank for a resource we know the plan caps. `null` on either side
  // is meaningful — see CapacityMeter.
  const meter = (
    reported: CapacityMeter | undefined,
    fallbackMax: number | null,
  ): CapacityMeter => ({
    used: reported?.used ?? null,
    max: reported?.max ?? fallbackMax,
  });

  const rows: RowSpec[] = [];

  // Compute minutes — fully live from the balance (the primary allowance meter).
  // The quota behind it is the tier's whole derived grant, app runtime PLUS its
  // build allowance (see `planMonthlyCredits`), which is why the build row below is
  // a view of the same pool rather than a second, independent budget.
  rows.push({
    key: "credits",
    label: h.credits,
    meter: { used: state.balance.quotaUsed, max: state.balance.quotaLimit },
    format: fmtCredits,
  });

  // Build minutes — the allowance a deploy is actually refused on, so it sits
  // directly under credits rather than at the bottom with the informational rows.
  if (cap?.buildMinutes) {
    rows.push({
      key: "buildMinutes",
      label: h.build,
      meter: meter(cap.buildMinutes, null),
      format: fmtInt,
      unit: h.min,
    });
  }

  // Running services — one Oblien workspace each, and the ceiling a customer
  // actually feels. Rendered for every tier: the catalog supplies the max even
  // before the cloud reports usage, and "0 of 3" is a real statement.
  rows.push({
    key: "services",
    label: c.runningServices,
    meter: meter(cap?.services, limits?.runningServices ?? null),
    format: fmtInt,
  });

  // Projects — Openship-enforced; Oblien has no project concept at all.
  rows.push({
    key: "projects",
    label: c.projects,
    meter: meter(cap?.projects, limits?.maxProjects ?? null),
    format: fmtInt,
  });

  // Free edge routes — cloud-only concept (no static plan ceiling).
  if (cap?.routes) {
    rows.push({ key: "routes", label: c.routes, meter: meter(cap.routes, null), format: fmtInt });
  }

  /**
   * Largest machine a single service may select on this tier. Deliberately not a
   * meter — it is a PER-SERVICE size, so there is no pool to fill.
   *
   * The label is borrowed from the project's own machine-power section
   * (`projectSettings.resources.title`, translated in all nine locales) so the
   * size quoted on the billing page and the size in the picker are named the same
   * thing, with no new dictionary key. The VALUE is the spec itself rather than
   * the tier's name: `RESOURCE_TIER_SPECS` is keyed by every `FixedResourceTier`,
   * so reading it can't go stale when a tier is added, whereas a per-tier name
   * lookup in a dictionary silently would. `null` = the negotiated tier, where no
   * size cap applies.
   */
  const sizeTier = limits?.maxResourceTier ?? null;
  const spec = sizeTier ? RESOURCE_TIER_SPECS[sizeTier] : null;
  const machineSize = spec
    ? `${formatCpuCores(spec.cpuCores)} · ${formatMemoryMb(spec.memoryMb)}`
    : c.unlimited;

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
        <ValueRow label={t.projectSettings.resources.title} value={machineSize} />
      </div>
    </div>
  );
};

export default BillingCapacity;
