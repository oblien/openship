"use client";

import React, { useMemo } from "react";
import { ShieldCheck, Terminal, ShieldAlert, Server } from "lucide-react";
import { useDeployment } from "@/context/DeploymentContext";
import { useMonitorStream } from "@/hooks/useMonitorStream";
import { useI18n, interpolate } from "@/components/i18n-provider";
import type { RuntimeMode } from "@/context/deployment/types";

/**
 * Inline runtime-isolation picker for a self-hosted SERVER target — the
 * right-column "how it runs" panel, symmetric with CloudPowerPicker. Replaces
 * the old deploy-time modal: the choice is now a visible setting on the target
 * step, persisted to the project (see requestBuildAccess) so it sticks across
 * redeploys.
 *
 * Default: the RAM-aware recommendation (Sandboxed everywhere except <2 GB boxes
 * where the engine itself would contend for the app's memory). Applied
 * automatically only for a FRESH deploy — an existing project's saved choice is
 * hydrated into config.runtimeMode and respected, never overridden.
 */

// Below this RAM the sandbox engine contends for memory with the app — on a
// 512MB/1GB VPS that's a real problem. Above it Docker's overhead is
// single-digit-% CPU + ~30-80MB RAM, negligible vs. the isolation upside.
const TWO_GB = 2 * 1024 * 1024 * 1024;

const ServerRuntimePicker: React.FC<{ enabled?: boolean }> = ({ enabled = true }) => {
  const { config, updateConfig } = useDeployment();
  const { t } = useI18n();
  // Only stream the server's live stats while actually visible — the picker is
  // now always mounted (inside the accordion) so the panel can animate its
  // height, but we don't want a background stats stream when it's collapsed.
  const { stats } = useMonitorStream(config.serverId ?? null, enabled);

  const runtimeOptions: Array<{
    value: RuntimeMode;
    label: string;
    description: string;
    icon: React.ReactNode;
  }> = [
    {
      value: "docker",
      label: t.deploy.runtime.sandboxedLabel,
      description: t.deploy.runtime.sandboxedDesc,
      icon: <ShieldCheck className="size-5" />,
    },
    {
      value: "bare",
      label: t.deploy.runtime.directLabel,
      description: t.deploy.runtime.directDesc,
      icon: <Terminal className="size-5" />,
    },
  ];

  const lowRam = useMemo(() => (stats ? stats.memTotal < TWO_GB : false), [stats]);
  // Sandbox is the default everywhere — the safe, isolated norm. On a very small
  // box Direct uses less RAM, but that's surfaced as a caveat when the user
  // actually picks Direct (below), not a silent default flip. Keeps the common
  // case one obvious choice instead of a machine-dependent guess.
  const recommendedMode: RuntimeMode = "docker";
  const ramGB = stats ? (stats.memTotal / (1024 * 1024 * 1024)).toFixed(1) : null;
  const selected = config.runtimeMode;

  // NO auto-default effect here, deliberately.
  //
  // This used to apply `recommendedMode` from an effect gated on `if (!stats) return`
  // — and `stats` only streams while this panel is `enabled` (expanded). So the
  // "recommended" default landed only if the user opened Advanced: anyone who
  // didn't got DEFAULT_CONFIG's value and a summary badge reading
  // Direct/unsandboxed. The default now lives in DEFAULT_CONFIG.runtimeMode
  // ("docker"), where it applies whether or not this component ever renders.
  //
  // The gate was also pointless: `recommendedMode` is a constant, so there was
  // nothing to wait on. RAM only picks the caveat wording below.

  return (
    // Header outside the cards to match CloudPowerPicker / the left column's
    // heading rhythm, so the first card aligns across the grid row.
    <div className="space-y-3">
      <div>
        <h3 className="text-base font-semibold text-foreground flex items-center gap-2">
          <Server className="size-4 text-muted-foreground" />
          {t.deploy.runtime.heading}
        </h3>
        <p className="text-sm text-muted-foreground mt-0.5">
          {ramGB
            ? interpolate(t.deploy.runtime.subtitleRam, { ram: ramGB })
            : `${t.deploy.runtime.subtitle}.`}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 items-stretch">
        {runtimeOptions.map((option) => {
          const isSelected = selected === option.value;
          const isRecommended = option.value === recommendedMode;
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => updateConfig({ runtimeMode: option.value })}
              className={`h-full w-full rounded-xl border p-4 text-start transition-all ${
                isSelected
                  ? "border-primary bg-primary/5 ring-1 ring-primary/20"
                  : "border-border/50 bg-card hover:border-primary/30 hover:bg-primary/[0.02]"
              }`}
            >
              <div className="flex items-start gap-3">
                <span className={isSelected ? "text-primary" : "text-muted-foreground"}>
                  {option.icon}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className={`text-sm font-medium ${isSelected ? "text-foreground" : "text-muted-foreground"}`}>
                      {option.label}
                    </p>
                    {isRecommended && (
                      <span className="inline-flex items-center rounded-full bg-success-bg px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-success">
                        {t.deploy.runtime.recommended}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground leading-relaxed">
                    {option.description}
                  </p>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Security caveat — only when Direct is selected (don't preach when the
          safer option is already chosen). */}
      {selected === "bare" && (
        <div className="flex items-start gap-2.5 rounded-xl border border-warning-border bg-warning-bg px-3 py-2.5">
          <ShieldAlert className="size-4 text-warning shrink-0 mt-0.5" />
          <p className="text-[12px] leading-relaxed text-warning">
            {lowRam ? t.deploy.runtime.caveatLowRam : t.deploy.runtime.caveat}
          </p>
        </div>
      )}
    </div>
  );
};

export default React.memo(ServerRuntimePicker);
