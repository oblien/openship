"use client";

import React, { useEffect, useState } from "react";
import { AlertTriangle, Boxes, Loader2, PowerOff, ServerOff } from "lucide-react";
import { systemApi } from "@/lib/api/system";
import { Checkbox } from "@/components/ui/Checkbox";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { getProjectStatus, PROJECT_STATUS_META, projectStatusLabel } from "@/utils/project-status";
import {
  groupServerWorkloads,
  serverDestroyBlockedReason,
  type ServerDeletionPreview,
  type ServerRemovalWorkloadResult,
  type ServerWorkloadPreview,
} from "@/lib/server-removal";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** Runs the DELETE. Receives the operator's explicit workload fate. */
  onConfirm: (destroyOnSource: boolean, workloadCount: number) => void;
  serverId: string;
  serverName: string;
  /** Per-workload results from a 409 — rendered in place so the operator can retry
   *  against the same list instead of re-opening a modal that lost the reason. */
  failures?: ServerRemovalWorkloadResult[] | null;
  busy?: boolean;
}

/**
 * The removal confirm for a server.
 *
 * It exists because the old one was a one-line "this will clear all SSH credentials
 * and connection settings" — while the row it deletes is the deploy target of every
 * project on the box. The two things this modal must get right:
 *
 *  1. LIST them. The preview shares one binding expression with the fleet's "N
 *     projects" chip, so what is listed here is exactly what the removal resolves.
 *  2. Make their fate a CHOICE, and default it to the reversible one — remove from
 *     Openship, leave the containers running and re-importable. Destroying them on
 *     the machine is opt-in, unchecked, and hidden entirely when the box can't be
 *     reached (a teardown there would orphan resources GC can never reclaim once
 *     this server row is gone).
 */
