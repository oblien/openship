"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Loader2,
  Check,
  ArrowRight,
  ArrowLeft,
  ExternalLink,
  AlertTriangle,
  SlidersHorizontal,
  ChevronDown,
  ChevronUp,
  Square,
  Ban,
  Clock,
} from "lucide-react";
import { INSTALL_PHASES, type InstallPhaseId, type InstallPhaseStatus } from "@repo/core";
import { AppLogo } from "@/components/AppLogo";
import { PageContainer } from "@/components/ui/PageContainer";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { InstallStepper, type StepItem, type StepStatus } from "@/components/deploy/InstallStepper";
import { ConnectionCard } from "@/app/(dashboard)/projects/[id]/components/ConnectionCard";
import type { ServiceStatusEvent } from "@/lib/sseMessageProcessors";

export type CleanDeployPhase = "installing" | "done" | "error";

/** Map a raw deployment status to the two clean progress labels. */
export function labelForStatus(
  status: string,
  labels: { progressPreparing: string; progressDeploying: string },
): string {
  if (status === "building" || status === "deploying") return labels.progressDeploying;
  return labels.progressPreparing;
}

/**
 * Derive a public host from the deploy's publicEndpoints (custom domain wins,
 * else the free subdomain label + base domain).
 */
export function firstPublicHost(
  endpoints: Array<{ domain?: string; customDomain?: string; domainType?: string }> | undefined,
  baseDomain: string,
): string | null {
  const ep = endpoints?.[0];
  if (!ep) return null;
  if (ep.customDomain) return ep.customDomain;
  if (ep.domain) return ep.domain.includes(".") ? ep.domain : `${ep.domain}.${baseDomain}`;
  return null;
}

/** A running compose service reads as `done` on the stepper; a failed one as
 *  `failed`; anything mid-flight (building/built/deploying) as `active`. */
function serviceStatusToStep(status: ServiceStatusEvent["status"]): StepStatus {
  if (status === "running") return "done";
  if (status === "failed") return "failed";
  if (status === "pending") return "pending";
  return "active";
}

/**
 * One row of the install aside's read-out of what this deploy was configured
 * with — the destination, where each endpoint lands, the settings picked. It's
 * the one thing an operator can't read off the stepper or the logs, and it's what
 * the aside shows instead of a status dot that repeated the header.
 */
export interface DeploySummaryRow {
  id: string;
  label: string;
  value: string;
  /** Monospace the value — hostnames, hosts and ports read better fixed-width. */
  mono?: boolean;
}

/** A top-level install phase plus its sub-step statuses. The stepper AND the
 *  progress bar are both derived from this, so the two can't disagree. */
type PhaseRow = { id: InstallPhaseId; label: string; status: StepStatus; subs: StepStatus[] };

/** Statuses that mean a step will not advance again. */
const SETTLED: ReadonlySet<StepStatus> = new Set<StepStatus>([
  "done",
  "skipped",
  "failed",
  "error",
  "stopped",
]);

/**
 * Completion percent for the install bar, derived from the phase rows the
 * checklist renders — never from the backend's build percentage, which counts
 * build steps a services install never runs and would leave a bar at 90% next to
 * a checklist sitting on step 2.
 *
 * Phases weigh equally, and an ACTIVE phase contributes its own sub-step
 * fraction: a 10-service app advances ten times inside "Starting services"
 * instead of standing still at 25%. Held under 100 — this only renders while the
 * install is still running, so a full bar would be a lie.
 */
export function installProgressPercent(
  rows: readonly { status: StepStatus; subs: readonly StepStatus[] }[],
): number {
  if (rows.length === 0) return 0;
  let done = 0;
  for (const r of rows) {
    if (SETTLED.has(r.status)) {
      done += 1;
    } else if (r.status === "active" || r.status === "running") {
      const settled = r.subs.filter((s) => SETTLED.has(s)).length;
      // No sub-list → half the phase. With one, a just-started phase still nudges
      // the bar (0.15) so "working" is visible before the first service is up.
      done += r.subs.length === 0 ? 0.5 : Math.min(0.95, Math.max(0.15, settled / r.subs.length));
    }
  }
  return Math.min(99, Math.max(4, Math.round((done / rows.length) * 100)));
}

/** 1-based index of the phase in flight — or how many have settled while nothing
 *  is active yet (queued, or between phases). */
export function installStepIndex(rows: readonly { status: StepStatus }[]): number {
  const active = rows.findIndex((r) => r.status === "active" || r.status === "running");
  if (active >= 0) return active + 1;
  const settled = rows.filter((r) => SETTLED.has(r.status)).length;
  return Math.min(rows.length, Math.max(1, settled));
}

/** Compact elapsed time: "42s", "3m 08s", "1h 12m". */
function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/**
 * The aside's live install readout: a real progress bar (width = the stepper's own
 * completion), the phase in flight, its step counter and per-service tally, and an
 * elapsed clock. Replaces the status pill while installing — the pill said
 * "Installing" beside a spinner already saying it, and a heavy app can sit in one
 * phase for minutes with nothing to show that anything is moving.
 */
