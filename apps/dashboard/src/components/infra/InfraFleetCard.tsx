"use client";

import Link from "next/link";
import {
  ArrowUpCircle,
  Boxes,
  CheckCircle2,
  Loader2,
  RefreshCw,
  ScrollText,
  ShieldAlert,
  TriangleAlert,
  Wrench,
} from "lucide-react";

import { useI18n, interpolate } from "@/components/i18n-provider";
import type { ContainerApplyActive, ContainerApplyIntent } from "@/lib/api/system";
import { applyIntentOf, applyPercent, applyPhase, type ApplyOutcome } from "@/lib/infra-apply-status";

/** Header controls — shared so the scan button and the tracker link sit level. */
const ICON_BUTTON =
  "inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/50 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50";

/** Per-target lines shown in full before the rest collapse into a "+N more". */
const TARGET_LINES = 3;

/**
 * Servers tab → right column: the fleet roll-up for managed containers (edge /
 * mail), the two bulk actions, and the LIVE state of anything being applied.
 * Presentational — the counts, the in-flight set and both callbacks come from
 * {@link useInfraFleet}, which drives the same endpoints a single row uses, so a
 * bulk apply is just many of the per-server sessions started at once.
 *
 * The three states are deliberately separate lines rather than one mode switch:
 * counts describe what is left to do (work already underway is excluded from them,
 * so nothing here offers the same swap twice), the progress block describes what is
 * happening, and the settled line reports how the last run ended — which is the one
 * beat the drift counts can never carry, because a component that lands clears its
 * update and its in-progress mark in the same write and simply disappears.
 */
