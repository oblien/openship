"use client";

/**
 * Settings → General → Preferences. Personal, per-browser display preferences
 * (nothing sent to the server). Collapsed by default. Currently holds Demo mode
 * (blur IPs/hosts for screen-shares); add future client-side toggles as rows.
 */

import { SlidersHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import { SettingsSection } from "./SettingsSection";
import { Toggle } from "@/components/project-settings/ServerSideSwitch";
import { useDemoMode, setDemoMode } from "@/lib/demo-mode";

export function PreferencesSetting() {
  const demoMode = useDemoMode();

  return (
    <SettingsSection
      icon={SlidersHorizontal}
      title="Preferences"
      description="Personal display preferences for this browser — nothing is sent to the server."
      collapsible
    >
      <div className="space-y-3">
        <PreferenceRow
          title="Demo mode"
          hint="Blur IP addresses and hosts across the dashboard — for screen-shares, recordings, and live demos."
          checked={demoMode}
          onChange={setDemoMode}
        />
      </div>
    </SettingsSection>
  );
}

function PreferenceRow({
  title,
  hint,
  checked,
  onChange,
}: {
  title: string;
  hint: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-border/50 bg-muted/10 p-4">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <Toggle checked={checked} onChange={onChange} aria-label={title} />
    </div>
  );
}
