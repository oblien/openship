"use client";

import React, { useState, useEffect, memo } from "react";
import { Clock, Container } from "lucide-react";
import { useDeployment } from "@/context/DeploymentContext";
import type { DeploymentStatus } from "@/context/deployment/types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatTime(seconds: number) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function statusBadge(status: DeploymentStatus, hasWarning: boolean) {
  if (status === "failed" || status === "cancelled") {
    return {
      label: status === "cancelled" ? "Cancelled" : "Failed",
      cls: "bg-destructive/10 text-destructive border-destructive/20",
    };
  }
  if (hasWarning) {
    return {
      label: "Warnings",
      cls: "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/20",
    };
  }
  if (status === "ready") {
    return { label: "Ready", cls: "bg-primary/10 text-primary border-primary/20" };
  }
  return { label: "Deploying", cls: "bg-primary/10 text-primary border-primary/20" };
}

// ─── Component ───────────────────────────────────────────────────────────────

const ComposeSidebar: React.FC = () => {
  const { state, config, deploymentStatus } = useDeployment();

  const hasWarning = deploymentStatus === "ready" && !!state.warningMessage;
  const badge = statusBadge(deploymentStatus, hasWarning);

  // ── Build timer ──────────────────────────────────────────────────────
  const [elapsed, setElapsed] = useState<number>(() => {
    if (state.buildDurationMs) return Math.round(state.buildDurationMs / 1000);
    if (state.buildStartedAt) {
      return Math.max(0, Math.round((Date.now() - new Date(state.buildStartedAt).getTime()) / 1000));
    }
    return 0;
  });

  useEffect(() => {
    if (state.buildDurationMs && (state.deploymentSuccess || state.deploymentFailed || state.deploymentCanceled)) {
      setElapsed(Math.round(state.buildDurationMs / 1000));
    }
  }, [state.buildDurationMs, state.deploymentSuccess, state.deploymentFailed, state.deploymentCanceled]);

  useEffect(() => {
    if (state.deploymentSuccess || state.deploymentFailed || state.deploymentCanceled) return;
    const id = setInterval(() => setElapsed((p) => p + 1), 1000);
    return () => clearInterval(id);
  }, [state.deploymentSuccess, state.deploymentFailed, state.deploymentCanceled]);

  // ── Service counts ───────────────────────────────────────────────────
  const services = state.serviceStatuses;
  const total = services.length;
  const running = services.filter((s) => s.status === "running").length;
  const building = services.filter((s) => s.status === "building").length;
  const failed = services.filter((s) => s.status === "failed").length;

  // ── Row component ────────────────────────────────────────────────────
  const Row: React.FC<{
    label: string;
    children: React.ReactNode;
    border?: boolean;
  }> = ({ label, children, border = true }) => (
    <div className={`flex justify-between items-center py-1.5 ${border ? "border-b border-border/50" : ""}`}>
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-normal text-foreground">{children}</span>
    </div>
  );

  return (
    <div className="bg-card rounded-2xl border border-border/50 p-6">
      <h3 className="text-base font-normal text-foreground mb-3">Deployment Details</h3>
      <div className="space-y-0">
        <Row label="Status">
          <span className={`text-sm font-normal px-3 py-1 rounded-full border ${badge.cls}`}>
            {badge.label}
          </span>
        </Row>

        <Row label="Build Time">
          <span className="flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5 text-muted-foreground" />
            {formatTime(elapsed)}
          </span>
        </Row>

        {total > 0 && (
          <Row label="Services">
            <span>
              {running}/{total} running
              {building > 0 && (
                <span className="ml-1">· {building} building</span>
              )}
              {failed > 0 && (
                <span className="text-destructive ml-1">· {failed} failed</span>
              )}
            </span>
          </Row>
        )}

        <Row label="Project">
          {config.projectName || `${config.owner}/${config.repo}`}
        </Row>

        <Row label="Type" border={false}>
          <span className="flex items-center gap-1.5">
            <Container className="w-3.5 h-3.5 text-muted-foreground" />
            Compose
          </span>
        </Row>
      </div>
    </div>
  );
};

export default memo(ComposeSidebar);