function InstallProgressPanel({
  title,
  percent,
  phaseLabel,
  metaLine,
  elapsed,
}: {
  title: string;
  percent: number;
  phaseLabel: string;
  /** "Step 2 of 4 · 3 of 10 services ready" — assembled by the caller (i18n). */
  metaLine: string;
  elapsed: string | null;
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex min-w-0 items-center gap-1.5 text-[13px] font-semibold text-foreground">
          <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
          <span className="truncate">{title}</span>
        </span>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
          {percent}%
        </span>
      </div>
      <div className="mt-2.5 h-2 overflow-hidden rounded-full bg-muted">
        <div
          className="relative h-full overflow-hidden rounded-full bg-primary transition-[width] duration-700 ease-out"
          style={{ width: `${percent}%` }}
        >
          {/* Progress is the WIDTH; the sweep only says "still moving", so a long
              phase doesn't read as a hung bar without faking advancement. */}
          <span className="absolute inset-0 animate-progress-sweep bg-gradient-to-r from-transparent via-primary-foreground/30 to-transparent" />
        </div>
      </div>
      {phaseLabel && (
        <p className="mt-2.5 truncate text-[13px] font-medium text-foreground">{phaseLabel}</p>
      )}
      <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="min-w-0 truncate">{metaLine}</span>
        {elapsed && (
          <span className="inline-flex shrink-0 items-center gap-1 font-mono tabular-nums">
            <Clock className="size-3" />
            {elapsed}
          </span>
        )}
      </div>
    </div>
  );
}