export const ServerDeletionModal = ({
  isOpen,
  onClose,
  onConfirm,
  serverId,
  serverName,
  failures,
  busy,
}: Props) => {
  const { t } = useI18n();
  const copy = t.servers.detail.removal;
  const [inputValue, setInputValue] = useState("");
  const [destroyOnSource, setDestroyOnSource] = useState(false);
  const [preview, setPreview] = useState<ServerDeletionPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setInputValue("");
    // Always unchecked on open: destroying the workloads is never the default, and a
    // sticky checkbox across opens would make it one.
    setDestroyOnSource(false);
    setPreview(null);

    let cancelled = false;
    setPreviewLoading(true);
    systemApi
      .serverDeletionPreview(serverId)
      .then((res) => {
        if (!cancelled && res?.preview) setPreview(res.preview);
      })
      .catch(() => {
        /* Informational: a failed preview must not block the removal, and
           `serverDestroyBlockedReason(null)` then withholds the destroy option
           rather than offering it against an unknown host. */
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, serverId]);

  if (!isOpen) return null;

  const groups = groupServerWorkloads(preview?.workloads ?? []);
  const workloadCount = groups.projects.length + groups.apps.length;
  const blocked = serverDestroyBlockedReason(preview);
  const isConfirmDisabled = inputValue !== serverName || previewLoading || !!busy;

  const alsoLines: string[] = [];
  if (preview) {
    if (preview.alsoRemoved.mailConfigured) alsoLines.push(copy.alsoMail);
    if (preview.alsoRemoved.tunnels > 0) {
      alsoLines.push(
        interpolate(
          preview.alsoRemoved.tunnels === 1 ? copy.alsoTunnelsOne : copy.alsoTunnelsOther,
          { count: String(preview.alsoRemoved.tunnels) },
        ),
      );
    }
    if (preview.alsoRemoved.githubRegistration) alsoLines.push(copy.alsoGithub);
    if (preview.alsoUnbound.backupDestinations > 0) {
      alsoLines.push(
        interpolate(
          preview.alsoUnbound.backupDestinations === 1
            ? copy.alsoBackupsOne
            : copy.alsoBackupsOther,
          { count: String(preview.alsoUnbound.backupDestinations) },
        ),
      );
    }
  }

  const renderWorkload = (w: ServerWorkloadPreview) => {
    // One definition of live-vs-draft, app-wide. The preview deliberately ships the
    // deployment pointer instead of a resolved status so this stays the only one.
    const status = getProjectStatus({ activeDeploymentId: w.activeDeploymentId });
    return (
      <li key={w.id} className="flex items-center gap-3 px-3 py-2.5">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-foreground">
            {w.groupName && w.groupName !== w.name ? `${w.groupName} / ${w.name}` : w.name}
          </span>
          <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
            {w.environmentName}
          </span>
        </span>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${PROJECT_STATUS_META[status].badge}`}
        >
          {projectStatusLabel(status, t)}
        </span>
      </li>
    );
  };

  const handleConfirm = () => {
    if (isConfirmDisabled) return;
    // Never send the flag when the option wasn't offerable — the server would honor it.
    onConfirm(blocked ? false : destroyOnSource, workloadCount);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
      <div
        className="w-full max-w-lg overflow-hidden rounded-2xl border border-border/60 shadow-xl"
        style={{ backgroundColor: "var(--th-card-bg-solid, var(--card))" }}
      >
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-border/40 px-5 py-4">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-warning-border bg-warning-bg">
            <AlertTriangle className="size-[18px] text-warning" />
          </div>
          <div className="min-w-0">
            <h3 className="text-[15px] font-semibold text-foreground">{copy.title}</h3>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{serverName}</p>
          </div>
        </div>

        {/* Body */}
        <div className="max-h-[70vh] space-y-4 overflow-y-auto px-5 py-4">
          {previewLoading ? (
            <div className="flex items-center gap-2 rounded-xl border border-border/30 bg-muted/10 px-3 py-2.5 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              {copy.scanning}
            </div>
          ) : workloadCount === 0 ? (
            <p className="text-sm text-muted-foreground">{copy.noWorkloads}</p>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                {interpolate(workloadCount === 1 ? copy.introOne : copy.introOther, {
                  count: String(workloadCount),
                })}
              </p>

              {groups.projects.length > 0 && (
                <div className="overflow-hidden rounded-xl border border-border/50">
                  <div className="flex items-center gap-2 bg-muted/15 px-3 py-2">
                    <Boxes className="size-3.5 text-muted-foreground" />
                    <span className="text-xs font-medium text-foreground">
                      {interpolate(
                        groups.projects.length === 1 ? copy.projectsOne : copy.projectsOther,
                        { count: String(groups.projects.length) },
                      )}
                    </span>
                  </div>
                  <ul className="divide-y divide-border/30 border-t border-border/40">
                    {groups.projects.map(renderWorkload)}
                  </ul>
                </div>
              )}

              {groups.apps.length > 0 && (
                <div className="overflow-hidden rounded-xl border border-border/50">
                  <div className="flex items-center gap-2 bg-muted/15 px-3 py-2">
                    <Boxes className="size-3.5 text-muted-foreground" />
                    <span className="text-xs font-medium text-foreground">
                      {interpolate(groups.apps.length === 1 ? copy.appsOne : copy.appsOther, {
                        count: String(groups.apps.length),
                      })}
                    </span>
                  </div>
                  <ul className="divide-y divide-border/30 border-t border-border/40">
                    {groups.apps.map(renderWorkload)}
                  </ul>
                </div>
              )}

              {/* The control plane can't be torn down, so it is named as staying rather
                  than silently counted into the removal. */}
              {groups.staying.length > 0 && (
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {copy.controlPlaneStays}
                </p>
              )}

              {/* The fate choice. Unchecked, and absent when the box can't be reached. */}
              {blocked ? (
                <div className="rounded-xl border border-border/50 bg-muted/20 px-3 py-2.5">
                  <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
                    <ServerOff className="mt-0.5 size-3.5 shrink-0" />
                    {blocked === "unreachable" ? copy.destroyUnreachable : copy.destroyUnknown}
                  </p>
                </div>
              ) : (
                <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border/50 bg-muted/15 p-3">
                  <Checkbox
                    checked={destroyOnSource}
                    onCheckedChange={setDestroyOnSource}
                    tone="destructive"
                    className="mt-0.5"
                    aria-label={copy.destroyLabel}
                  />
                  <span className="min-w-0">
                    <span className="flex items-center gap-2">
                      <PowerOff className="size-3.5 text-muted-foreground" />
                      <span className="text-sm font-medium text-foreground">
                        {copy.destroyLabel}
                      </span>
                    </span>
                    <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                      {copy.destroyDesc}
                    </span>
                  </span>
                </label>
              )}

              {/* What each choice actually does, in the operator's terms. The env-var
                  sentence is on BOTH paths: the rows cascade either way, and the
                  re-import manifest is deliberately secret-free. */}
              <div
                className={`rounded-xl border px-3 py-2.5 ${
                  destroyOnSource && !blocked
                    ? "border-warning-border bg-warning-bg"
                    : "border-border/50 bg-muted/20"
                }`}
              >
                <p
                  className={`text-xs leading-relaxed ${
                    destroyOnSource && !blocked ? "text-warning" : "text-muted-foreground"
                  }`}
                >
                  {destroyOnSource && !blocked ? copy.effectDestroy : copy.effectRecordOnly}
                </p>
                <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                  {copy.envVarsLost}
                </p>
              </div>
            </>
          )}

          {alsoLines.length > 0 && (
            <div className="rounded-xl border border-border/50 bg-muted/10 px-3 py-2.5">
              <p className="text-xs font-medium text-foreground">{copy.alsoTitle}</p>
              <ul className="mt-1.5 space-y-1">
                {alsoLines.map((line) => (
                  <li key={line} className="text-xs leading-relaxed text-muted-foreground">
                    {line}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* A previous attempt's per-workload failures. The server kept the row, so
              the retry is safe and the list below says what to fix first. */}
          {failures && failures.length > 0 && (
            <div className="rounded-xl border border-danger-border bg-danger-bg px-3 py-2.5">
              <p className="text-xs font-medium text-danger">{copy.failedTitle}</p>
              <ul className="mt-1.5 space-y-1">
                {failures.map((f) => (
                  <li key={f.id} className="text-xs leading-relaxed text-muted-foreground">
                    <span className="font-medium text-foreground">{f.name}</span>
                    {f.error ? ` — ${f.error}` : ""}
                    {!f.error && (f.orphaned ?? 0) > 0 ? ` — ${copy.failedOrphaned}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <p className="mb-2 text-xs text-muted-foreground">
              {copy.typePrefix}
              <span className="rounded bg-muted/60 px-1 font-mono text-foreground">
                {serverName}
              </span>
              {copy.typeSuffix}
            </p>
            <input
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder={serverName}
              spellCheck={false}
              autoComplete="off"
              className="w-full rounded-xl border border-border/50 bg-muted/30 px-3 py-2 text-sm text-foreground outline-none transition-all focus:border-primary/40 focus:ring-2 focus:ring-primary/15"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-border/40 bg-muted/[0.04] px-5 py-3">
          <button
            onClick={onClose}
            className="rounded-xl bg-foreground/[0.06] px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-foreground/[0.1]"
          >
            {t.servers.detail.cancel}
          </button>
          <button
            onClick={handleConfirm}
            disabled={isConfirmDisabled}
            className={`flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium transition-all ${
              isConfirmDisabled
                ? "cursor-not-allowed bg-muted text-muted-foreground/70"
                : "bg-danger-solid text-white hover:bg-danger-solid/90"
            }`}
          >
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            {destroyOnSource && !blocked ? copy.confirmDestroy : copy.confirm}
          </button>
        </div>
      </div>
    </div>
  );
};
