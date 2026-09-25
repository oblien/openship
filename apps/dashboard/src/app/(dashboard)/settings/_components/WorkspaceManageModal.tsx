"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

/**
 * Manage a TEAM workspace (owner-only): rename it, pause every project to
 * come back later, or delete it.
 *
 * Delete is deliberate + real: deleting the org alone would CASCADE-wipe the
 * project rows while leaving live containers / edge routes orphaned. So the
 * flow tears each project down properly (projectsApi.delete → server-side
 * teardownProject) BEFORE removing the org, and gates the whole thing behind a
 * type-the-name confirmation. Volume data is left recoverable (no wipeVolumes).
 */

import { useCallback, useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { projectsApi, getApiErrorMessage } from "@/lib/api";
import { useToast } from "@/context/ToastContext";
import { useI18n, interpolate } from "@/components/i18n-provider";

// Module-level (see TeamTab for the Better Auth Proxy-dep explanation).
const orgClient = (authClient as unknown as {
  organization: {
    update: (opts: { organizationId: string; data: { name?: string } }) => Promise<{ error?: { message?: string } }>;
    delete: (opts: { organizationId: string }) => Promise<{ error?: { message?: string; code?: string } }>;
  };
}).organization;

interface WsProject {
  id: string;
  name: string;
  enabled: boolean;
}

interface WorkspaceManageModalProps {
  organizationId: string;
  organizationName: string;
  onClose: () => void;
  /** Renamed in place — parent refreshes its labels. */
  onRenamed: (name: string) => void;
  /** Workspace deleted — parent switches to the personal workspace + reloads. */
  onDeleted: () => void;
}

export function WorkspaceManageModal({
  organizationId,
  organizationName,
  onClose,
  onRenamed,
  onDeleted,
}: WorkspaceManageModalProps) {
  const { showToast } = useToast();
  const { t } = useI18n();
  const m = t.settings.team.workspace.manage;

  const [name, setName] = useState(organizationName);
  const [renaming, setRenaming] = useState(false);
  const [projects, setProjects] = useState<WsProject[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [pausing, setPausing] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);

  const loadProjects = useCallback(async () => {
    setLoadingProjects(true);
    try {
      const res = await projectsApi.getHome();
      const list = (res.projects ?? []).map((p: { id: string; name: string; enabled?: boolean }) => ({
        id: String(p.id),
        name: p.name,
        enabled: p.enabled !== false,
      }));
      setProjects(list);
    } catch {
      setProjects([]);
    } finally {
      setLoadingProjects(false);
    }
  }, []);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const busy = renaming || pausing || deleting;

  const handleRename = async () => {
    const next = name.trim();
    if (!next || next === organizationName) return;
    setRenaming(true);
    try {
      const res = await orgClient.update({ organizationId, data: { name: next } });
      if (res.error) {
        showToast(res.error.message ?? m.toastRenameFailed, "error", t.settings.common.toast.team);
        return;
      }
      showToast(m.toastRenamed, "success", t.settings.common.toast.team);
      onRenamed(next);
    } catch (err) {
      showToast(getApiErrorMessage(err, m.toastRenameFailed), "error", t.settings.common.toast.team);
    } finally {
      setRenaming(false);
    }
  };

  const handlePauseAll = async () => {
    const running = projects.filter((p) => p.enabled);
    if (running.length === 0) return;
    setPausing(true);
    let failed = 0;
    for (const p of running) {
      try {
        await projectsApi.toggle(p.id, false);
      } catch {
        failed += 1;
      }
    }
    setPausing(false);
    await loadProjects();
    if (failed > 0) {
      showToast(m.toastPauseFailed, "error", t.settings.common.toast.team);
    } else {
      showToast(interpolate(m.toastPaused, { count: String(running.length) }), "success", t.settings.common.toast.team);
    }
  };

  const confirmMatches = confirmText.trim().toLowerCase() === organizationName.trim().toLowerCase();

  const handleDelete = async () => {
    if (!confirmMatches || deleting) return;
    setDeleting(true);
    try {
      // Tear each project down for real (containers/routes over SSH) so the
      // org delete's row-cascade doesn't orphan live infra. force cancels
      // in-flight work; forceOrphan drops rows stuck on an unreachable server.
      for (const p of projects) {
        setProgress(interpolate(m.deletingProject, { name: p.name }));
        try {
          await projectsApi.delete(p.id, { force: true, forceOrphan: true });
        } catch (err) {
          setProgress(null);
          showToast(
            getApiErrorMessage(err, interpolate(m.toastProjectFailed, { name: p.name })),
            "error",
            t.settings.common.toast.team,
          );
          setDeleting(false);
          await loadProjects();
          return;
        }
      }
      setProgress(m.deletingWorkspace);
      const res = await orgClient.delete({ organizationId });
      if (res.error) {
        const msg =
          res.error.code === "ORG_DELETE_BILLING_ACTIVE"
            ? t.settings.team.toast.deleteBillingActive
            : res.error.message ?? t.settings.team.toast.deleteFailed;
        showToast(msg, "error", t.settings.common.toast.team);
        setDeleting(false);
        setProgress(null);
        return;
      }
      showToast(t.settings.team.toast.deleted, "success", t.settings.common.toast.team);
      onDeleted();
    } catch (err) {
      showToast(getApiErrorMessage(err, t.settings.team.toast.deleteFailed), "error", t.settings.common.toast.team);
      setDeleting(false);
      setProgress(null);
    }
  };

  const runningCount = projects.filter((p) => p.enabled).length;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6 backdrop-blur-sm"
      onClick={() => !busy && onClose()}
    >
      <div
        className="max-h-[90vh] w-full max-w-lg overflow-hidden rounded-2xl border border-border/50 bg-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border/50 px-6 py-4">
          <h2 className="text-base font-semibold text-foreground">{m.title}</h2>
          <button
            type="button"
            onClick={() => !busy && onClose()}
            className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted/50 hover:text-foreground disabled:opacity-50"
            disabled={busy}
          >
            <UiIcon name="close" className="size-4" />
          </button>
        </div>

        <div className="max-h-[calc(90vh-64px)] space-y-6 overflow-y-auto p-6">
          {/* Rename */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">{m.nameLabel}</label>
            <div className="flex gap-2">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="min-w-0 flex-1 rounded-xl border border-border/60 bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary/50"
              />
              <button
                type="button"
                onClick={handleRename}
                disabled={busy || !name.trim() || name.trim() === organizationName}
                className="inline-flex shrink-0 items-center gap-2 rounded-xl bg-muted/60 px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
              >
                {renaming ? <UiIcon name="spinner" className="size-4 animate-spin" /> : <UiIcon name="edit" className="size-4" />}
                {m.rename}
              </button>
            </div>
          </div>

          {/* Projects */}
          <div>
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              {interpolate(m.projects, { count: String(projects.length) })}
            </p>
            <div className="overflow-hidden rounded-xl border border-border/50">
              {loadingProjects ? (
                <div className="flex items-center justify-center py-8">
                  <UiIcon name="spinner" className="size-4 animate-spin text-muted-foreground" />
                </div>
              ) : projects.length === 0 ? (
                <div className="px-4 py-6 text-center text-xs text-muted-foreground">{m.noProjects}</div>
              ) : (
                <div className="divide-y divide-border/40">
                  {projects.map((p) => (
                    <div key={p.id} className="flex items-center gap-3 px-4 py-2.5">
                      <UiIcon name="folder-open" className="size-4 shrink-0 text-muted-foreground" />
                      <span className="flex-1 truncate text-sm text-foreground">{p.name}</span>
                      <span
                        className={`text-[11px] font-medium uppercase tracking-wide ${
                          p.enabled ? "text-success" : "text-muted-foreground"
                        }`}
                      >
                        {p.enabled ? m.running : m.stopped}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Danger zone */}
          <div className="space-y-4 rounded-xl border border-border/50 bg-muted/[0.03] p-4">
            {/* Pause everything */}
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">{m.pauseTitle}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{m.pauseBody}</p>
              </div>
              <button
                type="button"
                onClick={handlePauseAll}
                disabled={busy || runningCount === 0}
                className="inline-flex shrink-0 items-center gap-2 rounded-xl border border-border/60 bg-background px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted/50 disabled:opacity-50"
              >
                {pausing ? <UiIcon name="spinner" className="size-4 animate-spin" /> : <UiIcon name="square" className="size-4" />}
                {m.pauseButton}
              </button>
            </div>

            <div className="border-t border-border/40" />

            {/* Delete */}
            <div>
              <p className="text-sm font-medium text-destructive">{m.deleteTitle}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {projects.length > 0
                  ? interpolate(m.deleteBody, { count: String(projects.length) })
                  : t.settings.team.workspace.deleteBody}
              </p>
              <label className="mb-1.5 mt-3 block text-xs text-muted-foreground">
                {interpolate(m.confirmLabel, { name: organizationName })}
              </label>
              <input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={organizationName}
                disabled={deleting}
                className="w-full rounded-xl border border-border/60 bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-destructive/50"
              />
              <button
                type="button"
                onClick={handleDelete}
                disabled={!confirmMatches || busy}
                className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-destructive px-4 py-2.5 text-sm font-medium text-destructive-foreground transition-colors hover:bg-destructive/90 disabled:opacity-50"
              >
                {deleting ? <UiIcon name="spinner" className="size-4 animate-spin" /> : <UiIcon name="trash" className="size-4" />}
                {deleting ? progress ?? m.deleting : t.settings.team.workspace.deleteWorkspace}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
