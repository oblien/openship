"use client";

/**
 * Self-contained content for the resource-grant picker modal — rendered via the
 * centralized `showModal` hook (which supplies the blurred, centered Modal
 * shell). It owns its own grant selection state (showModal snapshots
 * customContent, so the content must be self-contained to stay reactive) and
 * hands the final selection back through `onSave`.
 *
 * Shared by BOTH the member-grants editor and the token-scope picker.
 */

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { ResourcePicker } from "@/components/permissions/ResourcePicker";
import type { PickerGrant, ResourceType } from "@/lib/api";
import { useI18n } from "@/components/i18n-provider";

export function GrantPickerModal({
  title,
  subtitle,
  initial,
  availableTypes,
  saveLabel,
  onSave,
  onClose,
}: {
  title: string;
  subtitle?: string;
  initial: PickerGrant[];
  availableTypes?: ResourceType[];
  saveLabel?: string;
  /** Called with the final selection. Throw to keep the modal open. */
  onSave: (grants: PickerGrant[]) => Promise<void> | void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [grants, setGrants] = useState<PickerGrant[]>(initial);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(grants);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col max-h-[85vh]">
      <div className="p-6 border-b border-border/50">
        <h3 className="text-base font-semibold text-foreground">{title}</h3>
        {subtitle && <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>}
      </div>
      <div className="flex-1 overflow-y-auto p-6">
        <ResourcePicker
          value={grants}
          onChange={setGrants}
          availableTypes={availableTypes}
          defaultPermissions={["read"]}
          disabled={saving}
        />
      </div>
      <div className="flex items-center justify-end gap-2 p-6 border-t border-border/50">
        <button
          type="button"
          onClick={onClose}
          disabled={saving}
          className="px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
        >
          {t.settings.common.cancel}
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-xl text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          {saving && <Loader2 className="size-4 animate-spin" />}
          {saveLabel ?? t.settings.common.save}
        </button>
      </div>
    </div>
  );
}
