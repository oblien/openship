"use client";

import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { useCallback, useEffect, useMemo, useState } from "react";
import { flattenSettingFields, type AppSettingField } from "@repo/core";
import { appsApi, type AppSettingsView } from "@/lib/api/apps";
import { fk, seedFormValues, buildChanges, type FormValue } from "./AppSettingsForm";

/**
 * Load/edit/save state for an installed app's curated settings — the single
 * data path behind both the day-2 Settings tab and the install-time wizard step.
 * Writes go through the service-scoped `PATCH /projects/:id/app-settings` (safe
 * merge), so both surfaces target the exact same runtime env rows.
 */
export function useAppSettings(projectId: string) {
  const [view, setView] = useState<AppSettingsView | null>(null);
  const [values, setValues] = useState<Record<string, FormValue>>({});
  const [initial, setInitial] = useState<Record<string, FormValue>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);

  const reload = useCallback(
    async (opts?: { silent?: boolean }) => {
      // `silent` skips the full-view loading flag — used for the post-save
      // re-sync so the form re-seeds in place instead of flashing to a spinner.
      if (!opts?.silent) setLoading(true);
      setError(false);
      try {
        const res = await appsApi.getSettings(projectId);
        setView(res.data);
        const seeded = seedFormValues(res.data);
        setValues(seeded);
        setInitial(seeded);
        return res.data;
      } catch (e) {
        observeCaughtError(e, "dashboard/components/app-settings/useAppSettings");
        setError(true);
        return null;
      } finally {
        if (!opts?.silent) setLoading(false);
      }
    },
    [projectId],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  const fields = useMemo(() => (view ? flattenSettingFields(view.groups) : []), [view]);

  const setMap = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const v of view?.values ?? []) m.set(fk(v.service, v.key), v.set);
    return m;
  }, [view]);
  const isSet = useCallback(
    (f: AppSettingField) => !!setMap.get(fk(f.service, f.key)),
    [setMap],
  );

  const changes = useMemo(() => buildChanges(fields, values, initial), [fields, values, initial]);
  const dirty = changes.length > 0;

  const setField = useCallback(
    (f: AppSettingField, v: FormValue) =>
      setValues((prev) => ({ ...prev, [fk(f.service, f.key)]: v })),
    [],
  );

  /** Persist current changes (merge, service-scoped) and re-sync to the saved
   *  state. Returns the API result, or null when there was nothing to save. */
  const save = useCallback(async () => {
    if (changes.length === 0) return null;
    setSaving(true);
    try {
      const res = await appsApi.updateSettings(projectId, changes);
      await reload({ silent: true });
      return res.data;
    } finally {
      setSaving(false);
    }
  }, [projectId, changes, reload]);

  return {
    view,
    loading,
    saving,
    error,
    fields,
    values,
    setField,
    isSet,
    changes,
    dirty,
    reload,
    save,
  };
}
