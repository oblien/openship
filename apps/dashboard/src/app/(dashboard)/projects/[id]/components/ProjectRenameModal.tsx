"use client";

import { useEffect, useState } from "react";
import { Loader2, Pencil, X } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { useToast } from "@/context/ToastContext";
import { getApiErrorMessage, projectsApi } from "@/lib/api";
import { invalidateProjectCaches } from "@/hooks/useProjectEndpoints";

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Rename a project — the DISPLAY NAME only.
 *
 * The project's slug is its infrastructure identity (docker network, container and
 * volume names, and the hostname the free `*.opsh.io` route was seeded from), so the
 * server deliberately freezes it on a rename. That's stated in the modal rather than
 * left implicit: a name edit that silently moved a live URL — or pointed the next
 * deploy at empty volumes — is exactly the surprise this copy exists to prevent.
 *
 * The 409 ("already exists") lands inline under the field instead of in a toast: it's
 * a verdict on the value the user just typed, and it has to stay on screen while they
 * fix it.
 */
export const ProjectRenameModal = ({ isOpen, onClose }: Props) => {
  const { t } = useI18n();
  const { showToast } = useToast();
  const { projectData, updateProjectData } = useProjectSettings();
  const c = t.projectSettings.advanced.rename;

  const current = projectData?.name || "";
  const slug = (projectData?.slug as string | undefined) || "";

  const [value, setValue] = useState(current);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed on OPEN only — the instance is kept mounted (both the ⋮ and the name-row
  // pencil open this one), so a cancelled edit would otherwise persist into the next
  // open. Deliberately not keyed on `current`: re-seeding whenever the project
  // payload refreshes would overwrite what the user is part-way through typing.
  useEffect(() => {
    if (!isOpen) return;
    setValue(current);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const trimmed = value.trim();
  const canSave = trimmed.length > 0 && trimmed !== current && !saving;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await projectsApi.update(projectData.id, { name: trimmed });
      updateProjectData({ name: trimmed });
      // The info endpoint is cached per project id — without this a remount serves
      // the old name back over the optimistic update.
      invalidateProjectCaches(projectData.id);
      showToast(interpolate(c.toast.renamed, { name: trimmed }), "success", c.title);
      onClose();
    } catch (err) {
      setError(getApiErrorMessage(err, c.toast.failed));
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) return null;

  return (
    <Modal isOpen onClose={onClose} closable={!saving} showCloseButton={false} maxWidth="28rem">
      <div className="space-y-5 p-6">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="size-10 shrink-0 rounded-xl bg-primary/15 flex items-center justify-center">
              <Pencil className="size-4 text-primary" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-foreground">{c.title}</h3>
              <p className="mt-1 text-xs text-muted-foreground">{c.description}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="shrink-0 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:opacity-50"
            aria-label={c.cancel}
          >
            <X className="size-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-foreground" htmlFor="project-rename">
              {c.label}
            </label>
            <input
              id="project-rename"
              type="text"
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setError(null);
              }}
              maxLength={100}
              autoFocus
              disabled={saving}
              placeholder={c.placeholder}
              aria-invalid={error ? true : undefined}
              className={`w-full rounded-xl border bg-muted/30 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 transition-all focus:outline-none focus:ring-2 ${
                error
                  ? "border-danger-border focus:ring-danger-solid/20"
                  : "border-border/50 focus:ring-primary/20"
              }`}
            />
            {error && <p className="text-xs text-danger">{error}</p>}
          </div>

          {slug && (
            <p className="rounded-xl border border-border/50 bg-muted/[0.04] p-3 text-xs leading-relaxed text-muted-foreground">
              {interpolate(c.identityNote, { slug })}
            </p>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
            >
              {c.cancel}
            </button>
            <button
              type="submit"
              disabled={!canSave}
              className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {saving && <Loader2 className="size-3.5 animate-spin" />}
              {c.save}
            </button>
          </div>
        </form>
      </div>
    </Modal>
  );
};
