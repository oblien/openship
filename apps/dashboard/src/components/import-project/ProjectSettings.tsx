"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import React, { useCallback, useState, useMemo } from "react";
import { frameworks, getFrameworkConfig, stackCategories } from "./Frameworks";
import type { StackCategory } from "./Frameworks";
import { STACKS } from "@repo/core";
import { useDeployment } from "@/context/DeploymentContext";
import { useI18n } from "@/components/i18n-provider";
import type { FrameworkId } from "./types";
import { Button } from "@/components/ui/button";

const ProjectSettings: React.FC = () => {
  const { config, updateConfig } = useDeployment();
  const { t } = useI18n();
  const [showFrameworkPicker, setShowFrameworkPicker] = useState(false);

  const isAutoDetected = config.detectedFramework != null && config.framework === config.detectedFramework;
  const detectedFw = config.detectedFramework ? getFrameworkConfig(config.detectedFramework) : null;

  const currentFwConfig = getFrameworkConfig(config.framework);
  const [activeTab, setActiveTab] = useState<StackCategory>(
    stackCategories.some((category) => category.id === currentFwConfig.category)
      ? currentFwConfig.category
      : stackCategories[0].id,
  );

  const filteredFrameworks = useMemo(
    () => frameworks.filter((fw) => fw.category === activeTab),
    [activeTab],
  );

  const handleFrameworkChange = useCallback((frameworkId: FrameworkId) => {
    const fwConfig = getFrameworkConfig(frameworkId);
    const stackDef = STACKS[frameworkId as keyof typeof STACKS];
    const isStatic = fwConfig.options.isStatic;
    updateConfig({
      framework: frameworkId,
      options: {
        ...config.options,
        buildCommand: stackDef?.defaultBuildCommand ?? fwConfig.options.buildCommand,
        installCommand: fwConfig.options.installCommand,
        outputDirectory: stackDef?.outputDirectory ?? fwConfig.options.outputDirectory,
        startCommand: stackDef?.defaultStartCommand ?? "",
        productionPort: String(stackDef?.defaultPort ?? 3000),
        hasServer: !isStatic,
        // Picking a framework is a web/static decision; clear any stale "worker"
        // so the resolved workload matches hasServer (#538).
        workloadType: isStatic ? "static" : "web",
      },
    });
  }, [updateConfig, config.options]);

  const handleChangeClick = () => {
    setShowFrameworkPicker(true);
    if (detectedFw) setActiveTab(detectedFw.category);
  };

  return (
    <div className="space-y-6">
      {/* Framework - auto-detected state */}
      {isAutoDetected && !showFrameworkPicker && detectedFw && (
        <div className="bg-card rounded-2xl p-5">
          <p className="text-sm font-semibold text-foreground mb-3">
            {t.importProject.projectSettings.framework}
          </p>
          <div className="flex items-center justify-between gap-3 p-3.5 rounded-xl bg-card">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center">
                {detectedFw.icon("var(--primary)")}
              </div>
              <div>
                <p className="text-sm font-medium text-foreground">
                  {detectedFw.name}
                </p>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-primary/10 text-xs font-medium text-primary">
                    <UiIcon name="sparkles" className="size-3" />
                    {t.importProject.projectSettings.detected}
                  </span>
                </div>
              </div>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleChangeClick}
            >
              {t.importProject.projectSettings.change}
              <UiIcon name="chevron-down" className="size-3.5" />
            </Button>
          </div>
        </div>
      )}

      {/* Framework - full picker */}
      {(!isAutoDetected || showFrameworkPicker) && (
        <div className="bg-card rounded-2xl p-5">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <p className="text-sm font-semibold text-foreground">
              {t.importProject.projectSettings.framework}
            </p>
            {showFrameworkPicker && detectedFw && (
              <button
                type="button"
                onClick={() => {
                  setShowFrameworkPicker(false);
                  // Reset to detected framework
                  if (config.detectedFramework) handleFrameworkChange(config.detectedFramework);
                }}
                className="flex items-center gap-1 text-xs font-medium text-primary hover:text-primary/80 transition-colors"
              >
                <UiIcon name="sparkles" className="size-3" />
                {t.importProject.projectSettings.useDetected}
                <UiIcon name="chevron-up" className="size-3" />
              </button>
            )}
          </div>

          {/* Category tabs */}
          <div className="flex flex-wrap gap-1 mb-4">
            {stackCategories.map((cat) => (
              <button
                key={cat.id}
                type="button"
                onClick={() => setActiveTab(cat.id)}
                aria-pressed={activeTab === cat.id}
                className={`px-3.5 py-2 text-sm font-medium rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 ${
                  activeTab === cat.id
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                }`}
              >
                {t.importProject.categories[cat.id]}
              </button>
            ))}
          </div>

          {/* Framework grid */}
          <div className="grid grid-cols-3 sm:grid-cols-5 lg:grid-cols-6 gap-2.5">
            {filteredFrameworks.map((fw) => {
              const isSelected = config.framework === fw.id;
              return (
                <button
                  key={fw.id}
                  onClick={() => handleFrameworkChange(fw.id)}
                  type="button"
                  aria-pressed={isSelected}
                  className={`flex min-w-0 flex-col items-center gap-2.5 p-3.5 rounded-xl border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 ${
                    isSelected
                      ? "border-primary bg-primary/5 ring-1 ring-primary/20"
                      : "border-border/50 hover:border-border hover:bg-muted/30"
                  }`}
                >
                  <div className="w-8 h-8 flex items-center justify-center">
                    {fw.icon(isSelected ? "var(--primary)" : "var(--foreground)")}
                  </div>
                  <span className={`max-w-full break-words text-xs font-medium ${isSelected ? "text-primary" : "text-muted-foreground"}`}>
                    {fw.name}
                  </span>
                </button>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground mt-3">
            {t.importProject.projectSettings.selectHint}
          </p>
        </div>
      )}
    </div>
  );
};

export default React.memo(ProjectSettings);