export function InfraFleetCard({
  counts,
  scanning,
  applying,
  active,
  outcome,
  onScan,
  onApply,
  onViewLogs,
}: {
  counts: {
    attention: number;
    updates: number;
    healthy: number;
    stopped: number;
    behind: number;
    applying: number;
  };
  scanning: boolean;
  applying: ContainerApplyIntent | null;
  /** Components mid-apply, queued ones included. Empty when the fleet is idle. */
  active: ContainerApplyActive[];
  /** How the run that just finished ended, for a few seconds after it did. */
  outcome: ApplyOutcome | null;
  onScan: () => void;
  onApply: (intent: ContainerApplyIntent) => void;
  /** Open the live log for one in-flight component (re-attaches, never restarts). */
  onViewLogs?: (target: ContainerApplyActive) => void;
}) {
  const { t } = useI18n();
  const c = t.servers.list.infra;
  const inFlight = active.length > 0;
  // Counts exclude in-flight work, so "nothing left to report" can be true while a
  // swap is still running — the progress block is what speaks then.
  const clean = counts.attention === 0 && counts.updates === 0;
  const canAct = counts.behind > 0 || counts.stopped > 0;
  const busy = applying !== null || inFlight;

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
          <Link href="/monitoring" title={t.issues.title} aria-label={t.issues.title} className={ICON_BUTTON}>
            <ShieldAlert className="size-3.5" />
          </Link>
        </div>
      </div>

      <div className="space-y-3 p-5">
        {!clean && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
            {counts.attention > 0 && (
              <span className="font-medium text-danger tabular-nums">
                {interpolate(counts.attention === 1 ? c.attentionOne : c.attentionMany, {
                  n: String(counts.attention),
                })}
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
        )}

        {inFlight && <ApplyingBlock active={active} onViewLogs={onViewLogs} />}

        {/* The settled beat, once nothing is left running. */}
        {!inFlight && outcome && (
          <div className="space-y-1">
            {outcome.done > 0 && (
              <p className="inline-flex items-center gap-2 text-[13px] text-success">
                <CheckCircle2 className="size-4 shrink-0" />
                {interpolate(outcome.done === 1 ? c.doneOne : c.doneMany, {
                  n: String(outcome.done),
                })}
              </p>
            )}
            {outcome.failed > 0 && (
              <>
                <p className="inline-flex items-center gap-2 text-[13px] text-danger">
                  <TriangleAlert className="size-4 shrink-0" />
                  {interpolate(outcome.failed === 1 ? c.failedOne : c.failedMany, {
                    n: String(outcome.failed),
                  })}
                </p>
                {outcome.error && (
                  <p className="text-[12px] leading-relaxed text-muted-foreground">{outcome.error}</p>
                )}
              </>
            )}
          </div>
        )}

        {/* Nothing to report and nothing happening — the resting state. */}
        {clean && !inFlight && !outcome && (
          <p className="inline-flex items-center gap-2 text-[13px] text-muted-foreground">
            <CheckCircle2 className="size-4 shrink-0 text-success" />
            {c.allHealthy}
          </p>
        )}

        {canAct && (
          <div className="flex flex-col gap-2">
            {counts.behind > 0 && (
              <button
                type="button"
                onClick={() => onApply("update")}
                disabled={busy}
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
                disabled={busy}
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
        {counts.attention > 0 && !canAct && !inFlight && (
          <p className="text-[12px] leading-relaxed text-muted-foreground">{c.openServerHint}</p>
        )}
      </div>
    </div>
  );
}

/**
 * The live block: one headline for the whole run, a bar, and a line per component.
 *
 * Progress is the bar's WIDTH; the sweep only says "still moving", so a long image
 * pull doesn't read as a hung bar. "View logs" re-attaches to a running session
 * rather than starting anything — it is offered only for a component that has one
 * (a queued target has nothing to show yet).
 */
function ApplyingBlock({
  active,
  onViewLogs,
}: {
  active: ContainerApplyActive[];
  onViewLogs?: (target: ContainerApplyActive) => void;
}) {
  const { t } = useI18n();
  const c = t.servers.list.infra;
  const percent = applyPercent(active);
  const restart = applyIntentOf(active) === "repair";
  const head = restart
    ? active.length === 1
      ? c.restartingOne
      : c.restartingMany
    : active.length === 1
      ? c.applyingOne
      : c.applyingMany;
  const phaseLabel: Record<ReturnType<typeof applyPhase>, string> = {
    queued: c.stateQueued,
    starting: t.servers.containers.starting,
    pull: c.stepPull,
    recreate: c.stepRecreate,
    verify: c.stepVerify,
  };
  const shown = active.slice(0, TARGET_LINES);
  const hidden = active.length - shown.length;
  const watchable = active.find((target) => target.sessionId);

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex min-w-0 items-center gap-1.5 text-[13px] font-medium text-foreground">
          <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
          <span className="truncate">{interpolate(head, { n: String(active.length) })}</span>
        </span>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
          {percent}%
        </span>
      </div>

      <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className="relative h-full overflow-hidden rounded-full bg-primary transition-[width] duration-700 ease-out"
          style={{ width: `${percent}%` }}
        >
          <span className="absolute inset-0 animate-progress-sweep bg-gradient-to-r from-transparent via-primary-foreground/30 to-transparent" />
        </div>
      </div>

      <ul className="mt-2.5 space-y-1">
        {shown.map((target) => (
          <li
            key={`${target.serverId}:${target.component}`}
            className="flex items-center gap-2 text-[12px] text-muted-foreground"
          >
            <span
              className={`size-1.5 shrink-0 rounded-full ${
                target.state === "running" ? "bg-info-solid" : "bg-muted-foreground/40"
              }`}
            />
            <span className="min-w-0 flex-1 truncate">
              {target.component === "mail"
                ? t.servers.containers.componentMail
                : t.servers.containers.componentEdge}
              {" · "}
              {target.serverName}
            </span>
            <span className="shrink-0 text-muted-foreground/80">{phaseLabel[applyPhase(target)]}</span>
          </li>
        ))}
        {hidden > 0 && (
          <li className="text-[12px] text-muted-foreground/70 tabular-nums">
            {interpolate(c.moreTargets, { n: String(hidden) })}
          </li>
        )}
      </ul>

      {watchable && onViewLogs && (
        <button
          type="button"
          onClick={() => onViewLogs(watchable)}
          className="mt-2.5 inline-flex items-center gap-1.5 rounded-lg px-2 py-1 -mx-2 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ScrollText className="size-3.5" />
          {c.viewLogs}
        </button>
      )}
    </div>
  );
}
