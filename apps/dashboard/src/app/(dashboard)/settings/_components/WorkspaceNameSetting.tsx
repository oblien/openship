import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Icon as UiIcon } from "@repo/ui/icons";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/context/ToastContext";
import { getApiErrorMessage } from "@/lib/api";
import { renameWorkspace } from "@/lib/workspace-name";

interface WorkspaceNameSettingProps {
  organizationId: string;
  name: string;
  canRename: boolean;
  onRenamed: (name: string) => void;
}

export function WorkspaceNameSetting({
  organizationId,
  name,
  canRename,
  onRenamed,
}: WorkspaceNameSettingProps) {
  const { t } = useI18n();
  const { showToast } = useToast();
  const copy = t.settings.team.workspace.manage;
  const inputId = useId();
  const renameButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const editing = canRename && draft !== null;
  const next = draft?.trim();

  useEffect(() => {
    if (!editing && restoreFocus.current) {
      restoreFocus.current = false;
      renameButton.current?.focus();
    }
  }, [editing]);

  function closeEditor() {
    restoreFocus.current = true;
    setDraft(null);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing || !next || next === name || saving) return;
    setSaving(true);
    try {
      const { data, error } = await renameWorkspace(organizationId, next);
      if (error || data?.id !== organizationId) {
        showToast(error?.message ?? copy.toastRenameFailed, "error", t.settings.common.toast.team);
        return;
      }
      onRenamed(data.name);
      closeEditor();
      showToast(copy.toastRenamed, "success", t.settings.common.toast.team);
    } catch (error) {
      showToast(
        getApiErrorMessage(error, copy.toastRenameFailed),
        "error",
        t.settings.common.toast.team,
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-2xl bg-card px-4 py-3">
      {editing ? (
        <form className="space-y-2" onSubmit={save}>
          <label htmlFor={inputId} className="block text-sm text-muted-foreground">
            {copy.nameLabel}
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id={inputId}
              variant="filled"
              className="min-w-36 flex-1"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && !saving) closeEditor();
              }}
              disabled={saving}
              autoFocus
            />
            <Button type="button" variant="ghost" onClick={closeEditor} disabled={saving}>
              {t.settings.common.cancel}
            </Button>
            <Button type="submit" disabled={saving || !next || next === name}>
              {saving && <UiIcon name="spinner" className="animate-spin" />}
              {t.settings.common.save}
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm text-muted-foreground">{copy.nameLabel}</p>
            <p className="wrap-break-word text-sm font-medium text-foreground">{name}</p>
          </div>
          {canRename && (
            <Button ref={renameButton} type="button" variant="ghost" onClick={() => setDraft(name)}>
              <UiIcon name="edit" />
              {copy.rename}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
