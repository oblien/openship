"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import React from "react";
import { useDeployment } from "@/context/DeploymentContext";
import { STACK_ICONS } from "@repo/core";
import { useI18n } from "@/components/i18n-provider";

const DockerSettings: React.FC = () => {
  const { config, updateConfig } = useDeployment();
  const { t } = useI18n();
  const iconUrl = STACK_ICONS["docker"];

  return (
    <div className="bg-card rounded-2xl border border-border/50">
      <div className="px-5 py-5 space-y-5">
        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-primary/10 rounded-xl">
            {iconUrl ? (
              <img src={iconUrl} alt="Docker" className="w-6 h-6" />
            ) : (
              <UiIcon name="docker" className="w-6 h-6 text-primary" />
            )}
          </div>
          <div>
            <h3 className="text-[15px] font-semibold text-foreground">{t.importProject.dockerSettings.title}</h3>
            <p className="text-xs text-muted-foreground">
              {t.importProject.dockerSettings.subtitle}
            </p>
          </div>
        </div>

        {/* Info card */}
        <div className="p-4 bg-muted/30 rounded-xl border border-border/50">
          <p className="text-sm text-muted-foreground leading-relaxed">
            {t.importProject.dockerSettings.infoCard}
          </p>
        </div>

        {/* Port config */}
        <div>
          <label className="flex items-center gap-2 text-sm font-medium text-foreground mb-2">
            <span className="text-muted-foreground">
              <UiIcon name="hash" className="size-4" />
            </span>
            {t.importProject.dockerSettings.exposedPort}
          </label>
          <input
            type="number"
            value={config.options.productionPort}
            onChange={(e) => updateConfig({
              productionPortTouched: true,
              lastAutoDetectedEnvPort: null,
              options: {
                ...config.options,
                productionPort: e.target.value,
              },
            })}
            placeholder="3000"
            min={1}
            max={65535}
            className="w-full px-4 py-2.5 bg-muted/30 border border-border/50 rounded-xl text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
          />
          <p className="text-xs text-muted-foreground mt-1.5">
            {t.importProject.dockerSettings.portHint}
          </p>
        </div>
      </div>
    </div>
  );
};

export default React.memo(DockerSettings);
