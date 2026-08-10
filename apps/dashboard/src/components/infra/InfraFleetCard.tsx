"use client";

import Link from "next/link";
import {
  ArrowUpCircle,
  Boxes,
  CheckCircle2,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Wrench,
} from "lucide-react";

import { useI18n, interpolate } from "@/components/i18n-provider";
import type { ContainerApplyIntent } from "@/lib/api/system";

/** Header controls — shared so the scan button and the tracker link sit level. */
const ICON_BUTTON =
  "inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/50 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50";

/**
 * Servers tab → right column: the fleet roll-up for managed containers (edge /
 * mail) plus the two bulk actions. Presentational — the counts and both callbacks
 * come from {@link useInfraFleet}, which drives the same endpoints a single row
 * uses, so a bulk apply is just many of the per-server sessions started at once.
 *
 * Buttons appear only when they have something to act on, and the whole body
 * collapses to one "all up to date" line when the fleet is clean.
 */
export function InfraFleetCard({
  counts,
  scanning,
  applying,
  onScan,
  onApply,
}: {
  counts: { attention: number; updates: number; healthy: number; stopped: number; behind: number };
  scanning: boolean;
  applying: ContainerApplyIntent | null;
  onScan: () => void;
  onApply: (intent: ContainerApplyIntent) => void;
}) {
  const { t } = useI18n();
  const c = t.servers.list.infra;
  const clean = counts.attention === 0 && counts.updates === 0;

  return (
    <div className="rounded-2xl border border-border/50 bg-card">
      <div className="flex items-center gap-3 border-b border-border/50 px-5 py-4">
        <div className="flex size-9 items-center justify-center rounded-xl bg-muted">
          <Boxes className="size-[18px] text-muted-foreground" />
        </div>
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold text-foreground">{c.title}</h2>
          <p className="truncate text-xs text-muted-foreground">{c.subtitle}</p>
        </div>
        <div className="ms-auto flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onScan}
            disabled={scanning}
            title={c.scan}
            aria-label={c.scan}
            className={ICON_BUTTON}
          >
            <RefreshCw className={`size-3.5 ${scanning ? "animate-spin" : ""}`} />
          </button>
          {/* This roll-up says how many boxes need attention; the tracker says what. */}
          <Link href="/issues" title={t.issues.title} aria-label={t.issues.title} className={ICON_BUTTON}>
            <ShieldAlert className="size-3.5" />
          </Link>
        </div>
      </div>

      <div className="space-y-3 p-5">
        {clean ? (
          <p className="inline-flex items-center gap-2 text-[13px] text-muted-foreground">
            <CheckCircle2 className="size-4 shrink-0 text-success" />
            {c.allHealthy}
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
              {counts.attention > 0 && (
                <span className="font-medium text-danger tabular-nums">
                  {interpolate(c.attention, { n: String(counts.attention) })}
                </span>
              )}
              {counts.attention > 0 && counts.updates > 0 && (
                <span className="text-muted-foreground/50">·</span>
              )}
              {counts.updates > 0 && (
                <span className="font-medium text-warning tabular-nums">
                  {interpolate(c.updates, { n: String(counts.updates) })}
                </span>
              )}
              {counts.healthy > 0 && (
                <>
                  <span className="text-muted-foreground/50">·</span>
                  <span className="text-muted-foreground tabular-nums">
                    {interpolate(c.healthy, { n: String(counts.healthy) })}
                  </span>
                </>
              )}
            </div>

            {(counts.behind > 0 || counts.stopped > 0) && (
              <div className="flex flex-col gap-2">
                {counts.behind > 0 && (
                  <button
                    type="button"
                    onClick={() => onApply("update")}
                    disabled={applying !== null}
                    className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-warning-bg px-3 py-2 text-[12.5px] font-medium text-warning transition-colors hover:bg-warning/20 disabled:opacity-50"
                  >
                    {applying === "update" ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <ArrowUpCircle className="size-3.5" />
                    )}
                    {interpolate(c.updateAll, { n: String(counts.behind) })}
                  </button>
                )}
                {counts.stopped > 0 && (
                  <button
                    type="button"
                    onClick={() => onApply("repair")}
                    disabled={applying !== null}
                    className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-danger-bg px-3 py-2 text-[12.5px] font-medium text-danger transition-colors hover:bg-danger/20 disabled:opacity-50"
                  >
                    {applying === "repair" ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Wrench className="size-3.5" />
                    )}
                    {interpolate(c.restartStopped, { n: String(counts.stopped) })}
                  </button>
                )}
              </div>
            )}

            {/* Attention with nothing bulk-safe left (absent edge, gone container):
                the fix is on the server's own page, so say so instead of offering
                a button that would skip everything. */}
            {counts.attention > 0 && counts.behind === 0 && counts.stopped === 0 && (
              <p className="text-[12px] leading-relaxed text-muted-foreground">{c.openServerHint}</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
