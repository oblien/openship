import type { ReactNode } from "react";
import { ResourceLabel } from "@/components/billing/ResourceMeter";

/** Compact metric used on the project and mail overviews. */
export function OverviewStatCard({
  label,
  hint,
  icon,
  value,
  limit,
  subtext,
  loading,
  indicator,
}: {
  label: string;
  hint?: ReactNode;
  icon: ReactNode;
  value: ReactNode;
  limit?: string;
  subtext?: ReactNode;
  loading?: boolean;
  indicator?: ReactNode;
}) {
  return (
    <div
      aria-label={label}
      aria-busy={loading}
      className="flex min-w-0 items-center justify-between gap-2 rounded-xl border border-border/50 bg-card px-3.5 py-3"
    >
      <div className="min-w-0 self-start">
        <div className="mb-1 flex items-center gap-1.5">
          <span className="shrink-0 text-primary [&>svg]:size-3.5">{icon}</span>
          <ResourceLabel label={label} hint={hint} />
        </div>
        {loading ? (
          <>
            <div className="h-[18px] w-12 animate-pulse rounded bg-muted-foreground/25" />
            <div className="mt-1.5 h-[10px] w-20 animate-pulse rounded bg-muted-foreground/15" />
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-baseline gap-x-1 text-lg font-semibold leading-tight text-foreground tabular-nums">
              <span>{value}</span>
              {limit && (
                <span className="text-sm font-normal text-muted-foreground">/ {limit}</span>
              )}
            </div>
            {subtext && <div className="mt-0.5 text-[11px] text-muted-foreground">{subtext}</div>}
          </>
        )}
      </div>
      {indicator}
    </div>
  );
}
