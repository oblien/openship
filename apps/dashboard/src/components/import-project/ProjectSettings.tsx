import React, { useCallback, useState, useMemo } from "react";
import { frameworks, getFrameworkConfig, stackCategories } from "./Frameworks";
import type { StackCategory } from "./Frameworks";
import { STACKS } from "@repo/core";
import { Sparkles, ChevronDown, ChevronUp } from "lucide-react";
import { useDeployment } from "@/context/DeploymentContext";
import type { FrameworkId } from "./types";

const ProjectSettings: React.FC = () => {
  const { config, updateConfig } = useDeployment();
  const [showFrameworkPicker, setShowFrameworkPicker] = useState(false);

  const isAutoDetected = config.detectedFramework != null && config.framework === config.detectedFramework;
  const detectedFw = config.detectedFramework ? getFrameworkConfig(config.detectedFramework) : null;

  const currentFwConfig = getFrameworkConfig(config.framework);
  const [activeTab, setActiveTab] = useState<StackCategory>(currentFwConfig.category);

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
      },
    });
  }, [updateConfig, config.options]);

  const handleChangeClick = () => {
    setShowFrameworkPicker(true);
    if (detectedFw) setActiveTab(detectedFw.category);
  };

  return (
    <div className="space-y-6">
      {/* Framework — auto-detected state */}
      {isAutoDetected && !showFrameworkPicker && detectedFw && (
        <div className="bg-card rounded-2xl border border-border/50 p-5">
          <label className="text-[15px] font-semibold text-foreground mb-3 block">
            Framework
          </label>
          <div className="flex items-center justify-between p-3.5 rounded-xl border border-border/50 bg-muted/40">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center">
                {detectedFw.icon("hsl(var(--primary))")}
              </div>
              <div>
                <p className="text-sm font-medium text-foreground">
                  {detectedFw.name}
                </p>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-primary/10 text-[10px] font-medium text-primary">
                    <Sparkles className="size-2.5" />
                    Detected
                  </span>
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={handleChangeClick}
              className="flex items-center gap-1 text-sm font-medium text-primary hover:text-primary/80 transition-colors"
            >
              Change
              <ChevronDown className="size-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Framework — full picker */}
      {(!isAutoDetected || showFrameworkPicker) && (
        <div className="bg-card rounded-2xl border border-border/50 p-5">
          <div className="flex items-center justify-between mb-3">
            <label className="text-[15px] font-semibold text-foreground">
              Framework
            </label>
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
                <Sparkles className="size-3" />
                Use detected
                <ChevronUp className="size-3" />
              </button>
            )}
          </div>

          {/* Category tabs */}
          <div className="flex gap-1 p-1 bg-muted/50 rounded-lg mb-4 w-fit">
            {stackCategories.map((cat) => (
              <button
                key={cat.id}
                type="button"
                onClick={() => setActiveTab(cat.id)}
                className={`px-3.5 py-1.5 text-sm font-medium rounded-md transition-all ${
                  activeTab === cat.id
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {cat.label}
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
                  className={`flex flex-col items-center gap-2.5 p-3.5 rounded-xl border transition-all ${
                    isSelected
                      ? "border-primary bg-primary/5 ring-1 ring-primary/20"
                      : "border-border/50 hover:border-border hover:bg-muted/30"
                  }`}
                >
                  <div className="w-8 h-8 flex items-center justify-center">
                    {fw.icon(isSelected ? "hsl(var(--primary))" : "hsl(var(--foreground))")}
                  </div>
                  <span className={`text-xs font-medium ${isSelected ? "text-primary" : "text-muted-foreground"}`}>
                    {fw.name}
                  </span>
                </button>
              );
            })}
          </div>
          <p className="text-sm text-muted-foreground mt-3">
            Select your framework to auto-configure build settings
          </p>
        </div>
      )}
    </div>
  );
};

export default React.memo(ProjectSettings);
