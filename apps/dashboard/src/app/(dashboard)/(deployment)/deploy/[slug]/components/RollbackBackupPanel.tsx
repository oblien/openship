"use client";

import React, { useCallback, useEffect, useState } from "react";
import { Archive, ExternalLink } from "lucide-react";
import { MAX_ROLLBACK_WINDOW, DEFAULT_ROLLBACK_WINDOW } from "@repo/core";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { useToast } from "@/context/ToastContext";
import { useDeployment } from "@/context/DeploymentContext";
import { projectsApi, backupsApi, getApiErrorMessage } from "@/lib/api";
import type { RollbackCapacityUI } from "@/lib/api/projects";
import type { BackupPolicy } from "@/lib/api/backups";
import { RollbackRetentionCards } from "@/components/rollback/RollbackRetentionCards";
import { PolicyEditor } from "@/components/backup/PolicyEditor";

/**
 * Rollback & backups, inside the deploy wizard's target panel.
 *
 * The target step is where an operator decides WHICH MACHINE this project runs
 * on, so it's also where "how much of its history stays restorable on that
 * machine" belongs. The retention controls are the SAME component the project's
 * Backup tab renders — not a second copy — and backups are shown read-only with a
 * button that opens the existing PolicyEditor modal, so backup configuration keeps
 * living in exactly one place.
 *
 * Editable in BOTH cases, which is the point:
 *   - project exists → PATCH it now, and show what was measured on its host.
 *   - first deploy    → hold the choice in the wizard config; `ensure()` persists
 *                       it when the project is created. (It used to render
 *                       read-only here, which meant the one moment you're
 *                       choosing the server was the one moment you couldn't set
 *                       its retention.)
 */
export function RollbackBackupPanel({
  projectId,
  enabled,
  /** What one retained version physically IS on this project's host. */
  artifactKind = "image",
}: {
  /** Null until the project exists (first deploy through the wizard). */
  projectId?: string | null;
  /** The Advanced disclosure is open — don't fetch while collapsed. */
  enabled: boolean;
  artifactKind?: "image" | "files";
}) {
  const { t } = useI18n();
  const ts = t.deploy.targetStep;
  const { showToast } = useToast();
  const { config, updateConfig } = useDeployment();

  const [capacity, setCapacity] = useState<RollbackCapacityUI | null>(null);
  const [policies, setPolicies] = useState<BackupPolicy[] | null>(null);
  const [togglingStrategy, setTogglingStrategy] = useState(false);
  const [savingWindow, setSavingWindow] = useState(false);
  const [editingBackup, setEditingBackup] = useState(false);

  const load = useCallback(async () => {
    if (!projectId) return;
    const [cap, pol] = await Promise.all([
      projectsApi.getRollbackCapacity(projectId).then((r) => r.data).catch(() => null),
      backupsApi.listPolicies(projectId).then((r) => r.data ?? []).catch(() => []),
    ]);
    setCapacity(cap ?? null);
    setPolicies(pol);
  }, [projectId]);

  useEffect(() => {
    if (enabled) void load();
  }, [enabled, load]);

  // With no project row there's nothing measured yet, so present the wizard's own
  // pending choice in the same shape the card renders for a real project.
  const pendingCapacity: RollbackCapacityUI = {
    window: config.rollbackWindow ?? DEFAULT_ROLLBACK_WINDOW,
    source: config.rollbackWindow == null ? "auto" : "explicit",
    explicit: config.rollbackWindow ?? null,
    snapshotSizeBytes: null,
    measuredAt: null,
    diskFreeBytes: null,
    diskTotalBytes: null,
    maxWindow: MAX_ROLLBACK_WINDOW,
    diskBudgetFraction: 0.25,
    strategy: config.rollbackStrategy ?? "git",
  };

  const effective = projectId ? capacity : pendingCapacity;
  const strategy: "git" | "snapshot" = effective?.strategy === "snapshot" ? "snapshot" : "git";

  const toggleStrategy = async () => {
    const next = strategy === "git" ? "snapshot" : "git";
    if (!projectId) {
      updateConfig({ rollbackStrategy: next });
      return;
    }
    setTogglingStrategy(true);
    try {
      await projectsApi.update(projectId, { defaultRollbackStrategy: next });
      await load();
    } catch (err) {
      showToast(getApiErrorMessage(err, t.projectSettings.git.toast.rollbackStrategyFailed), "error");
    } finally {
      setTogglingStrategy(false);
    }
  };

  const changeWindow = async (next: number) => {
    const clamped = Math.max(0, Math.min(effective?.maxWindow ?? MAX_ROLLBACK_WINDOW, next));
    if (clamped === (effective?.window ?? DEFAULT_ROLLBACK_WINDOW)) return;
    if (!projectId) {
      updateConfig({ rollbackWindow: clamped });
      return;
    }
    setSavingWindow(true);
    try {
      await projectsApi.update(projectId, { rollbackWindow: clamped });
      await load();
    } catch (err) {
      showToast(getApiErrorMessage(err, t.projectSettings.git.toast.rollbackHistoryFailed), "error");
    } finally {
      setSavingWindow(false);
    }
  };

  const preDeployOn = (policies ?? []).some((p) => p.enabled && p.triggerOnPreDeploy);
  const backupSummary =
    policies === null || policies.length === 0
      ? ts.backupSummaryNone
      : interpolate(ts.backupSummaryConfigured, {
          count: String(policies.length),
          preDeploy: preDeployOn ? ts.on : ts.off,
        });

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-foreground">{ts.rollbackTitle}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">{ts.rollbackHint}</p>
      </div>

      <RollbackRetentionCards
        strategy={strategy}
        capacity={effective}
        artifactKind={artifactKind}
        onToggleStrategy={toggleStrategy}
        onChangeWindow={changeWindow}
        togglingStrategy={togglingStrategy}
        savingWindow={savingWindow}
      />

      {projectId ? (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-border/50 bg-muted/20 px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Archive className="size-4" />
            </div>
            <p className="truncate text-[12px] text-muted-foreground">{backupSummary}</p>
          </div>
          <button
            type="button"
            onClick={() => setEditingBackup(true)}
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-border/60 px-2.5 py-1.5 text-[12px] font-medium text-foreground transition-colors hover:bg-muted"
          >
            {ts.backupManage}
            <ExternalLink className="size-3.5" />
          </button>
        </div>
      ) : (
        <p className="text-[12px] text-muted-foreground">{ts.rollbackFirstDeploy}</p>
      )}

      {editingBackup && projectId ? (
        <PolicyEditor
          projectId={projectId}
          existing={(policies ?? []).find((p) => p.serviceId === null) ?? null}
          onClose={() => setEditingBackup(false)}
          onSaved={() => {
            setEditingBackup(false);
            void load();
          }}
        />
      ) : null}
    </div>
  );
}

export default RollbackBackupPanel;
