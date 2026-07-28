"use client";

import { useState, useEffect, useCallback } from "react";
import { Check, Loader2, Zap, ShieldCheck, Network, Waypoints } from "lucide-react";
import { settingsApi } from "@/lib/api";
import type { RouteStrategy } from "@/lib/api/settings";
import { useToast } from "@/context/ToastContext";
import { SettingsSection } from "./SettingsSection";
import { useI18n, interpolate } from "@/components/i18n-provider";

// RouteStrategy value → i18n key (hyphenated values → camelCase keys).
const ROUTE_MODES: {
  value: RouteStrategy;
  key: "auto" | "loopbackPort" | "containerIp";
  icon: React.ElementType;
}[] = [
  { value: "auto", key: "auto", icon: Zap },
  { value: "loopback-port", key: "loopbackPort", icon: ShieldCheck },
  { value: "container-ip", key: "containerIp", icon: Network },
];

export function RoutePreferences() {
  const { showToast } = useToast();
  const { t } = useI18n();
  const [routeStrategy, setRouteStrategy] = useState<RouteStrategy>("auto");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const fetchSettings = useCallback(async () => {
    try {
      setLoading(true);
      const res = await settingsApi.get();
      if (res?.routeStrategy) setRouteStrategy(res.routeStrategy);
    } catch {
      /* silent */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  async function handleChange(mode: RouteStrategy) {
    if (mode === routeStrategy) return;
    const prev = routeStrategy;
    setRouteStrategy(mode);
    setSaving(true);
    try {
      await settingsApi.updateRouteStrategy(mode);
      const label = t.settings.routePreferences.modes[ROUTE_MODES.find((m) => m.value === mode)!.key].label;
      showToast(
        interpolate(t.settings.routePreferences.toast.setTo, { mode: label }),
        "success",
        t.settings.common.toast.settings,
      );
    } catch {
      setRouteStrategy(prev);
      showToast(t.settings.routePreferences.toast.failed, "error", t.settings.common.toast.settings);
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsSection
      icon={Waypoints}
      title={t.settings.routePreferences.title}
      description={t.settings.routePreferences.description}
      iconBg="bg-sky-500/10"
      iconColor="text-sky-500"
      collapsible
      defaultOpen={false}
    >
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
          <Loader2 className="size-4 animate-spin" />
          {t.settings.routePreferences.loading}
        </div>
      ) : (
        <>
          <p className="text-sm text-muted-foreground mb-4">{t.settings.routePreferences.intro}</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {ROUTE_MODES.map(({ value, key, icon: ModeIcon }) => {
              const active = routeStrategy === value;
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
                    <ModeIcon className="size-4 text-muted-foreground" />
                  </div>
                  <p className="text-sm font-medium text-foreground">
                    {t.settings.routePreferences.modes[key].label}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {t.settings.routePreferences.modes[key].desc}
                  </p>
                  {active && (
                    <div className="absolute top-3 end-3">
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
