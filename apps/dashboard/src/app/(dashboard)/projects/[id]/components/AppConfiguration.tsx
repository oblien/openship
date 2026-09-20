"use client";

import React, { useState } from "react";
import { isServicesFramework } from "@repo/core";
import { useI18n } from "@/components/i18n-provider";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { AppSettingsTab } from "./AppSettingsTab";
import { ServicesTab } from "./ServicesTab";
import { BuildSettings, ProjectEnvironmentSettings } from "./BuildSettings";

/**
 * The Configuration tab for an installed app — one surface, two modes:
 *  - "App settings": the business-logic form (schema → env), the friendly view.
 *  - "Deployment": the raw deployment config (per-service for compose apps,
 *    build/runtime for single-container apps).
 * Both edit the same project; apps are otherwise identical to any project. No
 * new tab — this is the content of the existing Configuration tab for apps.
 */
export function AppConfiguration() {
  const { t } = useI18n();
  const ps = t.projectSettings.appSettings;
  const { projectData } = useProjectSettings();
  const [mode, setMode] = useState<"app" | "deployment">("app");

  const isServices = isServicesFramework(projectData.framework);

  return (
    <div className="space-y-5">
      <div className="inline-flex rounded-xl border border-border bg-muted/40 p-1">
        {(
          [
            ["app", ps.modeApp],
            ["deployment", ps.modeDeployment],
          ] as const
        ).map(([m, label]) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={`rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors ${
              mode === m
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === "app" ? (
        <AppSettingsTab />
      ) : isServices ? (
        <>
          <ProjectEnvironmentSettings />
          <ServicesTab />
        </>
      ) : (
        <BuildSettings />
      )}
    </div>
  );
}
