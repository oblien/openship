"use client";

import React from "react";
import { Globe, Link2, Ban } from "lucide-react";
import PublicEndpointsCard from "@/components/routing/PublicEndpointsCard";
import { OptionCard } from "@/app/(dashboard)/(deployment)/deploy/[slug]/components/DeployTargetStep";
import type { PublicEndpoint } from "@/context/deployment/types";

/**
 * Free / Custom / None routing picker. "None" = no public route (the deploy
 * builds and runs but nothing is exposed) — the backend treats an empty
 * publicEndpoints set as no route (preflight warns, no Cloud gate). Free/Custom
 * drive the endpoint's domainType; the inner card's own type toggle is hidden
 * so this picker is the single source of the free-vs-custom choice.
 */
export type RoutingMode = "free" | "custom" | "none";

export interface RoutingModeLabels {
  freeLabel: string;
  freeDesc: string;
  customLabel: string;
  customDesc: string;
  noneLabel: string;
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
  return (
    <div className="space-y-2">
      <OptionCard
        value="free"
        selected={mode === "free"}
        onSelect={() => onModeChange("free")}
        icon={<Globe className="size-4" />}
        label={labels.freeLabel}
        description={labels.freeDesc}
      />
      <OptionCard
        value="custom"
        selected={mode === "custom"}
        onSelect={() => onModeChange("custom")}
        icon={<Link2 className="size-4" />}
        label={labels.customLabel}
        description={labels.customDesc}
      />
      <OptionCard
        value="none"
        selected={mode === "none"}
        onSelect={() => onModeChange("none")}
        icon={<Ban className="size-4" />}
        label={labels.noneLabel}
        description={labels.noneDesc}
      />
      {mode !== "none" && (
        <div className="pt-2">
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
