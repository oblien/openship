"use client";

import { Icon as UiIcon, type IconName } from "@repo/ui/icons";

import { useState, useEffect, useCallback } from "react";
import { settingsApi } from "@/lib/api";
import type { BuildMode } from "@/lib/api/settings";
import { useToast } from "@/context/ToastContext";
import { SettingsSection } from "./SettingsSection";
import { useI18n, interpolate } from "@/components/i18n-provider";

const BUILD_MODES: {
  value: BuildMode;
  icon: IconName;
}[] = [
  { value: "auto", icon: "bolt" },
  { value: "server", icon: "server" },
  { value: "local", icon: "laptop" },
];

export function BuildPreferences() {
  const { showToast } = useToast();
  const { t } = useI18n();
  const [buildMode, setBuildMode] = useState<BuildMode>("auto");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const fetchSettings = useCallback(async () => {
    try {
      setLoading(true);
      const res = await settingsApi.get();
      if (res?.buildMode) setBuildMode(res.buildMode);
    } catch {
      /* silent */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  async function handleChange(mode: BuildMode) {
    if (mode === buildMode) return;
    const prev = buildMode;
    setBuildMode(mode);
    setSaving(true);
    try {
      await settingsApi.updateBuildMode(mode);
      showToast(interpolate(t.settings.buildPreferences.toast.setTo, { mode }), "success", t.settings.common.toast.settings);
    } catch {
      setBuildMode(prev);
      showToast(t.settings.buildPreferences.toast.failed, "error", t.settings.common.toast.settings);
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsSection
      icon={"sliders"}
      title={t.settings.buildPreferences.title}
      description={t.settings.buildPreferences.description}
      iconBg="bg-orange-500/10"
      iconColor="text-orange-500"
      collapsible
      defaultOpen={false}
    >
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
          <UiIcon name="spinner" className="size-4 animate-spin" />
          {t.settings.buildPreferences.loading}
        </div>
      ) : (
        <>
          <p className="text-sm text-muted-foreground mb-4">
            {t.settings.buildPreferences.intro}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {BUILD_MODES.map(({ value, icon: ModeIcon }) => {
              const active = buildMode === value;
              return (
                <button
                  key={value}
                  onClick={() => handleChange(value)}
                  disabled={saving}
                  className={`relative text-start rounded-xl border p-4 transition-all ${
                    active
                      ? "border-primary/50 bg-primary/5 ring-1 ring-primary/20"
                      : "border-border/50 bg-card hover:bg-muted/40 hover:border-border"
                  } disabled:opacity-50`}
                >
                  <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center mb-3">
                    <UiIcon name={ModeIcon} className="size-4 text-muted-foreground" />
                  </div>
                  <p className="text-sm font-medium text-foreground">{t.settings.buildPreferences.modes[value].label}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{t.settings.buildPreferences.modes[value].desc}</p>
                  {active && (
                    <div className="absolute top-3 end-3">
                      <UiIcon name="check" className="size-4 text-primary" />
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </>
      )}
    </SettingsSection>
  );
}
