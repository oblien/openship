"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import type { ReactNode } from "react";
import { interpolate, useI18n } from "@/components/i18n-provider";
import { formatBillingNumber } from "@/lib/billing-usage";

export function ResourceLabel({ label, hint }: { label: string; hint: string }) {
  return <details className="group relative" onKeyDown={event => {
    if (event.key === "Escape") event.currentTarget.open = false;
  }}>
    <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded text-xs font-medium text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary [&::-webkit-details-marker]:hidden">
      {label}<UiIcon name="help-circle" className="size-3.5 shrink-0 text-muted-foreground/50" aria-hidden="true" />
    </summary>
    <p className="absolute start-0 top-full z-10 mt-2 w-56 max-w-[calc(100vw-5rem)] rounded-xl border border-border/50 bg-popover p-3 text-xs leading-relaxed text-muted-foreground shadow-lg">{hint}</p>
  </details>;
}

/** Unknown limits stay empty; only a finite, positive allowance has progress. */
export function ResourceRing({ used, max, label, children, large = false }: {
  used: number | null; max?: number | null; label: string; children?: ReactNode; large?: boolean;
}) {
  const known = used !== null && Number.isFinite(used) && max != null && Number.isFinite(max) && max > 0;
  const fraction = known ? Math.min(1, Math.max(0, used / max)) : 0;
  const color = fraction >= 1 ? "text-danger" : fraction >= .8 ? "text-warning" : "text-foreground";
  return <div className={`relative flex shrink-0 items-center justify-center ${large ? "size-24" : "size-12"} ${color}`}
    {...(known ? { role: "meter", "aria-label": label, "aria-valuemin": 0, "aria-valuemax": max!, "aria-valuenow": Math.min(max!, Math.max(0, used!)) } : { "aria-hidden": true })}>
    <svg viewBox="0 0 48 48" className="absolute inset-0 size-full -rotate-90" aria-hidden="true">
      <circle cx="24" cy="24" r="20" fill="none" stroke="currentColor" strokeWidth="3" className="text-border/70" />
      {fraction > 0 && <circle cx="24" cy="24" r="20" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"
        strokeDasharray={`${fraction * 125.664} 125.664`} className="motion-safe:transition-[stroke-dasharray] motion-safe:duration-500" />}
    </svg>
    <span className="relative flex items-center justify-center">{children}</span>
  </div>;
}

export function ResourceMeter({ label, hint, used, max, unit, icon, noPlan = false, footnote }: {
  label: string; hint: string; used: number | null; max?: number | null; unit?: string; icon: ReactNode;
  noPlan?: boolean; footnote?: string;
}) {
  const { t, locale } = useI18n();
  const copy = t.billing.resourceOverview;
  const n = (value: number) => formatBillingNumber(value, locale);
  const value = noPlan ? 0 : used;
  const limit = noPlan ? 0 : max;
  const valid = value !== null && Number.isFinite(value);
  const finiteLimit = typeof limit === "number" && Number.isFinite(limit);
  return <div className="min-w-0 rounded-xl border border-border/50 px-4 py-4" aria-label={label}>
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <ResourceLabel label={label} hint={hint} />
        <p className="mt-2 flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 tabular-nums" data-resource-value>
          <span className="text-2xl font-semibold tracking-tight text-foreground">{valid ? n(value) : "—"}</span>
          {unit && <span className="text-xs text-muted-foreground">{unit}</span>}
          {!noPlan && finiteLimit && <span className="text-xs text-muted-foreground">/ {n(limit)}{unit ? ` ${unit}` : ""}</span>}
        </p>
      </div>
      <ResourceRing label={label} used={value} max={limit}><span className="text-muted-foreground">{icon}</span></ResourceRing>
    </div>
    <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
      {noPlan ? t.billing.onboarding.planRequired : footnote ?? (!valid ? copy.unavailable : finiteLimit
        ? interpolate(copy.remaining, { amount: `${n(Math.max(0, limit - value))}${unit ? ` ${unit}` : ""}` })
        : limit === null ? t.billing.resourcesGuide.unlimited : copy.measuredUsage)}
    </p>
  </div>;
}
