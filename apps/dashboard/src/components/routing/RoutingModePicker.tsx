"use client";

import React from "react";
import { useI18n } from "@/components/i18n-provider";
import PublicEndpointsCard from "@/components/routing/PublicEndpointsCard";
import type { PublicEndpoint } from "@/context/deployment/types";

/**
 * Free / Custom / None routing picker, rendered as a COMPACT segmented tab (the
 * same style as the compose/docker wizard's domain tabs) rather than tall
 * stacked cards. "None" = no public route — the deploy builds and runs but
 * nothing is exposed; the backend treats an empty publicEndpoints set as no
 * route (preflight warns, no Cloud gate). Free/Custom drive the endpoint's
 * domainType; the inner card's own type toggle is hidden (`hideTypeToggle`) so
 * this picker is the single source of the free-vs-custom choice.
 */
export type RoutingMode = "free" | "custom" | "none";

export interface RoutingModeLabels {
  /** Label for the "None" tab (Free/Custom reuse the shared settingsCard i18n
   *  so they read identically to the wizard's domain tabs). */
  noneLabel: string;
  /** One-line explainer shown under the tabs while "None" is selected. */
  noneDesc: string;
}

interface RoutingModePickerProps {
  mode: RoutingMode;
  onModeChange: (mode: RoutingMode) => void;
  labels: RoutingModeLabels;
  // PublicEndpointsCard passthrough (rendered only when mode !== "none").
  projectName: string;
  endpoints: PublicEndpoint[];
  hasServer: boolean;
  runtimePort: string;
  onEndpointsChange: (endpoints: PublicEndpoint[], runtimePort?: string) => void;
  allowPortEdit?: boolean;
  saveMode?: "change" | "explicit";
}

// Segmented tab styling — identical to RoutingSettingsCard's Free/Custom tabs so
// the whole app switches domain type the same way.
const TAB_BASE = "px-4 py-2 rounded-xl text-sm font-medium transition-colors";
const TAB_ON = "bg-primary/10 text-primary ring-1 ring-primary/15";
const TAB_OFF = "bg-muted/40 text-muted-foreground hover:bg-muted/60";

export function RoutingModePicker({
  mode,
  onModeChange,
  labels,
  projectName,
  endpoints,
  hasServer,
  runtimePort,
  onEndpointsChange,
  allowPortEdit = false,
  saveMode = "change",
}: RoutingModePickerProps) {
  const { t } = useI18n();
  const w = t.widgets.routing.settingsCard;
  const tabs: Array<{ value: RoutingMode; label: string }> = [
    { value: "free", label: w.free },
    { value: "custom", label: w.custom },
    { value: "none", label: labels.noneLabel },
  ];

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        {tabs.map((tab) => (
          <button
            key={tab.value}
            type="button"
            onClick={() => onModeChange(tab.value)}
            aria-pressed={mode === tab.value}
            className={`${TAB_BASE} ${mode === tab.value ? TAB_ON : TAB_OFF}`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {mode === "none" ? (
        <p className="px-1 pt-0.5 text-xs text-muted-foreground">{labels.noneDesc}</p>
      ) : (
        <div className="pt-1">
          <PublicEndpointsCard
            projectName={projectName}
            endpoints={endpoints}
            hasServer={hasServer}
            runtimePort={runtimePort}
            allowPortEdit={allowPortEdit}
            saveMode={saveMode}
            hideTypeToggle
            onChange={onEndpointsChange}
          />
        </div>
      )}
    </div>
  );
}
