import React, { useCallback, useEffect, useState } from "react";
import { KeyRound, Plus, Trash2, Loader2, Eye, EyeOff, RefreshCw, Link2, Network, Globe, ChevronRight } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { AppLogo } from "@/components/AppLogo";
import { projectsApi, deployApi } from "@/lib/api";
import { connectionsApi, type ProjectConnection } from "@/lib/api/connections";
import { getApiErrorMessage } from "@/lib/api/client";
import { useToast } from "@/context/ToastContext";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { computeEnvDiff } from "./env-diff";

/**
 * Per-variable production env editor (modal). Safe by design:
 *  - reads via GET /:id/env (secret VALUES come back masked);
 *  - saves a DIFF via PATCH /:id/env (merge) — only added/changed/deleted keys
 *    are touched. A secret the user didn't re-enter is never re-sent, so masked
 *    secrets can't be overwritten and untouched vars are never wiped.
 */

const ENVIRONMENT = "production";

interface Row {
  /** Stable local id for React keys. */
  uid: string;
  key: string;
  /** Current input value. For an untouched secret this stays "" (we never hold the real value). */
  value: string;
  isSecret: boolean;
  /** The persisted key when this row was loaded (null for a freshly-added row). */
  originalKey: string | null;
  /** Was this loaded as a secret whose real value we don't have until re-entered? */
  loadedSecret: boolean;
}

let uidCounter = 0;
const nextUid = () => `row-${uidCounter++}`;

