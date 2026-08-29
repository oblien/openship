"use client";

import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";

import { useI18n } from "@/components/i18n-provider";
import type { InfraSegment } from "@/hooks/useInfraFleet";

/**
 * Server-list search + component-state segments, rendered only once the fleet is
 * big enough to need hunting. Same shape as the deployments filter strip (search
 * grows, segmented switch beside it) so the two list pages behave identically.
 * A segment with a zero count hides its number rather than showing a grey 0.
 */
export function InfraFilters({
  segment,
  onSegmentChange,
  search,
  onSearchChange,
  counts,
}: {
  segment: InfraSegment;
  onSegmentChange: (next: InfraSegment) => void;
  search: string;
  onSearchChange: (next: string) => void;
  counts: { attention: number; updates: number; healthy: number };
}) {
  const { t } = useI18n();
  const c = t.servers.list.infra;
  const [local, setLocal] = useState(search);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => setLocal(search), [search]);
  useEffect(() => () => {
    if (debounce.current) clearTimeout(debounce.current);
  }, []);

  const onType = (value: string) => {
    setLocal(value);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => onSearchChange(value), 300);
  };

  const segments: { key: InfraSegment; label: string; count?: number }[] = [
    { key: "all", label: c.filterAll },
    { key: "attention", label: c.filterAttention, count: counts.attention },
    { key: "updates", label: c.filterUpdates, count: counts.updates },
    { key: "healthy", label: c.filterHealthy, count: counts.healthy },
  ];

  return (
    <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
      <div className="relative w-full sm:flex-1 sm:min-w-[200px]">
        <Search className="pointer-events-none absolute start-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <input
          type="text"
          value={local}
          onChange={(e) => onType(e.target.value)}
          placeholder={c.searchPlaceholder}
          className="h-10 w-full rounded-xl border border-border/50 bg-card ps-10 pe-4 text-sm text-foreground transition-all placeholder:text-muted-foreground focus:border-primary/20 focus:outline-none focus:ring-2 focus:ring-primary/20"
        />
      </div>

      <div className="inline-flex max-w-full shrink-0 flex-wrap items-center gap-1 rounded-xl bg-muted/35 p-1">
        {segments.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => onSegmentChange(s.key)}
            className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-3.5 text-[12px] font-medium transition-colors ${
              segment === s.key
                ? "border border-border/60 bg-card text-foreground"
                : "text-muted-foreground hover:bg-background/60 hover:text-foreground"
            }`}
          >
            {s.label}
            {s.count !== undefined && s.count > 0 && (
              <span className="tabular-nums text-muted-foreground">{s.count}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
