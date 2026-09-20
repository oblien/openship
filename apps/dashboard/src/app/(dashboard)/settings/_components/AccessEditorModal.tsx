"use client";

/**
 * The shared access editor, in a modal.
 *
 * This replaces `GrantPickerModal`, which was the THIRD wrapper around
 * `ResourcePicker` and — because it was written independently of the MCP consent
 * screen — a materially poorer and partly incorrect one:
 *
 *   - no templates, and raw read/write/admin chips instead of the named levels,
 *     even though `ACCESS_LEVELS` / `LEVEL_PERMISSIONS` already existed;
 *   - no capability digest and no read-only conflict warnings;
 *   - it did NOT pass `suppressWildcardTypes`, so the token flow could build an
 *     "All projects · read/write" grant that `wildcardProjectGrantRejected` refuses
 *     with a 400 every single time — a live bug, not a cosmetic gap;
 *   - it computed `availableTypes` from a hardcoded array that disagreed with the
 *     consent screen about which types exist.
 *
 * Nothing here re-implements any of that. This file is a modal shell and a reducer;
 * every decision about what may be granted lives in `AccessControlEditor` and
 * `mcp-access-templates`. The reducer is HERE rather than in the editor for the same
 * reason it is at every other call site: the seed is the caller's decision, so an
 * edit surface can prefill from the server and never be silently defaulted.
 */

import { useMemo, useReducer, useState } from "react";
import { Loader2 } from "lucide-react";
import { AccessControlEditor } from "@/components/permissions/AccessControlEditor";
import {
  reduceSelection,
  type AccessSelection,
  type ScopeAction,
  type TemplateContext,
} from "@/components/permissions/mcp-access-templates";
import type { CatalogEntry, PickerGrant, ResourceType } from "@/lib/api";
import { useI18n } from "@/components/i18n-provider";

export function AccessEditorModal({
  title,
  subtitle,
  initial,
  availableTypes,
  saveLabel,
  /**
   * Which halves apply. Member grants pass all three off: "unscoped member" is
   * meaningless, `readOnly` is a property of a TOKEN, and the grants API's
   * permission whitelist has no `create`, so that switch would be a no-op.
   */
  show,
  /** Member grants pass `[]` — "All projects" is legitimate for a member, and only
   *  refused on a token. */
  suppressWildcardTypes,
  onSave,
  onClose,
}: {
  title: string;
  subtitle?: string;
  initial: PickerGrant[];
  availableTypes?: ResourceType[];
  saveLabel?: string;
  show?: { templates?: boolean; readOnlySwitch?: boolean; createCapability?: boolean };
  suppressWildcardTypes?: ResourceType[];
  /** Called with the final selection. Throw to keep the modal open. */
  onSave: (grants: PickerGrant[]) => Promise<void> | void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [saving, setSaving] = useState(false);
  const [labels, setLabels] = useState<ReadonlyMap<string, string>>(new Map());

  const ctx = useMemo<TemplateContext>(() => ({ githubAccounts: [] }), []);
  const [selection, dispatch] = useReducer(
    (state: AccessSelection, action: ScopeAction) => reduceSelection(state, action, ctx),
    initial,
    // Seeded from what the caller already holds. `custom` because these grants came
    // from the server (or from a prior edit), so naming a preset they may not match
    // would be a lie; `relabel` promotes it on the first edit if it does match.
    (grants): AccessSelection => ({ grants, readOnly: false, template: "custom" }),
  );

  const onCatalogLoaded = (type: ResourceType, entries: CatalogEntry[]) => {
    setLabels((prev) => {
      const next = new Map(prev);
      for (const e of entries) next.set(`${type} ${e.id}`, e.label);
      return next;
    });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(selection.grants);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-[15px] font-medium text-foreground">{title}</h2>
        {subtitle && (
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{subtitle}</p>
        )}
      </div>

      <AccessControlEditor
        selection={selection}
        dispatch={dispatch}
        availableTypes={availableTypes ?? []}
        ctx={ctx}
        orgKey="active"
        orgName=""
        labels={labels}
        onCatalogLoaded={onCatalogLoaded}
        layout="stacked"
        show={show}
        suppressWildcardTypes={suppressWildcardTypes}
        disabled={saving}
        footer={
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="rounded-lg px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              {t.settings.common.cancel}
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              {saving && <Loader2 className="size-3.5 animate-spin" />}
              {saveLabel ?? t.settings.common.save}
            </button>
          </div>
        }
      />
    </div>
  );
}
