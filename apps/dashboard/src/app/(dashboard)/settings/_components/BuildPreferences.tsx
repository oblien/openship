"use client";

import { useState, useEffect, useCallback } from "react";
import { Check, Loader2, Zap, Server, Laptop, Settings2 } from "lucide-react";
import { settingsApi } from "@/lib/api";
import type { BuildMode } from "@/lib/api/settings";
import { useToast } from "@/context/ToastContext";
import { SettingsSection } from "./SettingsSection";

const BUILD_MODES: {
  value: BuildMode;
  label: string;
  desc: string;
  icon: React.ElementType;
}[] = [
  { value: "auto", label: "Auto", desc: "Smart per-framework", icon: Zap },
  { value: "server", label: "Server", desc: "Build on remote", icon: Server },
  { value: "local", label: "Local", desc: "Build on machine", icon: Laptop },
];

export function BuildPreferences() {
  const { showToast } = useToast();
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
      showToast(`Build mode set to ${mode}`, "success", "Settings");
    } catch {
      setBuildMode(prev);
      showToast("Failed to update build mode", "error", "Settings");
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsSection
      icon={Settings2}
      title="Build Preferences"
      description="Control how your projects are built and deployed"
      iconBg="bg-orange-500/10"
      iconColor="text-orange-500"
    >
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
          <Loader2 className="size-4 animate-spin" />
          Loading preferences…
        </div>
      ) : (
        <>
          <p className="text-sm text-muted-foreground mb-4">
            Choose the default build strategy for new deployments. Per-project
            overrides are available in project settings.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {BUILD_MODES.map(({ value, label, desc, icon: ModeIcon }) => {
              const active = buildMode === value;
              return (
                <button
                  key={value}
                  onClick={() => handleChange(value)}
                  disabled={saving}
                  className={`relative text-left rounded-xl border p-4 transition-all ${
                    active
                      ? "border-primary/50 bg-primary/5 ring-1 ring-primary/20"
                      : "border-border/50 bg-card hover:bg-muted/40 hover:border-border"
                  } disabled:opacity-50`}
                >
                  <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center mb-3">
                    <ModeIcon className="size-4 text-muted-foreground" />
                  </div>
                  <p className="text-sm font-medium text-foreground">{label}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{desc}</p>
                  {active && (
                    <div className="absolute top-3 right-3">
                      <Check className="size-4 text-primary" />
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
