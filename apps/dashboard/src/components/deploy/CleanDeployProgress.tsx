"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { INSTALL_PHASES, type InstallPhaseId, type InstallPhaseStatus } from "@repo/core";
import { AppLogo } from "@/components/AppLogo";
import { PageContainer } from "@/components/ui/PageContainer";
import { Button } from "@/components/ui/button";
import { DeploymentLayout } from "@/components/import-project/DeploymentLayout";
import { DeploymentLogsPanel } from "@/components/import-project/DeploymentLogsPanel";
import { LogSnapshotTerminal } from "@/components/import-project/LogSnapshotTerminal";
import { ServiceStatusIndicator } from "@/components/services/ServiceStatusBadge";
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
        <span className="inline-flex min-w-0 items-center gap-1.5 text-sm font-semibold text-foreground">
          <UiIcon name="spinner" className="size-3.5 shrink-0 animate-spin text-primary" />
          <span className="truncate">{title}</span>
        </span>
        <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
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
        <p className="mt-2.5 truncate text-sm font-medium text-foreground">{phaseLabel}</p>
      )}
      <div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 truncate">{metaLine}</span>
        {elapsed && (
          <span className="inline-flex shrink-0 items-center gap-1 font-mono tabular-nums">
            <UiIcon name="clock" className="size-3" />
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
    <div className="rounded-2xl bg-card p-5">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
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

/** Reuse the deployment console and its search/copy controls. The installer
 * already owns the log stream, so the console only renders that snapshot. */
function TerminalLogs({
  logs,
  live,
  label,
  emptyLabel,
}: {
  logs: string;
  live: boolean;
  label: string;
  emptyLabel: string;
}) {
  return (
    <DeploymentLogsPanel
      title={label}
      summary={live ? <ServiceStatusIndicator status="deploying" /> : undefined}
    >
      <LogSnapshotTerminal logs={logs} emptyLabel={emptyLabel} />
    </DeploymentLogsPanel>
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
    <div className="rounded-2xl bg-card p-5">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <div className="mt-4 grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2">
        {firstLogin.username != null && firstLogin.username !== "" && (
          <div className="min-w-0">
            <label className="text-sm font-medium text-muted-foreground">{userLabel}</label>
            <div className="mt-2 flex min-h-11 items-center rounded-xl bg-muted px-3.5">
              <code className="min-w-0 flex-1 truncate font-mono text-sm text-foreground">
                {firstLogin.username}
              </code>
            </div>
          </div>
        )}
        {firstLogin.password != null && firstLogin.password !== "" && (
          <div className="min-w-0">
            <label className="text-sm font-medium text-muted-foreground">{passLabel}</label>
            <div className="mt-2 flex min-h-11 items-center rounded-xl bg-muted px-3.5">
              <code className="min-w-0 flex-1 truncate font-mono text-sm text-foreground">
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

/** App installs share the deployment layout and console while keeping their
 * catalog-authored phases and connection details. The mail wizard supplies a
 * numeric progress value instead of phase events and retains its compact layout. */
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
  recoveryAction,
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
  /** Reopen actionable billing/capacity recovery without discarding the logs. */
  recoveryAction?: { label: string; onClick: () => void; pending?: boolean };
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
  // Keep the elapsed clock tied to the real installation start time.
  // SSR omits it until the first client tick.
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
      <UiIcon name="spinner" className="size-3.5 shrink-0 animate-spin" />
    ) : phase === "done" ? (
      <UiIcon name="check" className="size-3.5 shrink-0 text-success" />
    ) : cancelled ? (
      <UiIcon name="ban" className="size-3.5 shrink-0 text-muted-foreground" />
    ) : (
      <UiIcon name="warning" className="size-3.5 shrink-0 text-danger" />
    );

  // The mail wizard has no phase stream; retain its compact progress layout.
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
                <TerminalLogs logs={logs} live label={t.importProject.composeDeployment.logsTitle} emptyLabel={w.logsWaiting} />
              )}
            </>
          )}

          {phase === "done" && (
            <div className="mt-6 space-y-4">
              <div className="rounded-2xl bg-card p-6">
                <div className="flex size-10 items-center justify-center rounded-full bg-success-bg ring-4 ring-success/10">
                  <UiIcon name="check" className="size-5 text-success" />
                </div>
                <h2 className="mt-4 text-base font-semibold text-foreground">{w.progressLive}</h2>
                {liveHost && (
                  <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                    {liveHost}
                  </p>
                )}
                <div className="mt-5 flex flex-col gap-2 sm:flex-row">
                  {liveUrl && (
                    <a
                      href={liveUrl.startsWith("http") ? liveUrl : `https://${liveUrl}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                    >
                      <UiIcon name="arrow-up-right" className="size-4" /> {w.openApp}
                    </a>
                  )}
                  <button
                    type="button"
                    onClick={onGoToProject}
                    className="inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted/50"
                  >
                    {w.goToApp} <UiIcon name="arrow-right" className="size-4 rtl:rotate-180" />
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
            <div className="mt-6 rounded-2xl bg-card p-6">
              {/* Tone follows the verdict, so a caller that starts passing
                  `cancelled` can't get a danger disc over neutral copy. */}
              <div
                className={`flex size-10 items-center justify-center rounded-full ${
                  cancelled
                    ? "bg-muted ring-4 ring-border/30"
                    : "bg-danger-bg ring-4 ring-danger/10"
                }`}
              >
                {cancelled ? (
                  <UiIcon name="ban" className="size-5 text-muted-foreground" />
                ) : (
                  <UiIcon name="warning" className="size-5 text-danger" />
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
                  label={t.importProject.composeDeployment.logsTitle}
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
                    <UiIcon name="sliders" className="size-4" /> {w.viewDetails}
                  </button>
                )}
                {recoveryAction && !cancelled && (
                  <Button type="button" disabled={recoveryAction.pending} onClick={recoveryAction.onClick}>
                    {recoveryAction.label}
                  </Button>
                )}
                <button
                  type="button"
                  onClick={onRetry}
                  className="inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
                >
                  <UiIcon name="arrow-left" className="size-4 rtl:rotate-180" /> {w.back}
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
    if (row.subs.some((x) => x === "failed" || x === "error"))
      return cancelled ? "stopped" : "failed";
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
        <InstallStepper steps={asSteps(serviceItems)} columns={2} />
      ) : p.id === "app-setup" && appSetupItems.length > 0 ? (
        <InstallStepper steps={asSteps(appSetupItems)} />
      ) : undefined,
  }));
  // Whether the install got far enough for the checklist to say anything. All
  // -pending means it never started, or (on a resumed install) that the phase
  // stream was never replayed — either way an all-blank checklist is filler, and
  // the terminal screen is better short than padded.
  const anyPhaseMoved = phaseRows.some((p) => p.status !== "pending");

  // Header status uses the same semantic tokens as the project overview.
  const pill =
    phase === "installing"
      ? {
          badge: "bg-info-bg text-info",
          icon: <UiIcon name="spinner" className="size-3 shrink-0 animate-spin" />,
          label: w.statusInstalling,
        }
      : phase === "done"
        ? {
            badge: "bg-success-bg text-success",
            icon: <UiIcon name="check" className="size-3 shrink-0" />,
            label: w.statusLive,
          }
        : cancelled
          ? {
              badge: "bg-muted text-muted-foreground",
              icon: <UiIcon name="ban" className="size-3 shrink-0" />,
              label: w.statusCancelled,
            }
          : {
              badge: "bg-danger-bg text-danger",
              icon: <UiIcon name="warning" className="size-3 shrink-0" />,
              label: w.statusFailed,
            };

  // Live install readout for the aside: the stepper's own
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
        title={w.stepperTitle}
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

  const openHref = liveUrl ? (liveUrl.startsWith("http") ? liveUrl : `https://${liveUrl}`) : null;
  const hasConnectSurface =
    !!connect?.projectId || !!(firstLogin && (firstLogin.username || firstLogin.password));
  const showSteps = phase === "installing" || (phase === "error" && anyPhaseMoved);

  const stepper = showSteps ? (
    <section className="rounded-2xl bg-card p-5">
      {progressPanel ?? <h2 className="text-sm font-semibold text-foreground">{w.stepperTitle}</h2>}
      <div className="mt-5 max-h-96 overflow-y-auto">
        <InstallStepper steps={stepItems} />
      </div>
    </section>
  ) : null;
  const details = (
    <div className="space-y-4">
      {summaryRows.length > 0 && <ConfigSummaryCard title={w.summaryTitle} rows={summaryRows} />}
      {deploymentId && (
        <Button type="button" variant="ghost" onClick={onViewBuild} className="w-full">
          {w.viewDetails}
          <UiIcon name="arrow-up-right" aria-hidden className="size-3.5" />
        </Button>
      )}
    </div>
  );

  return (
    <PageContainer outerClassName="pb-20">
      <header className="mb-6 space-y-4">
        <nav
          aria-label={w.breadcrumbApps}
          className="flex min-w-0 items-center gap-3 text-sm text-muted-foreground"
        >
          <Link
            href="/apps/new"
            className="inline-flex shrink-0 items-center gap-1.5 transition-colors hover:text-foreground"
          >
            <UiIcon name="arrow-left" aria-hidden className="size-4 rtl:rotate-180" />
            {w.breadcrumbApps}
          </Link>
          {deploymentId && (
            <>
              <span aria-hidden className="text-border">
                /
              </span>
              <span aria-current="page" className="truncate font-mono text-xs" title={deploymentId}>
                {deploymentId}
              </span>
            </>
          )}
        </nav>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 flex-1 basis-72 items-center gap-3">
            <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-card">
              <AppLogo appId={appId} className="size-7 object-contain" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="min-w-0 break-words text-2xl font-medium text-foreground">
                  {title}
                </h1>
                <span
                  className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${pill.badge}`}
                >
                  {pill.icon}
                  {pill.label}
                </span>
              </div>
              {description && (
                <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{description}</p>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {phase === "error" && !cancelled && recoveryAction && (
              <Button type="button" disabled={recoveryAction.pending} onClick={recoveryAction.onClick}>
                {recoveryAction.label}
              </Button>
            )}
            {phase === "error" && (
              <Button type="button" variant="ghost" onClick={onRetry}>
                <UiIcon name="arrow-left" aria-hidden className="size-4 rtl:rotate-180" />
                {cancelled ? w.startOver : w.back}
              </Button>
            )}
            {deploymentId && (
              <Button type="button" variant="secondary" onClick={onGoToProject}>
                {w.goToApp}
                <UiIcon name="arrow-right" aria-hidden className="size-4 rtl:rotate-180" />
              </Button>
            )}
            {phase === "done" && openHref && (
              <Button asChild>
                <a href={openHref} target="_blank" rel="noreferrer">
                  {w.openApp}
                  <UiIcon name="arrow-up-right" aria-hidden className="size-3.5" />
                </a>
              </Button>
            )}
            {phase === "installing" && onStop && (
              <Button
                type="button"
                variant="secondary"
                onClick={onStop}
                disabled={isStopping}
                className="text-danger"
              >
                <UiIcon
                  name={isStopping ? "spinner" : "square"}
                  aria-hidden
                  className={`size-4 ${isStopping ? "motion-safe:animate-spin" : ""}`}
                />
                {isStopping ? w.stopping : w.stopInstall}
              </Button>
            )}
          </div>
        </div>
      </header>

      <DeploymentLayout navigation={stepper ?? details} details={stepper ? details : null}>
        {phase === "error" && (
          <section className="space-y-3 rounded-2xl bg-card p-5">
            <h2
              className={`text-base font-semibold ${cancelled ? "text-foreground" : "text-danger"}`}
            >
              {settledHeading}
            </h2>
            {settledDetail && (
              <p className="break-words text-sm leading-relaxed text-muted-foreground">
                {settledDetail}
              </p>
            )}
            {settledBody && (
              <p className="text-sm leading-relaxed text-muted-foreground">{settledBody}</p>
            )}
            {stoppedAtLine && <p className="text-xs text-muted-foreground">{stoppedAtLine}</p>}
          </section>
        )}
        {(phase === "installing" || (phase === "error" && logs && logLines(logs).length > 0)) && (
          <TerminalLogs
            logs={logs ?? ""}
            live={phase === "installing"}
            label={t.importProject.composeDeployment.logsTitle}
            emptyLabel={phase === "installing" ? w.logsWaiting : w.logsEmpty}
          />
        )}
        {phase === "done" && (
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
            {!hasConnectSurface && (
              <section className="space-y-2 rounded-2xl bg-card p-5">
                <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
                  <UiIcon name="check-circle" aria-hidden className="size-5 text-success" />
                  {w.progressLive}
                </h2>
                {liveHost && (
                  <p dir="ltr" className="break-all font-mono text-sm text-muted-foreground">
                    {liveHost}
                  </p>
                )}
              </section>
            )}
          </>
        )}
      </DeploymentLayout>
    </PageContainer>
  );
}
