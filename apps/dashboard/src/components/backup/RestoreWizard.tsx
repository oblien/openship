"use client";

import React, { useEffect, useState } from "react";
import { X, AlertTriangle, CheckCircle2, XCircle, Loader2, Activity, Shield } from "lucide-react";
import { backupsApi, getApiErrorMessage, type BackupRun, type BackupRestore } from "@/lib/api";
import { useRestoreRunStream } from "@/hooks/useRestoreRunStream";
import { useI18n, interpolate } from "@/components/i18n-provider";

interface Props {
  sourceRun: BackupRun;
  serviceName?: string;
  onClose: () => void;
}

type WizardStep = "review" | "preparing" | "prepared" | "applying" | "done";

export function RestoreWizard({ sourceRun, serviceName, onClose }: Props): React.JSX.Element {
  const { t } = useI18n();
  const m = t.misc.restoreWizard;
  const [step, setStep] = useState<WizardStep>("review");
  const [restoreId, setRestoreId] = useState<string | null>(null);
  const [confirmationToken, setConfirmationToken] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [backupFirst, setBackupFirst] = useState(true);
  const [busy, setBusy] = useState(false);

  const { restore } = useRestoreRunStream(restoreId);

  // Step transitions follow the restore FSM.
  useEffect(() => {
    if (!restore) return;
    if (restore.status === "preparing" || restore.status === "queued") {
      setStep("preparing");
    } else if (restore.status === "prepared") {
      setStep("prepared");
    } else if (restore.status === "applying") {
      setStep("applying");
    } else if (
      ["succeeded", "failed", "cancelled", "server_error"].includes(restore.status)
    ) {
      setStep("done");
    }
  }, [restore]);

  const startPrepare = async () => {
    setBusy(true);
    try {
      if (backupFirst) {
        // Protect the latest succeeded backup from prune BEFORE we
        // restore, so the user can always come back to "what was
        // running right before I restored". Best-effort.
        try {
          await backupsApi.protectRun(sourceRun.id, { protected: true });
        } catch {
          // tolerated
        }
      }
      const res = await backupsApi.prepareRestore(sourceRun.id);
      setRestoreId(res.data.restoreId);
      setConfirmationToken(res.data.confirmationToken);
      setStep("preparing");
    } catch (err) {
      window.alert(getApiErrorMessage(err, m.startFailed));
    } finally {
      setBusy(false);
    }
  };

  const applyRestore = async () => {
    if (!restoreId || !confirmationToken) return;
    if (typed !== (serviceName ?? sourceRun.serviceId ?? "")) {
      window.alert(m.typeToConfirm);
      return;
    }
    setBusy(true);
    try {
      await backupsApi.applyRestore(restoreId, confirmationToken);
      setStep("applying");
    } catch (err) {
      window.alert(getApiErrorMessage(err, m.applyFailed));
    } finally {
      setBusy(false);
    }
  };

  const cancelRestore = async () => {
    if (!restoreId) {
      onClose();
      return;
    }
    setBusy(true);
    try {
      await backupsApi.cancelRestore(restoreId);
    } catch {
      // tolerated
    } finally {
      setBusy(false);
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div className="relative max-h-[90vh] w-[640px] max-w-[95vw] overflow-y-auto rounded-2xl border border-border/50 bg-card p-6 shadow-xl">
        <button
          onClick={onClose}
          className="absolute end-4 top-4 rounded-lg p-1 text-muted-foreground hover:bg-muted"
        >
          <X className="size-4" />
        </button>

        <h2 className="text-lg font-semibold text-foreground">{m.title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {serviceName ? interpolate(m.serviceLabel, { name: serviceName }) : m.serviceRestore}
        </p>

        <StepIndicator step={step} />

        {step === "review" && (
          <ReviewStep
            sourceRun={sourceRun}
            backupFirst={backupFirst}
            setBackupFirst={setBackupFirst}
            onCancel={onClose}
            onContinue={() => void startPrepare()}
            busy={busy}
          />
        )}

        {step === "preparing" && (
          <PreparingStep restore={restore} onCancel={() => void cancelRestore()} />
        )}

        {step === "prepared" && (
          <ConfirmStep
            restore={restore}
            serviceName={serviceName ?? sourceRun.serviceId ?? ""}
            typed={typed}
            setTyped={setTyped}
            onCancel={() => void cancelRestore()}
            onApply={() => void applyRestore()}
            busy={busy}
          />
        )}

        {step === "applying" && <ApplyingStep restore={restore} />}

        {step === "done" && <DoneStep restore={restore} onClose={onClose} />}
      </div>
    </div>
  );
}

function StepIndicator({ step }: { step: WizardStep }): React.JSX.Element {
  const { t } = useI18n();
  const m = t.misc.restoreWizard;
  const order: WizardStep[] = ["review", "preparing", "prepared", "applying", "done"];
  const labels: Record<WizardStep, string> = {
    review: m.stepReview,
    preparing: m.stepPrepare,
    prepared: m.stepConfirm,
    applying: m.stepApply,
    done: m.stepDone,
  };
  const currentIdx = order.indexOf(step);
  return (
    <div className="mt-5 flex items-center gap-2">
      {order.map((s, idx) => (
        <React.Fragment key={s}>
          <div
            className={`flex items-center gap-1.5 text-[11px] ${
              idx <= currentIdx ? "text-foreground" : "text-muted-foreground/60"
            }`}
          >
            <span
              className={`flex size-5 items-center justify-center rounded-full text-[10px] ${
                idx < currentIdx
                  ? "bg-success-bg text-success"
                  : idx === currentIdx
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground"
              }`}
            >
              {idx + 1}
            </span>
            {labels[s]}
          </div>
          {idx < order.length - 1 && (
            <div className="h-px flex-1 bg-border/50" />
          )}
        </React.Fragment>
      ))}
    </div>
  );
}

function ReviewStep({
  sourceRun,
  backupFirst,
  setBackupFirst,
  onCancel,
  onContinue,
  busy,
}: {
  sourceRun: BackupRun;
  backupFirst: boolean;
  setBackupFirst: (v: boolean) => void;
  onCancel: () => void;
  onContinue: () => void;
  busy: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const m = t.misc.restoreWizard;
  return (
    <div className="mt-6 space-y-4">
      <div className="rounded-xl bg-muted/40 p-4 text-sm">
        <p className="text-foreground/80">
          {m.reviewPre}
          <strong>{new Date(sourceRun.startedAt).toLocaleString()}</strong>
          {m.reviewPost}
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          {interpolate(m.sizeArtifacts, {
            size: sourceRun.bytesTransferred ? formatBytes(sourceRun.bytesTransferred) : "—",
            count: String(Array.isArray(sourceRun.artifacts) ? sourceRun.artifacts.length : 0),
          })}
        </p>
      </div>

      <div className="rounded-xl border border-warning-border bg-warning-bg p-4">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 size-4 text-warning shrink-0" />
          <div className="text-sm text-foreground/80">
            <p className="font-medium">{m.overwriteWarning}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {m.overwriteHint}
            </p>
          </div>
        </div>
      </div>

      <label className="flex items-start gap-2 text-sm cursor-pointer">
        <input
          type="checkbox"
          checked={backupFirst}
          onChange={(e) => setBackupFirst(e.target.checked)}
          className="mt-0.5"
        />
        <span className="flex-1 text-foreground/80">
          <span className="flex items-center gap-1.5">
            <Shield className="size-3.5 text-muted-foreground" />
            <strong className="font-medium">{m.protectLabel}</strong>
          </span>
          <span className="block text-xs text-muted-foreground">
            {m.protectHint}
          </span>
        </span>
      </label>

      <div className="flex items-center justify-end gap-2 pt-2">
        <button
          onClick={onCancel}
          disabled={busy}
          className="rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-muted"
        >
          {m.cancel}
        </button>
        <button
          onClick={onContinue}
          disabled={busy}
          className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {busy ? m.starting : m.continuePrepare}
        </button>
      </div>
    </div>
  );
}

function PreparingStep({
  restore,
  onCancel,
}: {
  restore: BackupRestore | null;
  onCancel: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const m = t.misc.restoreWizard;
  return (
    <div className="mt-6 space-y-3">
      <div className="rounded-xl bg-muted/40 p-4 text-sm flex items-center gap-3">
        <Loader2 className="size-4 animate-spin text-primary" />
        <div className="flex-1">
          <p className="font-medium text-foreground">{m.verifying}</p>
          <p className="text-xs text-muted-foreground">
            {m.verifyingHint}
          </p>
        </div>
        {restore && (
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <Activity className="size-3 animate-pulse" />
            {restore.status}
          </span>
        )}
      </div>
      <div className="flex items-center justify-end">
        <button
          onClick={onCancel}
          className="rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-muted"
        >
          {m.cancelRestore}
        </button>
      </div>
    </div>
  );
}

function ConfirmStep({
  restore,
  serviceName,
  typed,
  setTyped,
  onCancel,
  onApply,
  busy,
}: {
  restore: BackupRestore | null;
  serviceName: string;
  typed: string;
  setTyped: (v: string) => void;
  onCancel: () => void;
  onApply: () => void;
  busy: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const m = t.misc.restoreWizard;
  const ok = typed === serviceName;
  return (
    <div className="mt-6 space-y-4">
      <div className="rounded-xl border border-success-border bg-success-bg p-4">
        <div className="flex items-start gap-2">
          <CheckCircle2 className="mt-0.5 size-4 text-success shrink-0" />
          <div className="text-sm text-foreground/80">
            <p className="font-medium">{m.verified}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {interpolate(m.preparedInfo, {
                size: restore?.bytesRestored ? formatBytes(restore.bytesRestored) : "—",
              })}
            </p>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-danger-border bg-danger-bg p-4">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 size-4 text-danger shrink-0" />
          <p className="text-sm text-foreground/80">
            {m.confirmPre}<strong>{m.confirmStrong}</strong>{m.confirmMid}
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">
              {serviceName}
            </code>
            {m.confirmPost}
          </p>
        </div>
      </div>

      <input
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        placeholder={serviceName}
        className="w-full rounded-lg border border-border/50 bg-background px-3 py-2 text-sm font-mono"
        autoFocus
      />

      <div className="flex items-center justify-end gap-2">
        <button
          onClick={onCancel}
          disabled={busy}
          className="rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-muted"
        >
          {m.cancel}
        </button>
        <button
          onClick={onApply}
          disabled={busy || !ok}
          className="rounded-lg bg-danger-solid px-3 py-2 text-sm font-medium text-white hover:bg-danger-solid/90 disabled:opacity-50"
        >
          {busy ? m.applying : m.applyRestore}
        </button>
      </div>
    </div>
  );
}

function ApplyingStep({ restore }: { restore: BackupRestore | null }): React.JSX.Element {
  const { t } = useI18n();
  const m = t.misc.restoreWizard;
  return (
    <div className="mt-6 space-y-3">
      <div className="rounded-xl bg-muted/40 p-4 text-sm flex items-center gap-3">
        <Loader2 className="size-4 animate-spin text-danger" />
        <div className="flex-1">
          <p className="font-medium text-foreground">{m.restoringData}</p>
          <p className="text-xs text-muted-foreground">
            {m.restoringHint}
          </p>
        </div>
        {restore && (
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <Activity className="size-3 animate-pulse" />
            {restore.status}
          </span>
        )}
      </div>
    </div>
  );
}

function DoneStep({
  restore,
  onClose,
}: {
  restore: BackupRestore | null;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const m = t.misc.restoreWizard;
  const success = restore?.status === "succeeded";
  return (
    <div className="mt-6 space-y-3">
      <div
        className={`rounded-xl border p-4 ${
          success
            ? "border-success-border bg-success-bg"
            : "border-danger-border bg-danger-bg"
        }`}
      >
        <div className="flex items-start gap-2">
          {success ? (
            <CheckCircle2 className="mt-0.5 size-4 text-success shrink-0" />
          ) : (
            <XCircle className="mt-0.5 size-4 text-danger shrink-0" />
          )}
          <div className="text-sm">
            <p className="font-medium">
              {success
                ? m.restoreComplete
                : interpolate(m.restoreStatus, { status: restore?.status ?? m.failed })}
            </p>
            {restore?.errorMessage && (
              <p className="mt-1 text-xs text-muted-foreground font-mono">
                {restore.errorMessage}
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-end">
        <button
          onClick={onClose}
          className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          {m.close}
        </button>
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
