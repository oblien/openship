"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import React, { useEffect, useRef, useState } from "react";
import { useBackupRunStream } from "@/hooks/useBackupRunStream";
import { useI18n } from "@/components/i18n-provider";
import type { BackupRun } from "@/lib/api";
import { isBackupRunning, latestBackupRun } from "@/lib/backup-run-state";
import { formatBytes } from "@/lib/formatBytes";
import { BackupStreamNotice } from "./BackupStreamNotice";

type RunCardDict = ReturnType<typeof useI18n>["t"]["widgets"]["backup"]["runCard"];

interface Props {
  runId: string;
  /** Optional snapshot — when provided, we render immediately and let
   *  the stream upgrade in place. Avoids a "loading…" flash for
   *  already-known runs. */
  initial?: BackupRun;
  serviceName?: string;
  /** Keep tracking a dismissed active run without rendering its details. */
  visible?: boolean;
  onUpdate?: (run: BackupRun) => void;
  onClose?: () => void;
  onComplete?: () => void | Promise<void>;
}

export function BackupRunCard({
  runId,
  initial,
  serviceName,
  visible = true,
  onUpdate,
  onComplete,
}: Props): React.JSX.Element | null {
  const known = initial?.id === runId ? initial : null;
  const stream = useBackupRunStream(known && !isBackupRunning(known) ? null : runId);
  const { run: streamed, connected } = stream;
  const { t } = useI18n();
  const w = t.widgets.backup.runCard;
  const run = latestBackupRun(known, streamed);
  const inFlight = !!run && isBackupRunning(run);
  const [now, setNow] = useState(Date.now);
  const completedRun = useRef<string | null>(null);

  useEffect(() => {
    if (run) onUpdate?.(run);
  }, [run, onUpdate]);

  useEffect(() => {
    if (!run || run.id !== runId || completedRun.current === runId || inFlight) return;
    completedRun.current = runId;
    void onComplete?.();
  }, [run, runId, inFlight, onComplete]);

  useEffect(() => {
    if (!inFlight || !visible) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [runId, inFlight, visible]);

  if (!visible) return null;

  if (!run) {
    return (
      <div className="rounded-2xl border border-border/50 bg-card p-4 text-sm text-muted-foreground">
        {w.loading}
        <BackupStreamNotice stream={stream} />
      </div>
    );
  }

  const StatusIcon =
    run.status === "succeeded"
      ? "check-circle"
      : ["failed", "server_error", "cancelled"].includes(run.status)
        ? "x-circle"
        : "spinner";
  const color =
    run.status === "succeeded"
      ? "text-success"
      : ["failed", "server_error", "cancelled"].includes(run.status)
        ? "text-danger"
        : "text-info";

  return (
    <div className="rounded-2xl border border-border/50 bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {serviceName && (
            <span className="truncate text-sm font-medium text-foreground">{serviceName}</span>
          )}
          <UiIcon
            name={StatusIcon}
            className={`size-4 ${color} ${inFlight ? "animate-spin" : ""}`}
          />
          <span className={`text-sm font-medium ${color}`}>{labelFor(run.status, w)}</span>
          <span className="text-xs text-muted-foreground">
            {t.projectSettings.backup.recent.triggers[run.triggeredBy]}
          </span>
        </div>
        {connected && inFlight && (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <UiIcon name="activity" className="size-3 animate-pulse" />
            {w.live}
          </span>
        )}
      </div>

      <BackupStreamNotice stream={stream} />

      <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
        <Stat label={w.started} value={new Date(run.startedAt).toLocaleString()} />
        <Stat
          label={w.elapsed}
          value={formatElapsed(
            Date.parse(run.startedAt),
            run.finishedAt ? Date.parse(run.finishedAt) : now,
          )}
        />
        <Stat
          label={w.bytes}
          value={run.bytesTransferred == null ? "—" : formatBytes(run.bytesTransferred)}
        />
        <Stat
          label={w.runId}
          value={
            <code className="text-xs" title={run.id}>
              {run.id.slice(0, 16)}…
            </code>
          }
        />
      </div>

      {run.errorMessage && (
        <p className="mt-3 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">
          {run.errorMessage}
        </p>
      )}

      {inFlight && (
        <p role="status" className="mt-3 text-sm text-muted-foreground">
          {phaseLabel(run.status, w)}
        </p>
      )}
      {run.finishedAt && (
        <p className="mt-3 text-xs text-muted-foreground">
          {w.finished}:{" "}
          <time dateTime={run.finishedAt}>{new Date(run.finishedAt).toLocaleString()}</time>
        </p>
      )}
    </div>
  );
}

function labelFor(status: BackupRun["status"], w: RunCardDict): string {
  switch (status) {
    case "queued":
      return w.status.queued;
    case "preparing":
      return w.status.preparing;
    case "snapshotting":
      return w.status.snapshotting;
    case "uploading":
      return w.status.uploading;
    case "verifying":
      return w.status.verifying;
    case "succeeded":
      return w.status.succeeded;
    case "failed":
      return w.status.failed;
    case "cancelled":
      return w.status.cancelled;
    case "server_error":
      return w.status.serverError;
  }
}

function phaseLabel(status: BackupRun["status"], w: RunCardDict): string {
  switch (status) {
    case "queued":
      return w.phase.queued;
    case "preparing":
      return w.phase.preparing;
    case "snapshotting":
      return w.phase.snapshotting;
    case "uploading":
      return w.phase.uploading;
    case "verifying":
      return w.phase.verifying;
    default:
      return "";
  }
}

function Stat({ label, value }: { label: string; value: React.ReactNode }): React.JSX.Element {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-sm text-foreground">{value}</p>
    </div>
  );
}

function formatElapsed(startMs: number, endMs: number): string {
  const s = Math.max(0, Math.floor((endMs - startMs) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
