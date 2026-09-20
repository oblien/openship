"use client";

import React, { useEffect, useState } from "react";
import { Loader2, RefreshCw, Save } from "lucide-react";
import { deployApi } from "@/lib/api";
import { getApiErrorMessage } from "@/lib/api/client";
import { useToast } from "@/context/ToastContext";
import { useCloudDeployPricing } from "@/hooks/useCloudDeployPricing";
import { useI18n } from "@/components/i18n-provider";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { AppSettingsForm, hasAdvancedFields } from "@/components/app-settings/AppSettingsForm";
import { useAppSettings } from "@/components/app-settings/useAppSettings";

/**
 * Day-2 curated settings for an installed app — a friendly form (the shared
 * <AppSettingsForm>) over the app's schema, instead of the raw per-service env
 * editor. Writes via the service-scoped merge endpoint; applied to the running
 * app with a no-rebuild restart. The install-time wizard step reuses the same
 * form + hook, so the two surfaces never diverge.
 */
export function AppSettingsTab() {
  const { id, projectData } = useProjectSettings();
  const { t } = useI18n();
  const ps = t.projectSettings.appSettings;
  const { showToast } = useToast();
  const showCloudPricing = useCloudDeployPricing();

  const s = useAppSettings(id);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [applying, setApplying] = useState(false);
  const [pendingApply, setPendingApply] = useState(false);
  const [needsRedeploy, setNeedsRedeploy] = useState(false);

  const hasActiveDeployment = !!projectData.activeDeploymentId;

  useEffect(() => {
    if (s.error) showToast(ps.loadError, "error");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.error]);

  const handleSave = async () => {
    if (!s.dirty) return;
    try {
      const res = await s.save();
      showToast(ps.saved, "success");
      if (hasActiveDeployment) {
        setPendingApply(true);
        setNeedsRedeploy(!!res?.requiresRedeploy);
      }
    } catch (err) {
      showToast(getApiErrorMessage(err, ps.saveFailed), "error");
    }
  };

  const handleApply = async () => {
    setApplying(true);
    try {
      await deployApi.trigger({ projectId: id, refresh: true });
      showToast(ps.applied, "success");
      setPendingApply(false);
    } catch (err) {
      if (!showCloudPricing(err)) showToast(getApiErrorMessage(err, ps.applyFailed), "error");
    } finally {
      setApplying(false);
    }
  };

  if (s.loading) {
    return (
      <div className="flex items-center justify-center py-20 text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }

  if (!s.view || s.view.management?.kind !== "schema" || s.view.groups.length === 0) {
    return (
      <div className="bg-card rounded-2xl border border-border/50 p-6 text-sm text-muted-foreground">
        {ps.unmanaged}
      </div>
    );
  }

  const hasAdvanced = hasAdvancedFields(s.view.groups);

  return (
    <div className="space-y-5">
      <AppSettingsForm
        groups={s.view.groups}
        values={s.values}
        onChange={s.setField}
        isSet={s.isSet}
        secretSetLabel={ps.secretSet}
        showAdvanced={showAdvanced}
      />

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={!s.dirty || s.saving}
          className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {s.saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
          {s.saving ? ps.saving : ps.saveChanges}
        </button>

        {pendingApply && (
          <button
            type="button"
            onClick={handleApply}
            disabled={applying}
            className="inline-flex items-center gap-2 rounded-xl border border-border bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted/50 disabled:opacity-50"
          >
            {applying ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            {applying ? ps.applying : ps.applyNow}
          </button>
        )}

        {hasAdvanced && (
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="ml-auto text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            {showAdvanced ? ps.advancedHide : ps.advancedShow}
          </button>
        )}
      </div>

      {pendingApply ? (
        <p className="text-xs text-muted-foreground">
          {needsRedeploy ? ps.redeployNote : ps.restartNote}
        </p>
      ) : (
        s.dirty && <p className="text-xs text-muted-foreground">{ps.saveHint}</p>
      )}
    </div>
  );
}
