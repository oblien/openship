"use client";

import React, { useState, useEffect, memo } from "react";
import { Clock, Cloud, Container, Hammer, Server } from "lucide-react";
import { useDeployment } from "@/context/DeploymentContext";
import {
  composeServiceTally,
  resolveBuildElapsedMs,
  type DeploymentStatus,
} from "@/context/deployment/types";
import { useI18n, interpolate } from "@/components/i18n-provider";
import type { Dictionary } from "@/i18n";
import { describeBuildStrategy } from "../deploy-target-label";
import { DeployTargetValue } from "../DeployTargetValue";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatTime(seconds: number) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

/**
 * One label/value line of the details list.
 *
 * MODULE SCOPE, not a closure inside the component: defined inline it was a new
 * function identity on every render, so React treated it as a different element
 * type and tore down + rebuilt every row's DOM instead of diffing it — once a
 * second, forever, because the elapsed-time interval re-renders this component on a
 * 1s tick. That lost text selection inside a row on every tick and stopped the
 * status pill's transitions from ever completing.
 *
 * No `truncate` here either. The value is a flex item, so `overflow:hidden` DOES
 * apply to it, and its height is just the text line box — while the status pill is
 * an inline child whose vertical padding and rounded border paint OUTSIDE that box,
 * so the pill's top and bottom got shaved flat. `nowrap` also stopped the service
 * tally wrapping, which silently ellipsised the (red) failed count off the end in
 * every locale longer than English. Rows that want clipping do it on their own
 * inner text span, where the box is the text.
 */
const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex items-center justify-between gap-3">
    <span className="shrink-0 text-sm text-muted-foreground">{label}</span>
    <span className="min-w-0 text-end text-sm font-normal text-foreground">{children}</span>
  </div>
);

/**
 * The status pill's tint + text colour. No border on any variant: the tinted fill
 * already separates the pill from the card, so an outline on top of it reads as a
 * control you can press. Same reason the cards here carry no resting border.
 */
function statusBadge(status: DeploymentStatus, hasWarning: boolean, t: Dictionary) {
  const s = t.importProject.composeSidebar.status;
  if (status === "failed" || status === "cancelled") {
    return {
      label: status === "cancelled" ? s.cancelled : s.failed,
      cls: "bg-destructive/10 text-destructive",
    };
  }
  if (hasWarning) {
    return {
      label: s.warnings,
      cls: "bg-warning-bg text-warning",
    };
  }
  if (status === "ready") {
    return { label: s.ready, cls: "bg-primary/10 text-primary" };
  }
  return { label: s.deploying, cls: "bg-primary/10 text-primary" };
}

// ─── Component ───────────────────────────────────────────────────────────────

const ComposeSidebar: React.FC = () => {
  const { state, config, deploymentStatus } = useDeployment();
  const { t } = useI18n();
  const sb = t.importProject.composeSidebar;
  // One section, shared with the logs-panel chip that renders the same sentence.
  const tally = t.importProject.composeServiceTally;

  const hasWarning = deploymentStatus === "ready" && !!state.warningMessage;
  const badge = statusBadge(deploymentStatus, hasWarning, t);

  // ── Build timer ──────────────────────────────────────────────────────
  const [elapsed, setElapsed] = useState<number>(() => {
    return Math.round(resolveBuildElapsedMs(state) / 1000);
  });

  useEffect(() => {
    setElapsed(Math.round(resolveBuildElapsedMs(state) / 1000));
  }, [
    state.buildDurationMs,
    state.buildStartedAt,
    state.buildRetryCarryMs,
    state.deploymentSuccess,
    state.deploymentFailed,
    state.deploymentCanceled,
  ]);

  useEffect(() => {
    if (state.deploymentSuccess || state.deploymentFailed || state.deploymentCanceled) return;
    const id = setInterval(() => setElapsed((p) => p + 1), 1000);
    return () => clearInterval(id);
  }, [state.deploymentSuccess, state.deploymentFailed, state.deploymentCanceled]);

  // ── Service counts ───────────────────────────────────────────────────
  // `built` (image done, container not up yet) is counted because during the build
  // phase the line otherwise reads "0/5 running" and never moves while four images
  // are already done — true, and useless. Shared with the logs-panel chip so the
  // two can't disagree about the same array.
  const services = state.serviceStatuses;
  const total = services.length;
  const { running, built, building, failed } = composeServiceTally(services);

  const TargetIcon = config.deployTarget === "cloud" ? Cloud : Server;

  return (
    <div className="bg-card rounded-2xl border border-border/50 p-6">
      <h3 className="text-base font-normal text-foreground mb-4">{sb.detailsTitle}</h3>
      <div className="space-y-3">
        <Row label={sb.rowStatus}>
          <span className={`text-sm font-normal px-3 py-1 rounded-full ${badge.cls}`}>
            {badge.label}
          </span>
        </Row>

        {/* WHERE it lands. Absent until now, which made this panel the only deploy
            screen that couldn't answer "which machine am I deploying to". */}
        <Row label={sb.rowTarget}>
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <TargetIcon className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
            <DeployTargetValue config={config} className="truncate" />
          </span>
        </Row>

        {/* WHERE it builds — a different question from the target (a server deploy
            can still build locally), and the one that explains a slow deploy. */}
        <Row label={sb.rowBuild}>
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <Hammer className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{describeBuildStrategy(config, t)}</span>
          </span>
        </Row>

        <Row label={sb.rowBuildTime}>
          <span className="inline-flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
            {formatTime(elapsed)}
          </span>
        </Row>

        {total > 0 && (
          <Row label={sb.rowServices}>
            {/* Allowed to wrap. With three counters this line is long in every
                locale wordier than English, and the FAILED count is last — a
                nowrap value ellipsised the one number that matters most off the
                end, so a failing deploy showed no failure here at all. */}
            <span className="inline-block">
              {running}/{total} {tally.running}
              {built > 0 && (
                <span className="ms-1">{interpolate(tally.builtSuffix, { count: String(built) })}</span>
              )}
              {building > 0 && (
                <span className="ms-1">{interpolate(tally.buildingSuffix, { count: String(building) })}</span>
              )}
              {failed > 0 && (
                <span className="text-destructive ms-1">{interpolate(tally.failedSuffix, { count: String(failed) })}</span>
              )}
            </span>
          </Row>
        )}

        <Row label={sb.rowProject}>
          <span className="block truncate">
            {config.projectName || `${config.owner}/${config.repo}`}
          </span>
        </Row>

        <Row label={sb.rowType}>
          <span className="inline-flex items-center gap-1.5">
            <Container className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
            Compose
          </span>
        </Row>
      </div>
    </div>
  );
};

export default memo(ComposeSidebar);
