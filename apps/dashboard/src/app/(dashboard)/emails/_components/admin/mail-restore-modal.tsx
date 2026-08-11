"use client";

/**
 * Mail restore / migrate wizard. Reuses the shared restore engine
 * (backupsApi.prepareRestore/applyRestore + the useRestoreRunStream SSE
 * hook) — only the confirm step (type the domain) and, for migration, the
 * target-server picker are mail-specific.
 *
 *   mode "in_place"  → restore the backup onto THIS mail server.
 *   mode "to_fork"   → migrate: restore onto a DIFFERENT mail server.
 *
 * Both are destructive on the target: its accounts are TRUNCATED before the
 * backup's data loads.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  X,
  Loader2,
  AlertTriangle,
  Check,
  CircleX,
  Server as ServerIcon,
} from "lucide-react";
import {
  mailApi,
  backupsApi,
  getApiErrorMessage,
  type BackupRun,
} from "@/lib/api";
import { useRestoreRunStream } from "@/hooks/useRestoreRunStream";
import { useI18n, interpolate } from "@/components/i18n-provider";

interface MailServerOption {
  id: string;
  name: string;
  host: string;
  domain: string | null;
  completed: boolean;
}

export function MailRestoreModal({
  run,
  mode,
  sourceServerId,
  domain,
  onClose,
  onDone,
}: {
  run: BackupRun;
  mode: "in_place" | "to_fork";
  sourceServerId: string;
  domain: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const [targets, setTargets] = useState<MailServerOption[]>([]);
  const [targetId, setTargetId] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [phase, setPhase] = useState<"review" | "running">("review");
  const [restoreId, setRestoreId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tokenRef = useRef<string | null>(null);
  const appliedRef = useRef(false);

  const { restore } = useRestoreRunStream(restoreId);

  // Migration target list: OTHER installed mail servers.
  useEffect(() => {
    if (mode !== "to_fork") return;
    mailApi
      .listMailServers()
      .then(({ servers }) =>
        setTargets(
          servers
            .filter((s) => s.id !== sourceServerId && s.completed)
            .map((s) => ({ id: s.id, name: s.name, host: s.host, domain: s.domain, completed: s.completed })),
        ),
      )
      .catch(() => {});
  }, [mode, sourceServerId]);

  const canStart =
    confirmText.trim() === domain && (mode === "in_place" || !!targetId);

  const start = useCallback(async () => {
    setError(null);
    try {
      const { data } = await backupsApi.prepareRestore(run.id, {
        mode,
        forkMailServerId: mode === "to_fork" ? targetId : null,
      });
      tokenRef.current = data.confirmationToken;
      setRestoreId(data.restoreId);
      setPhase("running");
    } catch (err) {
      setError(getApiErrorMessage(err, t.emailsAdmin.restore.startFailed));
    }
  }, [run.id, mode, targetId]);

  // Auto-apply once the plan is prepared (verified downloadable).
  useEffect(() => {
    if (!restoreId || !tokenRef.current || appliedRef.current) return;
    if (restore?.status === "prepared") {
      appliedRef.current = true;
      backupsApi.applyRestore(restoreId, tokenRef.current).catch((err) => {
        setError(getApiErrorMessage(err, t.emailsAdmin.restore.applyFailed));
      });
    }
  }, [restore?.status, restoreId]);

  const status = restore?.status;
  const done = status === "succeeded";
  const failed = status === "failed" || status === "server_error" || status === "cancelled";
  const busy = phase === "running" && !done && !failed;

  useEffect(() => {
    if (done) onDone();
  }, [done, onDone]);

  const title = mode === "to_fork" ? t.emailsAdmin.restore.titleMigrate : t.emailsAdmin.restore.titleRestore;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-2xl border border-border/60 bg-card shadow-xl">
        <div className="flex items-center justify-between border-b border-border/50 px-5 py-4">
          <h3 className="text-base font-semibold text-foreground">{title}</h3>
          <button
            onClick={onClose}
            disabled={busy}
            className="text-muted-foreground hover:text-foreground disabled:opacity-40"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {phase === "review" ? (
            <ReviewStep
              mode={mode}
              domain={domain}
              targets={targets}
              targetId={targetId}
              setTargetId={setTargetId}
              confirmText={confirmText}
              setConfirmText={setConfirmText}
              backupDate={run.startedAt}
            />
          ) : (
            <ProgressStep status={status} domain={domain} />
          )}

          {error && (
            <div className="rounded-xl border border-danger-border bg-danger-bg px-3.5 py-2.5 text-sm text-danger">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-border/50 px-5 py-4">
          {done || failed ? (
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm font-semibold rounded-xl bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {t.emailsAdmin.restore.close}
            </button>
          ) : (
            <>
              <button
                onClick={onClose}
                disabled={busy}
                className="px-4 py-2 text-sm font-semibold rounded-xl bg-muted text-foreground hover:bg-muted/80 border border-border disabled:opacity-50"
              >
                {t.emailsAdmin.restore.cancel}
              </button>
              <button
                onClick={start}
                disabled={!canStart || phase === "running"}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-xl bg-danger-solid text-white hover:bg-danger-solid/90 disabled:opacity-50"
              >
                {phase === "running" && <Loader2 className="size-3.5 animate-spin" />}
                {mode === "to_fork" ? t.emailsAdmin.restore.migrate : t.emailsAdmin.restore.restore}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ReviewStep({
  mode,
  domain,
  targets,
  targetId,
  setTargetId,
  confirmText,
  setConfirmText,
  backupDate,
}: {
  mode: "in_place" | "to_fork";
  domain: string;
  targets: MailServerOption[];
  targetId: string;
  setTargetId: (v: string) => void;
  confirmText: string;
  setConfirmText: (v: string) => void;
  backupDate: string;
}) {
  const { t } = useI18n();
  const r = t.emailsAdmin.restore;
  return (
    <>
      <p className="text-sm text-muted-foreground leading-relaxed">
        {r.reviewBefore}
        <span className="font-medium text-foreground">
          {new Date(backupDate).toLocaleString()}
        </span>
        {mode === "to_fork" ? r.reviewOntoFork : r.reviewOntoInPlace}
      </p>

      {mode === "to_fork" && (
        <label className="block">
          <span className="block text-sm font-medium text-foreground mb-1.5">{r.targetServer}</span>
          {targets.length === 0 ? (
            <p className="text-xs text-muted-foreground rounded-xl border border-border/60 bg-muted/20 px-3.5 py-2.5">
              {r.noTargetsBefore}<span className="font-mono">{domain}</span>{r.noTargetsAfter}
            </p>
          ) : (
            <select
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              className="w-full px-3 py-2 text-sm rounded-xl border border-border bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
            >
              <option value="">{r.selectServer}</option>
              {targets.map((srv) => (
                <option key={srv.id} value={srv.id}>
                  {srv.domain || srv.name} · {srv.host}
                </option>
              ))}
            </select>
          )}
        </label>
      )}

      <div className="flex items-start gap-2 rounded-xl border border-warning-border bg-warning-bg px-3.5 py-2.5">
        <AlertTriangle className="size-4 text-warning mt-0.5 shrink-0" />
        <p className="text-xs text-warning leading-relaxed">
          {interpolate(r.warnMain, { which: mode === "to_fork" ? r.warnWhichTarget : r.warnWhichCurrent })}
          {mode === "to_fork" && ` ${r.warnForkExtra}`}
        </p>
      </div>

      <label className="block">
        <span className="block text-sm font-medium text-foreground mb-1.5">
          {r.confirmBefore}<span className="font-mono">{domain}</span>{r.confirmAfter}
        </span>
        <input
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder={domain}
          className="w-full px-3 py-2 text-sm rounded-xl border border-border bg-background text-foreground font-mono placeholder:font-sans placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
      </label>
    </>
  );
}

function ProgressStep({
  status,
  domain,
}: {
  status: BackupRun["status"] | BackupRestore_Status | undefined;
  domain: string;
}) {
  const { t } = useI18n();
  const r = t.emailsAdmin.restore;
  const done = status === "succeeded";
  const failed = status === "failed" || status === "server_error" || status === "cancelled";
  return (
    <div className="flex flex-col items-center gap-3 py-6 text-center">
      <div
        className={`w-12 h-12 rounded-2xl flex items-center justify-center ${
          done ? "bg-success-bg" : failed ? "bg-danger-bg" : "bg-info-bg"
        }`}
      >
        {done ? (
          <Check className="size-6 text-success" />
        ) : failed ? (
          <CircleX className="size-6 text-danger" />
        ) : (
          <Loader2 className="size-6 text-info animate-spin" />
        )}
      </div>
      <div>
        <p className="text-sm font-medium text-foreground capitalize">
          {done
            ? r.progressComplete
            : failed
              ? interpolate(r.progressFailed, { status: status ?? "" })
              : (status ?? r.startingFallback) + "…"}
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          {done
            ? interpolate(r.subDone, { domain })
            : failed
              ? r.subFailed
              : r.subRunning}
        </p>
      </div>
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <ServerIcon className="size-3" />
        {domain}
      </div>
    </div>
  );
}

// Restore status union (mirrors BackupRestore["status"]).
type BackupRestore_Status =
  | "queued"
  | "preparing"
  | "prepared"
  | "applying"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "server_error";