/** The chosen-configuration read-out (destination, endpoints, settings). */
function ConfigSummaryCard({ title, rows }: { title: string; rows: DeploySummaryRow[] }) {
  return (
    <div className="rounded-2xl border border-border/50 bg-card p-5">
      <h3 className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/70">
        {title}
      </h3>
      <dl className="mt-3 space-y-2.5">
        {rows.map((r) => (
          <div key={r.id} className="flex items-baseline justify-between gap-3">
            <dt className="max-w-[45%] shrink-0 truncate text-xs text-muted-foreground">
              {r.label}
            </dt>
            <dd
              className={`min-w-0 break-all text-end text-xs text-foreground ${
                r.mono ? "font-mono" : "font-medium"
              }`}
            >
              {r.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * The renderable lines of a log blob — trailing whitespace trimmed, blanks
 * dropped, capped at the last 400. Shared with the callers so a settled screen
 * can decide whether the panel is worth mounting AT ALL before mounting it: an
 * empty console is worse than no console, and the old `logs != null` guard let
 * `""` through (the wizard seeds `logs` with an empty string, never null).
 */
export function logLines(logs: string): string[] {
  return logs
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.length > 0)
    .slice(-400);
}

/**
 * Live log panel — a clean, theme-aware monospace console (an elevated surface
 * that adapts to light/dark, not a hardcoded black box) with a titlebar, a
 * "live" pulse while streaming, and auto-scroll to the newest line. All colors
 * are semantic tokens.
 */
function TerminalLogs({
  logs,
  live,
  label,
  emptyLabel,
  noTopMargin,
}: {
  logs: string;
  live: boolean;
  label: string;
  /** Placeholder for a panel with no lines yet. The caller picks the wording,
   *  because "waiting" is only true while something is still streaming — a
   *  settled install saying "Waiting for output…" is a promise nothing will
   *  keep. */
  emptyLabel: string;
  /** Drop the default top margin — the two-column install layout spaces it. */
  noTopMargin?: boolean;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => logLines(logs), [logs]);

  useEffect(() => {
    if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [lines.length]);

  return (
    <div
      className={`${noTopMargin ? "" : "mt-5 "}overflow-hidden rounded-xl border border-border/60 bg-muted/40`}
    >
      <div className="flex items-center gap-2 border-b border-border/50 px-3.5 py-2">
        <span className="flex gap-1.5">
          <span className="size-2.5 rounded-full bg-danger/60" />
          <span className="size-2.5 rounded-full bg-warning/60" />
          <span className="size-2.5 rounded-full bg-success/60" />
        </span>
        <span className="ms-1.5 font-mono text-[11px] tracking-wide text-muted-foreground">{label}</span>
        {live && (
          <span className="ms-auto inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-success">
            <span className="size-1.5 animate-pulse rounded-full bg-success-solid" />
            live
          </span>
        )}
      </div>
      <div
        ref={boxRef}
        className="max-h-72 overflow-auto p-3.5 font-mono text-[11.5px] leading-relaxed"
      >
        {lines.length === 0 ? (
          <span className="text-muted-foreground/70">{emptyLabel}</span>
        ) : (
          lines.map((l, i) => (
            <div key={i} className="flex gap-3">
              <span className="select-none text-muted-foreground/40 tabular-nums">
                {String(i + 1).padStart(3, " ")}
              </span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-all text-foreground/80">{l}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** Logs demoted to an on-demand detail: a Show/Hide toggle over the terminal
 *  panel, open by default so there's live feedback but foldable to keep the
 *  stepper the star. */
function CollapsibleLogs({
  logs,
  live,
  label,
  emptyLabel,
  showLabel,
  hideLabel,
}: {
  logs: string;
  live: boolean;
  label: string;
  emptyLabel: string;
  showLabel: string;
  hideLabel: string;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <div className="mb-2 flex justify-end">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="inline-flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          {open ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          {open ? hideLabel : showLabel}
        </button>
      </div>
      {open && (
        <TerminalLogs logs={logs} live={live} label={label} emptyLabel={emptyLabel} noTopMargin />
      )}
    </div>
  );
}

/** A static credentials block for an app whose first login is a known default
 *  (e.g. Grafana admin/admin). Not a resolved connection value — authored copy
 *  from the app JSON, so it sits beside the ConnectionCard, not inside it. */
function FirstLoginCard({
  title,
  userLabel,
  passLabel,
  firstLogin,
}: {
  title: string;
  userLabel: string;
  passLabel: string;
  firstLogin: { username?: string; password?: string; note?: string };
}) {
  return (
    <div className="rounded-2xl border border-border/50 bg-card p-5">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <div className="mt-4 grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2">
        {firstLogin.username != null && firstLogin.username !== "" && (
          <div className="min-w-0">
            <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              {userLabel}
            </label>
            <div className="mt-2 flex min-h-11 items-center rounded-xl bg-muted px-3.5">
              <code className="min-w-0 flex-1 truncate font-mono text-[13px] text-foreground">
                {firstLogin.username}
              </code>
            </div>
          </div>
        )}
        {firstLogin.password != null && firstLogin.password !== "" && (
          <div className="min-w-0">
            <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              {passLabel}
            </label>
            <div className="mt-2 flex min-h-11 items-center rounded-xl bg-muted px-3.5">
              <code className="min-w-0 flex-1 truncate font-mono text-[13px] text-foreground">
                {firstLogin.password}
              </code>
            </div>
          </div>
        )}
      </div>
      {firstLogin.note && (
        <p className="mt-3 text-xs leading-relaxed text-warning">{firstLogin.note}</p>
      )}
    </div>
  );
}

/**
 * The install progress view shared by the app wizards.
 *
 * Two shapes, chosen by whether `phases` is passed:
 *  - JSON-mapped install (app wizard): the project-detail layout — a fluid main
 *    column (phase stepper + demoted logs while installing; connection +
 *    first-login on the done screen; message + logs on failure/cancel) beside a
 *    fixed 340px sticky aside carrying the app summary, a status pill, and the
 *    phase's actions (Stop / Open app / Go to project). Mirrors the project page
 *    so the two read as one product.
 *  - Legacy (mail wizard, no `phases`): the original centered progress bar +
 *    terminal, left untouched.
 */
export function CleanDeployProgressCard({
  appId,
  title,
  description,
  phase,
  progress,
  phaseLabel,
  liveUrl,
  logs,
  errorMsg,
  deploymentId,
  onGoToProject,
  onViewBuild,
  onRetry,
  onStop,
  isStopping,
  cancelled,
  phases,
  services,
  appSetupSteps,
  firstLogin,
  connect,
  summary,
  startedAt,
}: {
  appId: string;
  title: string;
  /** App description — shown under the title while installing (header parity). */
  description?: string;
  phase: CleanDeployPhase;
  progress: number;
  phaseLabel: string;
  liveUrl: string | null;
  /** Plain build-log text (SSE-accumulated or status-poll) — powers the terminal. */
  logs?: string;
  errorMsg: string;
  deploymentId: string | null;
  onGoToProject: () => void;
  onViewBuild: () => void;
  onRetry: () => void;
  /** Cancel the in-flight install. Rendered as a Stop button while installing. */
  onStop?: () => void;
  /** The cancel request is in flight — disables Stop and shows a spinner. */
  isStopping?: boolean;
  /** `phase === "error"` was a user-initiated cancel, not a failure — swaps the
   *  copy + status token to a neutral "cancelled" reading. */
  cancelled?: boolean;
  /** Live install-phase status map. Presence switches on the JSON-mapped stepper
   *  layout; absent → the legacy progress-bar layout (mail wizard). */
  phases?: Partial<Record<InstallPhaseId, InstallPhaseStatus>>;
  /** Per-service statuses, rendered as the sub-list under the `services` phase. */
  services?: ServiceStatusEvent[];
  /** Authored app-setup steps (prepare-step titles), shown under `app-setup`. */
  appSetupSteps?: Array<{ id: string; label: string }>;
  /** Static default credentials (e.g. admin/admin) for the done screen. */
  firstLogin?: { username?: string; password?: string; note?: string };
  /** Resolved-connection card target for the done screen. */
  connect?: {
    projectId: string;
    appTemplateId?: string | null;
    serverId?: string | null;
    deployTarget?: string | null;
  };
  /** What this install was configured with, rendered in the aside. Rows the
   *  caller can't know (e.g. the destination after a mid-install refresh) are
   *  simply absent — never guessed. */
  summary?: DeploySummaryRow[];
  /** Epoch ms the install started, for the elapsed clock. Omit → no clock. */
  startedAt?: number | null;
}) {
  const { t } = useI18n();
  const w = t.projectSettings.appInstall;
  // Elapsed clock, ticked once in the parent because the progress panel renders
  // twice (sticky aside + the mobile inline card). `now` stays null until an
  // effect runs, so SSR emits no time rather than a frozen one.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (phase !== "installing") {
      setNow(null);
      return;
    }
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [phase]);
  const elapsed = startedAt != null && now != null ? formatElapsed(now - startedAt) : null;
  const liveHost = liveUrl ? liveUrl.replace(/^https?:\/\//, "") : null;
  // `phases` is the switch: the app wizard always passes its state object (even
  // empty → all-pending preview); the mail wizard passes nothing.
  const hasStepper = phases !== undefined;

  // ── The settled verdict, stated ONCE. Computed above the legacy early-return so
  // BOTH layouts get it — the mail wizard had the same stutter.
  //
  // The heading is the verdict; `errorMsg` is meant to be the reason under it. But
  // the wizard's own fallbacks hand the verdict straight back as the reason —
  // `stopInstall` used to set it to `installCancelled`, and a cancelled row whose
  // `failureMessage` the API blanked fell through to `installFailed`. That is how
  // "Install cancelled" came to sit over "Install failed". A reason that only
  // repeats the heading — or contradicts it — is not a reason: it's dropped, and
  // the body copy speaks instead.
  const settledHeading = cancelled ? w.installCancelled : w.installFailed;
  const serverReason =
    errorMsg && errorMsg.trim() !== w.installFailed && errorMsg.trim() !== w.installCancelled
      ? errorMsg
      : "";

  const statusLine =
    phase === "installing" ? phaseLabel : phase === "done" ? w.progressLive : settledHeading;

  // Header status glyph — spinner while working, then a terminal-state mark.
  const statusIcon =
    phase === "installing" ? (
      <Loader2 className="size-3.5 shrink-0 animate-spin" />
    ) : phase === "done" ? (
      <Check className="size-3.5 shrink-0 text-success" />
    ) : cancelled ? (
      <Ban className="size-3.5 shrink-0 text-muted-foreground" />
    ) : (
      <AlertTriangle className="size-3.5 shrink-0 text-danger" />
    );

  // ── Legacy mail wizard (no phase stepper): original centered layout, untouched.
  if (!hasStepper) {
    return (
      <PageContainer outerClassName="pb-20">
        <div className="mx-auto max-w-2xl pt-6">
          <div className="flex items-center gap-4">
            <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-muted/60">
              <AppLogo appId={appId} className="size-7 object-contain" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-xl font-semibold text-foreground">{title}</h1>
              <p className="mt-0.5 flex items-center gap-2 text-sm text-muted-foreground">
                {statusIcon}
                <span className="truncate">{statusLine}</span>
              </p>
            </div>
          </div>

          {phase === "installing" && (
            <>
              <div className="mt-5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-all duration-500"
                  style={{ width: `${Math.max(5, progress)}%` }}
                />
              </div>
              {logs != null && (
                <TerminalLogs
                  logs={logs}
                  live
                  label={w.deployLogs}
                  emptyLabel={w.logsWaiting}
                />
              )}
            </>
          )}

          {phase === "done" && (
            <div className="mt-6 space-y-4">
              <div className="rounded-2xl border border-border/50 bg-card p-6">
                <div className="flex size-10 items-center justify-center rounded-full bg-success-bg ring-4 ring-success/10">
                  <Check className="size-5 text-success" />
                </div>
                <h2 className="mt-4 text-base font-semibold text-foreground">{w.progressLive}</h2>
                {liveHost && (
                  <p className="mt-1 break-all font-mono text-xs text-muted-foreground/70">{liveHost}</p>
                )}
                <div className="mt-5 flex flex-col gap-2 sm:flex-row">
                  {liveUrl && (
                    <a
                      href={liveUrl.startsWith("http") ? liveUrl : `https://${liveUrl}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                    >
                      <ExternalLink className="size-4" /> {w.openApp}
                    </a>
                  )}
                  <button
                    type="button"
                    onClick={onGoToProject}
                    className="inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted/50"
                  >
                    {w.goToApp} <ArrowRight className="size-4 rtl:rotate-180" />
                  </button>
                </div>
              </div>
              {firstLogin && (firstLogin.username || firstLogin.password) && (
                <FirstLoginCard
                  title={w.firstLoginTitle}
                  userLabel={w.firstLoginUser}
                  passLabel={w.firstLoginPassword}
                  firstLogin={firstLogin}
                />
              )}
              {connect?.projectId && (
                <ConnectionCard
                  projectId={connect.projectId}
                  appTemplateId={connect.appTemplateId}
                  serverId={connect.serverId}
                  deployTarget={connect.deployTarget}
                />
              )}
            </div>
          )}

          {phase === "error" && (
            <div className="mt-6 rounded-2xl border border-border/50 bg-card p-6">
              {/* Tone follows the verdict, so a caller that starts passing
                  `cancelled` can't get a danger disc over neutral copy. */}
              <div
                className={`flex size-10 items-center justify-center rounded-full ${
                  cancelled ? "bg-muted ring-4 ring-border/30" : "bg-danger-bg ring-4 ring-danger/10"
                }`}
              >
                {cancelled ? (
                  <Ban className="size-5 text-muted-foreground" />
                ) : (
                  <AlertTriangle className="size-5 text-danger" />
                )}
              </div>
              <h2 className="mt-4 text-base font-semibold text-foreground">{settledHeading}</h2>
              {/* Same rule as the stepper layout: a reason that merely repeats the
                  verdict is dropped rather than printed under it. */}
              {serverReason && <p className="mt-1 text-sm text-muted-foreground">{serverReason}</p>}
              {/* Same rule as the stepper layout: a settled console with nothing in
                  it is mounted only when there is something to read. */}
              {logs != null && logLines(logs).length > 0 && (
                <TerminalLogs
                  logs={logs}
                  live={false}
                  label={w.deployLogs}
                  emptyLabel={w.logsEmpty}
                />
              )}
              <div className="mt-5 flex flex-col gap-2 sm:flex-row">
                {deploymentId && (
                  <button
                    type="button"
                    onClick={onViewBuild}
                    className="inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted/50"
                  >
                    <SlidersHorizontal className="size-4" /> {w.viewDetails}
                  </button>
                )}
                <button
                  type="button"
                  onClick={onRetry}
                  className="inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
                >
                  <ArrowLeft className="size-4 rtl:rotate-180" /> {w.back}
                </button>
              </div>
            </div>
          )}

          {description && phase === "installing" && (
            <p className="mt-4 text-center text-xs text-muted-foreground/50">{description}</p>
          )}
        </div>
      </PageContainer>
    );
  }

  // ── JSON-mapped install: build the phase stepper.
  const phaseLabelFor: Record<InstallPhaseId, string> = {
    images: w.phaseImages,
    services: w.phaseServices,
    "app-setup": w.phaseAppSetup,
    ready: w.phaseReady,
  };

  const serviceItems: StepItem[] = (services ?? []).map((s) => ({
    id: s.serviceId || s.serviceName,
    label: s.serviceName,
    status: serviceStatusToStep(s.status),
  }));
  const appSetupStatus: StepStatus = phases?.["app-setup"] ?? "pending";
  const appSetupItems: StepItem[] = (appSetupSteps ?? []).map((a) => ({
    id: a.id,
    label: a.label,
    status: appSetupStatus,
  }));
  // The app-setup phase only exists when the app has prepare steps — otherwise
  // it would hang "pending" forever after the deploy went live.
  const hasAppSetup = (appSetupSteps?.length ?? 0) > 0 || phases?.["app-setup"] != null;
  const phaseRows: PhaseRow[] = INSTALL_PHASES.filter(
    (p) => p.id !== "app-setup" || hasAppSetup,
  ).map((p) => ({
    id: p.id,
    label: phaseLabelFor[p.id],
    status: phases?.[p.id] ?? "pending",
    subs:
      p.id === "services"
        ? serviceItems.map((s) => s.status)
        : p.id === "app-setup"
          ? appSetupItems.map((s) => s.status)
          : [],
  }));
  /**
   * How a LEAF step (a service, an app-setup step) reads once the install has
   * stopped for good.
   *
   * A step left `active` must not keep spinning on a settled screen — that was the
   * same lie as a log panel still saying "Waiting for output…". What it becomes
   * depends on WHY the install stopped: on a failure the in-flight step is the one
   * that broke (`failed`, danger); on a cancel it is merely unfinished (`stopped`,
   * neutral) — a red step under "Install cancelled" reports a fault nobody caused.
   *
   * Cancels need the extra neutralising below: the SSE service union has no
   * `cancelled` member, so the API reports every torn-down service as `failed`,
   * which would paint a stopped install red from top to bottom.
   */
  const settleLeaf = (s: StepStatus): StepStatus => {
    if (s === "active" || s === "running") return cancelled ? "stopped" : "failed";
    if (cancelled && (s === "failed" || s === "error")) return "stopped";
    return s;
  };
  /**
   * How a PHASE reads once the install has stopped — `settleLeaf` plus the two
   * places the backend's own phase stream is more optimistic than the outcome:
   *
   *  - `ready` is broadcast `done` by the compose pipeline BEFORE the
   *    partial-failure roll-up is written, so a failed install rendered a green
   *    "Live" check directly under the heading "Install failed".
   *  - `services` closes `done` as soon as ONE service came up, so a partial
   *    failure showed a green check sitting above its own red child.
   *
   * Neither can stand on a screen whose verdict is "this did not finish".
   */
  const settlePhase = (row: PhaseRow): StepStatus => {
    const s = settleLeaf(row.status);
    if (s !== "done") return s;
    // The install never reached live, so the terminal phase is unreached, not done.
    if (row.id === "ready") return "stopped";
    if (row.subs.some((x) => x === "failed" || x === "error")) return cancelled ? "stopped" : "failed";
    return s;
  };
  const settled = phase === "error";
  const asSteps = (items: StepItem[]): StepItem[] =>
    items.map((i) => ({ ...i, status: settled ? settleLeaf(i.status) : i.status }));
  const settledRows: PhaseRow[] = phaseRows.map((p) => ({
    ...p,
    status: settled ? settlePhase(p) : p.status,
  }));
  const stepItems: StepItem[] = settledRows.map((p) => ({
    id: p.id,
    label: p.label,
    status: p.status,
    children:
      p.id === "services" && serviceItems.length > 0 ? (
        <InstallStepper steps={asSteps(serviceItems)} />
      ) : p.id === "app-setup" && appSetupItems.length > 0 ? (
        <InstallStepper steps={asSteps(appSetupItems)} />
      ) : undefined,
  }));
  // Whether the install got far enough for the checklist to say anything. All
  // -pending means it never started, or (on a resumed install) that the phase
  // stream was never replayed — either way an all-blank checklist is filler, and
  // the terminal screen is better short than padded.
  const anyPhaseMoved = phaseRows.some((p) => p.status !== "pending");

  // Aside status pill — theme tokens only, mirrors PROJECT_STATUS_META. Carries a
  // glyph rather than a bare dot: a coloured dot beside a word the header already
  // shows was decoration, and while installing the pill is replaced outright by
  // the live progress panel below.
  const pill =
    phase === "installing"
      ? {
          badge: "bg-info-bg text-info",
          icon: <Loader2 className="size-3 shrink-0 animate-spin" />,
          label: w.statusInstalling,
        }
      : phase === "done"
        ? {
            badge: "bg-success-bg text-success",
            icon: <Check className="size-3 shrink-0" />,
            label: w.statusLive,
          }
        : cancelled
          ? {
              badge: "bg-muted text-muted-foreground",
              icon: <Ban className="size-3 shrink-0" />,
              label: w.statusCancelled,
            }
          : {
              badge: "bg-danger-bg text-danger",
              icon: <AlertTriangle className="size-3 shrink-0" />,
              label: w.statusFailed,
            };

  // Live install readout for the aside (and the mobile card): the stepper's own
  // completion as a bar, the phase in flight, its step counter + service tally.
  const servicesDone = serviceItems.filter((s) => s.status === "done").length;
  const metaLine = [
    interpolate(w.progressStep, {
      current: String(installStepIndex(phaseRows)),
      total: String(phaseRows.length),
    }),
    serviceItems.length > 0
      ? interpolate(w.progressServicesReady, {
          done: String(servicesDone),
          total: String(serviceItems.length),
        })
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const progressPanel =
    phase === "installing" ? (
      <InstallProgressPanel
        title={w.statusInstalling}
        percent={installProgressPercent(phaseRows)}
        phaseLabel={phaseLabel}
        metaLine={metaLine}
        elapsed={elapsed}
      />
    ) : null;
  const summaryRows = summary ?? [];

  // With no server-side reason, a cancel was the user's own Stop — say so. With
  // one, it was NOT: the boot sweep writes "Interrupted by a server restart" and a
  // superseded release writes why. Attributing either to the operator would be a
  // fresh version of the lie this screen exists to stop telling.
  const settledDetail = serverReason || (cancelled ? w.installCancelledSelf : "");
  /**
   * The stand-in shown when we have no real reason to show.
   *
   * The cancel copy states what a cancel cleans up — and that is only true of the
   * teardown `cancelBuildSession` runs for a user's Stop. The system-side cancels
   * (the boot sweep, a superseded release) are a bare DB write that tears nothing
   * down, and those are exactly the ones that carry a `serverReason`. So the
   * presence of a reason is also the signal that the cleanup claim would be false,
   * and one condition correctly gates both.
   */
  const settledBody = serverReason ? "" : cancelled ? w.installCancelledBody : w.installFailedBody;
  /**
   * "Stopped at Starting services · 3 of 21 services ready" — where it stopped,
   * plus how many services made it. Neutral wording in both readings: on a cancel
   * nothing failed, and on a failure the checklist's own danger-toned row already
   * carries the fault.
   *
   * Only rendered when there IS a single stopping point. A compose pipeline can
   * carry on past a failed phase (a partial image build still deploys what built),
   * and naming the first failure then contradicts the checklist right beside it —
   * "Stopped at Preparing images" over a completed "Starting services". When
   * something succeeded after the break, the checklist alone tells the truth.
   */
  // `ready` is excluded: it's the "we got there" marker, never a phase you get
  // stuck inside, and settling always demotes it — naming it would read as
  // "Stopped at Live" on an install that plainly is not live.
  const stoppedIndex = settledRows.findIndex(
    (p) => p.id !== "ready" && (p.status === "failed" || p.status === "stopped"),
  );
  const ranPastTheBreak =
    stoppedIndex >= 0 && settledRows.slice(stoppedIndex + 1).some((p) => p.status === "done");
  const stoppedAtLine =
    phase === "error" && stoppedIndex >= 0 && !ranPastTheBreak
      ? [
          interpolate(w.settledAtPhase, { phase: settledRows[stoppedIndex].label }),
          serviceItems.length > 0
            ? interpolate(w.progressServicesReady, {
                done: String(servicesDone),
                total: String(serviceItems.length),
              })
            : "",
        ]
          .filter(Boolean)
          .join(" · ")
      : "";

  const btnPrimary =
    "inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90";
  const btnSecondary =
    "inline-flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted/50";
  const btnGhost =
    "inline-flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground";

  const openHref = liveUrl ? (liveUrl.startsWith("http") ? liveUrl : `https://${liveUrl}`) : null;

  // Phase actions — rendered once in the aside (desktop) and once in an inline
  // card (mobile, where the aside is hidden). Same handlers in both places.
  const actions =
    phase === "installing" ? (
      onStop ? (
        <button
          type="button"
          onClick={onStop}
          disabled={isStopping}
          className={`inline-flex w-full items-center justify-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-medium transition-colors ${
            isStopping
              ? "cursor-not-allowed border-border bg-muted text-muted-foreground"
              : "border-danger/20 bg-danger-bg text-danger hover:bg-danger/15"
          }`}
        >
          {isStopping ? <Loader2 className="size-4 animate-spin" /> : <Square className="size-4" />}
          {isStopping ? w.stopping : w.stopInstall}
        </button>
      ) : null
    ) : phase === "done" ? (
      <>
        {openHref && (
          <a href={openHref} target="_blank" rel="noreferrer" className={btnPrimary}>
            <ExternalLink className="size-4" /> {w.openApp}
          </a>
        )}
        <button type="button" onClick={onGoToProject} className={btnSecondary}>
          {w.goToApp} <ArrowRight className="size-4 rtl:rotate-180" />
        </button>
      </>
    ) : (
      <>
        {deploymentId && (
          <button type="button" onClick={onViewBuild} className={btnSecondary}>
            <SlidersHorizontal className="size-4" /> {w.viewDetails}
          </button>
        )}
        <button type="button" onClick={onRetry} className={btnGhost}>
          <ArrowLeft className="size-4 rtl:rotate-180" /> {cancelled ? w.startOver : w.back}
        </button>
      </>
    );

  const hasConnectSurface =
    !!connect?.projectId || !!(firstLogin && (firstLogin.username || firstLogin.password));

  const mainContent =
    phase === "installing" ? (
      <>
        <div className="rounded-2xl border border-border/50 bg-card p-5">
          <h2 className="text-sm font-semibold text-foreground">{w.stepperTitle}</h2>
          <div className="mt-4">
            <InstallStepper steps={stepItems} />
          </div>
        </div>
        <CollapsibleLogs
          logs={logs ?? ""}
          live
          label={w.deployLogs}
          emptyLabel={w.logsWaiting}
          showLabel={w.showLogs}
          hideLabel={w.hideLogs}
        />
      </>
    ) : phase === "done" ? (
      hasConnectSurface ? (
        <>
          {firstLogin && (firstLogin.username || firstLogin.password) && (
            <FirstLoginCard
              title={w.firstLoginTitle}
              userLabel={w.firstLoginUser}
              passLabel={w.firstLoginPassword}
              firstLogin={firstLogin}
            />
          )}
          {connect?.projectId && (
            <ConnectionCard
              projectId={connect.projectId}
              appTemplateId={connect.appTemplateId}
              serverId={connect.serverId}
              deployTarget={connect.deployTarget}
            />
          )}
        </>
      ) : (
        // Nothing to connect (e.g. an app with no connection block) — a compact
        // confirmation so the main column isn't empty.
        <div className="rounded-2xl border border-border/50 bg-card p-6">
          <div className="flex size-10 items-center justify-center rounded-full bg-success-bg ring-4 ring-success/10">
            <Check className="size-5 text-success" />
          </div>
          <h2 className="mt-4 text-base font-semibold text-foreground">{w.progressLive}</h2>
          {liveHost && (
            <p className="mt-1 break-all font-mono text-xs text-muted-foreground/70">{liveHost}</p>
          )}
        </div>
      )
    ) : (
      <>
        <div className="rounded-2xl border border-border/50 bg-card p-6">
          <div
            className={`flex size-10 items-center justify-center rounded-full ${
              cancelled ? "bg-muted ring-4 ring-border/30" : "bg-danger-bg ring-4 ring-danger/10"
            }`}
          >
            {cancelled ? (
              <Ban className="size-5 text-muted-foreground" />
            ) : (
              <AlertTriangle className="size-5 text-danger" />
            )}
          </div>
          <h2 className="mt-4 text-base font-semibold text-foreground">{settledHeading}</h2>
          {settledDetail && (
            <p className="mt-1 text-sm text-muted-foreground">{settledDetail}</p>
          )}
          {settledBody && (
            <p
              className={`text-[13px] leading-relaxed text-muted-foreground/80 ${
                settledDetail ? "mt-2" : "mt-1"
              }`}
            >
              {settledBody}
            </p>
          )}
          {stoppedAtLine && (
            <p className="mt-4 border-t border-border/40 pt-3 text-xs text-muted-foreground">
              {stoppedAtLine}
            </p>
          )}
        </div>
        {/* How far it got. This is the checklist the install was already showing
            when it stopped — dropping it on the terminal screen threw away the one
            thing that says WHERE it stopped, at the moment that matters most. */}
        {anyPhaseMoved && (
          <div className="rounded-2xl border border-border/50 bg-card p-5">
            <h2 className="text-sm font-semibold text-foreground">{w.stepperTitle}</h2>
            <div className="mt-4">
              <InstallStepper steps={stepItems} />
            </div>
          </div>
        )}
        {/* Mounted only when there is something to read — see `logLines`. */}
        {logs != null && logLines(logs).length > 0 && (
          <TerminalLogs
            logs={logs}
            live={false}
            label={w.deployLogs}
            emptyLabel={w.logsEmpty}
          />
        )}
      </>
    );

  return (
    <PageContainer outerClassName="pb-20">
      {/* Header — project-detail treatment (breadcrumb + 2xl title + status). */}
      <div className="mb-6">
        <div className="mb-2 flex items-center space-x-2 text-sm text-muted-foreground rtl:space-x-reverse">
          <a href="/apps/new" className="font-medium transition-colors hover:text-foreground">
            {w.breadcrumbApps}
          </a>
          <span>/</span>
          <span className="truncate font-medium text-foreground">{title}</span>
        </div>
        <div className="flex min-w-0 items-center gap-4">
          <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-muted/60">
            <AppLogo appId={appId} className="size-7 object-contain" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold text-foreground">{title}</h1>
            <p className="mt-0.5 flex items-center gap-2 text-sm text-muted-foreground">
              {statusIcon}
              <span className="truncate">{statusLine}</span>
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_340px]">
        {/* MAIN — the substance for the current phase. The aside is desktop-only,
            so its progress panel, actions and config read-out are mirrored here
            for narrow viewports. */}
        <div className="min-w-0 space-y-6">
          {mainContent}
          {(progressPanel || actions) && (
            <div className="space-y-3 rounded-2xl border border-border/50 bg-card p-4 lg:hidden">
              {progressPanel}
              {actions && <div className="space-y-2">{actions}</div>}
            </div>
          )}
          {summaryRows.length > 0 && (
            <div className="lg:hidden">
              <ConfigSummaryCard title={w.summaryTitle} rows={summaryRows} />
            </div>
          )}
        </div>

        {/* ASIDE — sticky summary + status + phase actions (desktop only). */}
        <div className="hidden lg:block">
          <div className="space-y-4 lg:sticky lg:top-6 lg:self-start">
            <div className="rounded-2xl border border-border/50 bg-card p-5">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl border border-border/50 bg-muted/40">
                  <AppLogo appId={appId} className="size-5 object-contain" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/70">
                    {w.appEyebrow}
                  </p>
                  <h3 className="truncate text-base font-semibold text-foreground">{title}</h3>
                </div>
              </div>
              {/* Installing → the live progress readout; settled → the status
                  pill, which now carries a real verdict rather than a dot. */}
              <div className="mt-4">
                {progressPanel ?? (
                  <span
                    className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${pill.badge}`}
                  >
                    {pill.icon}
                    {pill.label}
                  </span>
                )}
              </div>
              {phase === "done" && liveHost && (
                <p className="mt-3 break-all font-mono text-xs text-muted-foreground/70">{liveHost}</p>
              )}
              {actions && <div className="mt-4 space-y-2">{actions}</div>}
            </div>
            {summaryRows.length > 0 && (
              <ConfigSummaryCard title={w.summaryTitle} rows={summaryRows} />
            )}
          </div>
        </div>
      </div>
    </PageContainer>
  );
}
