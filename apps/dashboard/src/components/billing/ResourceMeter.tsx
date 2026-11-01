"use client";

import { Icon as UiIcon } from "@repo/ui/icons";
import type { ReactNode } from "react";
import { interpolate, useI18n } from "@/components/i18n-provider";
import { formatBillingNumber } from "@/lib/billing-usage";

export function ResourceLabel({ label, hint }: { label: string; hint?: string }) {
  if (!hint) return <p className="text-xs font-medium text-muted-foreground">{label}</p>;
  return (
    <details
      className="group relative"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") event.currentTarget.open = false;
      }}
    >
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded text-xs font-medium text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary [&::-webkit-details-marker]:hidden">
        {label}
        <UiIcon name="help-circle" className="size-3.5 shrink-0" aria-hidden="true" />
      </summary>
      <p className="absolute start-0 top-full z-10 mt-2 w-56 max-w-[calc(100vw-5rem)] rounded-xl bg-popover p-3 text-xs leading-relaxed text-popover-foreground shadow-lg">
        {hint}
      </p>
    </details>
  );
}

/** Unknown limits stay empty; only a finite, positive allowance has progress. */
export function ResourceRing({
  used,
  max,
  label,
  children,
  large = false,
}: {
  used: number | null;
  max?: number | null;
  label: string;
  children?: ReactNode;
  large?: boolean;
}) {
  const known =
    used !== null && Number.isFinite(used) && max != null && Number.isFinite(max) && max > 0;
  const fraction = known ? Math.min(1, Math.max(0, used / max)) : 0;
  const color = fraction >= 1 ? "text-danger" : fraction >= 0.8 ? "text-warning" : "text-primary";
  return (
    <div
      className={`relative flex shrink-0 items-center justify-center ${large ? "size-16" : "size-10"} ${color}`}
      {...(known
        ? {
            role: "meter",
            "aria-label": label,
            "aria-valuemin": 0,
            "aria-valuemax": max!,
            "aria-valuenow": Math.min(max!, Math.max(0, used!)),
          }
        : { "aria-hidden": true })}
    >
      <svg viewBox="0 0 48 48" className="absolute inset-0 size-full -rotate-90" aria-hidden="true">
        <circle
          cx="24"
          cy="24"
          r="20"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          className="text-muted-foreground/20"
        />
        {fraction > 0 && (
          <circle
            cx="24"
            cy="24"
            r="20"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={`${fraction * 125.664} 125.664`}
            className="motion-safe:transition-[stroke-dasharray] motion-safe:duration-500"
          />
        )}
      </svg>
      <span className="relative flex items-center justify-center">{children}</span>
    </div>
  );
}

export function ResourceMeter({
  label,
  hint,
  used,
  max,
  unit,
  icon,
  footnote,
  loading = false,
}: {
  label: string;
  hint?: string;
  used: number | null;
  max?: number | null;
  unit?: string;
  icon: ReactNode;
  footnote?: string;
  loading?: boolean;
}) {
  const { t, locale } = useI18n();
  const copy = t.billing.resourceOverview;
  const number = (value: number) => formatBillingNumber(value, locale);
  const valid = used !== null && Number.isFinite(used);
  const finiteLimit = typeof max === "number" && Number.isFinite(max);
  const note =
    footnote ??
    (!valid
      ? copy.unavailable
      : finiteLimit
        ? interpolate(copy.remaining, {
            amount: `${number(Math.max(0, max - used))}${unit ? ` ${unit}` : ""}`,
          })
        : max === null
          ? t.billing.resourcesGuide.unlimited
          : undefined);

  return (
    <div
      className="flex min-w-0 items-center gap-3 rounded-xl bg-muted/35 px-3.5 py-3"
      aria-label={label}
    >
      {finiteLimit && max > 0 ? (
        <ResourceRing label={label} used={loading ? null : used} max={max}>
          <span className="text-muted-foreground">{icon}</span>
        </ResourceRing>
      ) : (
        <span
          className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted/60 text-muted-foreground"
          aria-hidden="true"
        >
          {icon}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <ResourceLabel label={label} hint={hint} />
        {loading ? (
          <div className="mt-2 h-6 w-24 max-w-full animate-pulse rounded bg-muted" />
        ) : (
          <p
            className="mt-1 flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 tabular-nums"
            data-resource-value
          >
            <span className="text-xl font-medium tracking-tight text-foreground">
              {valid ? number(used) : "—"}
            </span>
            {unit && <span className="text-xs text-muted-foreground">{unit}</span>}
            {finiteLimit && (
              <span className="text-xs text-muted-foreground">
                / {number(max)}
                {unit ? ` ${unit}` : ""}
              </span>
            )}
          </p>
        )}
        {note && (
          <p className="mt-0.5 text-xs text-muted-foreground">
            {loading ? t.billing.usage.breakdown.loading : note}
          </p>
        )}
      </div>
    </div>
  );
}
