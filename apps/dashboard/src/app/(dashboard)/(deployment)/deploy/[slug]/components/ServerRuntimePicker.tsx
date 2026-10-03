"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import React, { useMemo } from "react";
import { useDeployment } from "@/context/DeploymentContext";
import { useMonitorStream } from "@/hooks/useMonitorStream";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { OptionCard } from "@/components/shared/OptionCard";
import type { RuntimeMode } from "@/context/deployment/types";

/** Connected and managed servers share this runtime choice. Deployment config
 * owns the sandboxed default and preserves an existing project's saved value. */

// Below this RAM the sandbox engine contends for memory with the app — on a
// 512MB/1GB VPS that's a real problem. Above it Docker's overhead is
// single-digit-% CPU + ~30-80MB RAM, negligible vs. the isolation upside.
const TWO_GB = 2 * 1024 * 1024 * 1024;

const ServerRuntimePicker: React.FC<{ enabled?: boolean }> = ({ enabled = true }) => {
  const { config, updateConfig } = useDeployment();
  const { t } = useI18n();
  // Live memory changes the Direct caveat, never the selected runtime.
  const { stats } = useMonitorStream(config.serverId ?? null, enabled && !!config.serverId);

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
      icon: <UiIcon name="shield-check" className="size-5" />,
    },
    {
      value: "bare",
      label: t.deploy.runtime.directLabel,
      description: t.deploy.runtime.directDesc,
      icon: <UiIcon name="terminal" className="size-5" />,
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

  return (
    // Runtime and resource controls share the destination page's section rhythm.
    <div className="@container/runtime space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <UiIcon name="server" className="size-4 text-muted-foreground" />
          {t.deploy.runtime.heading}
        </h3>
        <p className="text-sm text-muted-foreground mt-0.5">
          {ramGB
            ? interpolate(t.deploy.runtime.subtitleRam, { ram: ramGB })
            : `${t.deploy.runtime.subtitle}.`}
        </p>
      </div>

      <div className="grid grid-cols-1 items-stretch gap-3 @min-[24rem]/runtime:grid-cols-2">
        {runtimeOptions.map(option => (
          <OptionCard
            key={option.value}
            value={option.value}
            selected={selected === option.value}
            onSelect={() => updateConfig({ runtimeMode: option.value })}
            icon={option.icon}
            label={option.label}
            description={option.description}
            badge={option.value === recommendedMode && (
              <span className="inline-flex items-center rounded-md bg-success-bg px-1.5 py-0.5 text-xs font-medium text-success">
                {t.deploy.runtime.recommended}
              </span>
            )}
          />
        ))}
      </div>

      {/* Security caveat — only when Direct is selected (don't preach when the
          safer option is already chosen). */}
      {selected === "bare" && (
        <div className="flex items-start gap-2.5 rounded-xl border border-warning-border bg-warning-bg px-3 py-2.5">
          <UiIcon name="shield-alert" className="size-4 text-warning shrink-0 mt-0.5" />
          <p className="text-xs leading-relaxed text-warning">
            {lowRam ? t.deploy.runtime.caveatLowRam : t.deploy.runtime.caveat}
          </p>
        </div>
      )}
    </div>
  );
};

export default React.memo(ServerRuntimePicker);