export function EnvVarsEditor({
  projectId,
  isOpen,
  onClose,
}: {
  projectId: string;
  isOpen: boolean;
  onClose: () => void;
}) {
  const { showToast } = useToast();
  const { t } = useI18n();
  const { projectData } = useProjectSettings();
  const hasActiveDeployment = Boolean(projectData?.activeDeploymentId);
  const [rows, setRows] = useState<Row[]>([]);
  // Keys that existed when the editor loaded — needed to detect deletions
  // (a removed row is gone from `rows`, so its key must be remembered here).
  const [originalKeys, setOriginalKeys] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  // Set after a successful save when there's a live deployment: shows the
  // "Apply (restart, no rebuild)" affordance so the change reaches the running
  // service without a full clone+build.
  const [pendingApply, setPendingApply] = useState(false);
  const [applying, setApplying] = useState(false);
  // Env keys wired IN by a service connection (keyed by envKey). These render as
  // read-only "linked integration" rows — click opens the integration detail.
  const [linked, setLinked] = useState<Record<string, ProjectConnection>>({});
  const [linkDetail, setLinkDetail] = useState<ProjectConnection | null>(null);
  const [unlinking, setUnlinking] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await projectsApi.getEnv(projectId);
      const loaded: Row[] = (res?.data ?? [])
        .filter((v) => v.environment === ENVIRONMENT)
        .map((v) => ({
          uid: nextUid(),
          key: v.key,
          value: v.isSecret ? "" : v.value, // never seed the input with the mask
          isSecret: v.isSecret,
          originalKey: v.key,
          loadedSecret: v.isSecret,
        }));
      setRows(loaded);
      setOriginalKeys(loaded.map((r) => r.key));
      // Best-effort: which of these keys are managed by a service connection?
      const conns = await connectionsApi.list(projectId).catch(() => ({ data: [] }));
      const map: Record<string, ProjectConnection> = {};
      for (const cn of conns?.data ?? []) map[cn.envKey] = cn;
      setLinked(map);
    } catch (err) {
      showToast(getApiErrorMessage(err, t.projectSettings.envVars.toast.loadFailed), "error", t.projectSettings.envVars.toast.loadFailedTitle);
    } finally {
      setLoading(false);
    }
  }, [projectId, showToast, t]);

  useEffect(() => {
    if (isOpen) {
      setReveal({});
      setPendingApply(false);
      void load();
    }
  }, [isOpen, load]);

  const update = (uid: string, patch: Partial<Row>) =>
    setRows((prev) => prev.map((r) => (r.uid === uid ? { ...r, ...patch } : r)));

  const addRow = () =>
    setRows((prev) => [
      ...prev,
      { uid: nextUid(), key: "", value: "", isSecret: false, originalKey: null, loadedSecret: false },
    ]);

  const removeRow = (uid: string) => setRows((prev) => prev.filter((r) => r.uid !== uid));

  const handleSave = async () => {
    const result = computeEnvDiff(rows.map((r) => ({ ...r, key: r.key.trim() })), originalKeys);
    if (!result.ok) {
      showToast(result.error, "error", t.projectSettings.envVars.toast.validationTitle);
      return;
    }
    const { upserts, deletes } = result.diff;

    if (upserts.length === 0 && deletes.length === 0) {
      onClose(); // nothing changed
      return;
    }

    setSaving(true);
    try {
      await projectsApi.mergeEnv(projectId, { environment: ENVIRONMENT, upserts, deletes });
      showToast(t.projectSettings.envVars.toast.saved, "success", t.projectSettings.envVars.toast.savedTitle);
      // A persisted env change only reaches the RUNNING service on a deploy.
      // If something is deployed, keep the editor open and offer the no-rebuild
      // refresh; otherwise there's nothing to apply (it lands on the next deploy).
      if (hasActiveDeployment) {
        await load(); // re-sync so the diff resets to the saved state
        setPendingApply(true);
      } else {
        onClose();
      }
    } catch (err) {
      showToast(getApiErrorMessage(err, t.projectSettings.envVars.toast.saveFailed), "error", t.projectSettings.envVars.toast.saveFailedTitle);
    } finally {
      setSaving(false);
    }
  };

  // Apply the saved env to the live service WITHOUT a rebuild: the server's
  // `refresh` deploy mode recreates the service from its existing image with the
  // new env (no git clone, no build). The full-rebuild "Redeploy" stays separate.
  const handleApply = async () => {
    setApplying(true);
    try {
      await deployApi.trigger({ projectId, refresh: true });
      showToast(t.projectSettings.envVars.toast.applying, "success", t.projectSettings.envVars.toast.applyingTitle);
      onClose();
    } catch (err) {
      showToast(getApiErrorMessage(err, t.projectSettings.envVars.toast.applyFailed), "error", t.projectSettings.envVars.toast.applyFailedTitle);
    } finally {
      setApplying(false);
    }
  };

  // Remove a linked connection: drops the injected env var + the link, then
  // re-syncs. On a live deployment, offer the no-rebuild apply.
  const handleUnlink = async () => {
    if (!linkDetail) return;
    setUnlinking(true);
    try {
      await connectionsApi.remove(projectId, linkDetail.id);
      showToast(t.projects.connections.removed, "success");
      setLinkDetail(null);
      await load();
      if (hasActiveDeployment) setPendingApply(true);
    } catch (err) {
      showToast(getApiErrorMessage(err, t.projects.connections.failed), "error");
    } finally {
      setUnlinking(false);
    }
  };

  return (
    <>
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      maxWidth="640px"
      width="92vw"
      footer={
        <div className="flex items-center justify-end gap-2 border-t border-border/50 px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={saving || applying}
            className="rounded-lg border border-border/60 bg-muted/30 px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted/50 disabled:opacity-50"
          >
            {pendingApply ? t.projectSettings.envVars.close : t.projectSettings.envVars.cancel}
          </button>
          {pendingApply ? (
            <button
              type="button"
              onClick={handleApply}
              disabled={applying}
              className="inline-flex items-center gap-1.5 rounded-lg bg-foreground px-3.5 py-2 text-sm font-medium text-background transition-colors hover:bg-foreground/90 disabled:opacity-50"
            >
              {applying ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
              {t.projectSettings.envVars.applyButton}
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || loading}
              className="inline-flex items-center gap-1.5 rounded-lg bg-foreground px-3.5 py-2 text-sm font-medium text-background transition-colors hover:bg-foreground/90 disabled:opacity-50"
            >
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {t.projectSettings.envVars.saveChanges}
            </button>
          )}
        </div>
      }
    >
      <div className="space-y-4 p-6">
        {pendingApply && (
          <div className="flex items-start gap-3 rounded-xl border border-primary/25 bg-primary/5 px-4 py-3">
            <RefreshCw className="mt-0.5 size-4 shrink-0 text-primary" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">{t.projectSettings.envVars.applyTitle}</p>
              <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">
                {t.projectSettings.envVars.applyText}
              </p>
            </div>
          </div>
        )}
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-muted/60 text-muted-foreground">
            <KeyRound className="size-4" />
          </div>
          <div className="min-w-0">
            <h3 className="text-[15px] font-semibold text-foreground">{t.projectSettings.envVars.title}</h3>
            <p className="mt-0.5 text-[12px] text-muted-foreground">
              {t.projectSettings.envVars.description}
            </p>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : (
          <div className="space-y-2">
            {rows.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border/60 bg-muted/15 px-4 py-6 text-center text-sm text-muted-foreground">
                {t.projectSettings.envVars.empty}
              </p>
            ) : (
              rows.map((r) => {
                // A connection-managed key renders as a read-only integration
                // chip — not editable here; click opens the integration detail.
                const conn = r.originalKey ? linked[r.originalKey] : undefined;
                if (conn) {
                  return (
                    <button
                      key={r.uid}
                      type="button"
                      onClick={() => setLinkDetail(conn)}
                      className="flex w-full items-center gap-2.5 rounded-lg border border-primary/30 bg-primary/[0.04] px-3 py-2 text-left transition-colors hover:bg-primary/[0.07]"
                    >
                      <AppLogo appId={conn.sourceAppTemplateId ?? undefined} className="size-4 shrink-0" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-mono text-[13px] text-foreground">{r.key}</span>
                        <span className="block truncate text-[11px] text-muted-foreground">
                          {interpolate(t.projectSettings.envVars.linkedManaged, { app: conn.sourceName })}
                        </span>
                      </span>
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
                        <Link2 className="size-3" />
                        {t.projectSettings.envVars.linkedBadge}
                      </span>
                      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                    </button>
                  );
                }
                const showValue = reveal[r.uid] || (!r.isSecret && !r.loadedSecret);
                return (
                  <div key={r.uid} className="flex items-center gap-2">
                    <input
                      value={r.key}
                      onChange={(e) => update(r.uid, { key: e.target.value })}
                      placeholder={t.projectSettings.envVars.keyPlaceholder}
                      spellCheck={false}
                      className="h-9 w-2/5 rounded-lg border border-border/50 bg-muted/20 px-3 font-mono text-[13px] text-foreground outline-none transition-colors focus:border-primary/40"
                    />
                    <div className="relative flex-1">
                      <input
                        type={showValue ? "text" : "password"}
                        value={r.value}
                        onChange={(e) => update(r.uid, { value: e.target.value })}
                        placeholder={r.loadedSecret ? t.projectSettings.envVars.secretPlaceholder : t.projectSettings.envVars.valuePlaceholder}
                        spellCheck={false}
                        className="h-9 w-full rounded-lg border border-border/50 bg-muted/20 px-3 pe-9 font-mono text-[13px] text-foreground outline-none transition-colors focus:border-primary/40"
                      />
                      <button
                        type="button"
                        onClick={() => setReveal((p) => ({ ...p, [r.uid]: !p[r.uid] }))}
                        className="absolute end-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        aria-label={showValue ? t.projectSettings.envVars.hideValue : t.projectSettings.envVars.showValue}
                      >
                        {showValue ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={() => update(r.uid, { isSecret: !r.isSecret })}
                      title={r.isSecret ? t.projectSettings.envVars.markedSecret : t.projectSettings.envVars.markSecret}
                      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border transition-colors ${
                        r.isSecret
                          ? "border-warning-border bg-warning-bg text-warning"
                          : "border-border/60 bg-muted/30 text-muted-foreground hover:bg-muted/50"
                      }`}
                    >
                      <KeyRound className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => removeRow(r.uid)}
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/30 text-muted-foreground transition-colors hover:bg-danger-bg hover:text-danger"
                      aria-label={t.projectSettings.envVars.removeVariable}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                );
              })
            )}

            <button
              type="button"
              onClick={addRow}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 bg-muted/30 px-3 py-1.5 text-[13px] font-medium text-foreground transition-colors hover:bg-muted/50"
            >
              <Plus className="size-3.5" />
              {t.projectSettings.envVars.addVariable}
            </button>
          </div>
        )}
      </div>
    </Modal>

    {/* Linked-integration detail — opens above the env editor when a linked row
        is clicked. Shows the source app + reach mode; the value lives in the
        connection, so the only action here is removing the link. */}
    {linkDetail && (
      <Modal isOpen onClose={() => setLinkDetail(null)} maxWidth="460px" width="92vw" zIndex={10010} showCloseButton>
        <div className="p-6">
          <div className="flex items-start gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted/60">
              <AppLogo appId={linkDetail.sourceAppTemplateId ?? undefined} className="size-5" />
            </div>
            <div className="min-w-0">
              <h3 className="text-[15px] font-semibold text-foreground">
                {t.projectSettings.envVars.linkedTitle}
              </h3>
              <p className="mt-0.5 text-[12px] text-muted-foreground">{linkDetail.sourceName}</p>
            </div>
          </div>

          <div className="mt-4 space-y-2 rounded-xl border border-border/50 bg-muted/15 px-4 py-3 text-[13px]">
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">{t.projectSettings.envVars.title}</span>
              <code className="truncate font-mono text-foreground">{linkDetail.envKey}</code>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">{t.projects.connections.modeInternalShort}/{t.projects.connections.modePublicShort}</span>
              <span className="inline-flex items-center gap-1.5 text-foreground">
                {linkDetail.mode === "internal" ? <Network className="size-3.5" /> : <Globe className="size-3.5" />}
                {linkDetail.mode === "internal"
                  ? t.projects.connections.modeInternalShort
                  : t.projects.connections.modePublicShort}
              </span>
            </div>
          </div>

          <p className="mt-3 text-[13px] leading-relaxed text-muted-foreground">
            {interpolate(t.projectSettings.envVars.linkedBody, { app: linkDetail.sourceName })}
          </p>

          <div className="mt-5 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setLinkDetail(null)}
              className="rounded-xl px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground"
            >
              {t.projectSettings.envVars.close}
            </button>
            <button
              type="button"
              onClick={handleUnlink}
              disabled={unlinking}
              className="inline-flex items-center gap-2 rounded-xl border border-danger-border bg-danger-bg px-4 py-2 text-sm font-medium text-danger transition-colors hover:bg-danger-solid/15 disabled:opacity-50"
            >
              {unlinking ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-3.5" />}
              {t.projectSettings.envVars.unlink}
            </button>
          </div>
        </div>
      </Modal>
    )}
    </>
  );
}
