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

import { useCallback, useEffect, useRef, useState } from "react";
import {
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
import { CustomSelect } from "@/components/ui/CustomSelect";
import { useHostedModal } from "./_shared/hosted-modal";

interface MailServerOption {
  id: string;
  name: string;
  host: string;
  domain: string | null;
  completed: boolean;
}

export function MailRestoreModal(props: {
  run: BackupRun;
  mode: "in_place" | "to_fork";
  sourceServerId: string;
  domain: string;
  onClose: () => void;
  onDone: () => void;
}) {
  // `closable: false` — the run is destructive on the target and its only live
  // progress view is inside this modal, so a stray backdrop click must not take
  // it away. The footer's own Cancel/Close is the way out.
  useHostedModal({
    open: true,
    onClose: props.onClose,
    maxWidth: "520px",
    closable: false,
    content: () => <MailRestoreContent {...props} />,
  });
  return null;
}

function MailRestoreContent({
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
    <div className="p-6 space-y-5">
      <h3 className="text-xl font-bold text-foreground">{title}</h3>

      <div className="space-y-4">
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
      </div>

      {error && (
        <div className="rounded-xl border border-danger-border bg-danger-bg px-3.5 py-2.5 text-sm text-danger">
          {error}
        </div>
      )}

      <div className="flex items-center justify-end gap-3 pt-1">
        {done || failed ? (
          <button
            onClick={onClose}
            className="px-4 py-2.5 text-sm font-semibold rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            {t.emailsAdmin.restore.close}
          </button>
        ) : (
          <>
            <button
              onClick={onClose}
              disabled={busy}
              className="px-4 py-2.5 text-sm font-semibold rounded-xl bg-muted text-foreground hover:bg-muted/80 border border-border transition-colors disabled:opacity-50"
            >
              {t.emailsAdmin.restore.cancel}
            </button>
            <button
              onClick={start}
              disabled={!canStart || phase === "running"}
              className="inline-flex items-center gap-1.5 px-4 py-2.5 text-sm font-semibold rounded-xl bg-danger-solid text-white hover:bg-danger-solid/90 transition-colors disabled:opacity-50"
            >
              {phase === "running" && <Loader2 className="size-3.5 animate-spin" />}
              {mode === "to_fork" ? t.emailsAdmin.restore.migrate : t.emailsAdmin.restore.restore}
            </button>
          </>
        )}
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
        <div>
          <span className="block text-sm font-medium text-foreground mb-1.5">{r.targetServer}</span>
          {targets.length === 0 ? (
            <p className="text-xs text-muted-foreground rounded-xl border border-border/60 bg-muted/20 px-3.5 py-2.5">
              {r.noTargetsBefore}<span className="font-mono">{domain}</span>{r.noTargetsAfter}
            </p>
          ) : (
            <CustomSelect
              value={targetId}
              placeholder={r.selectServer}
              options={targets.map((srv) => ({
                value: srv.id,
                label: srv.domain || srv.name,
                description: srv.host,
              }))}
              onChange={setTargetId}
            />
          )}
        </div>
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
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
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
