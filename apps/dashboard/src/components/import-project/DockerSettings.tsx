import React from "react";
import { Container, Hash } from "lucide-react";
import { useDeployment } from "@/context/DeploymentContext";
import { STACK_ICONS } from "@repo/core";

const DockerSettings: React.FC = () => {
  const { config, updateOptions } = useDeployment();
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
              <Container className="w-6 h-6 text-primary" />
            )}
          </div>
          <div>
            <h3 className="text-[15px] font-semibold text-foreground">Dockerfile Detected</h3>
            <p className="text-xs text-muted-foreground">
              Your project will be built and deployed using its Dockerfile
            </p>
          </div>
        </div>

        {/* Info card */}
        <div className="p-4 bg-muted/30 rounded-xl border border-border/50">
          <p className="text-sm text-muted-foreground leading-relaxed">
            No build settings needed — your Dockerfile defines the build process.
            Just configure the port your application listens on.
          </p>
        </div>

        {/* Port config */}
        <div>
          <label className="flex items-center gap-2 text-sm font-medium text-foreground mb-2">
            <span className="text-muted-foreground">
              <Hash className="size-4" />
            </span>
            Exposed Port
          </label>
          <input
            type="number"
            value={config.options.productionPort}
            onChange={(e) => updateOptions({ productionPort: e.target.value })}
            placeholder="3000"
            min={1}
            max={65535}
            className="w-full px-4 py-2.5 bg-muted/30 border border-border/50 rounded-xl text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
          />
          <p className="text-xs text-muted-foreground mt-1.5">
            The port your container exposes (from EXPOSE or CMD)
          </p>
        </div>
      </div>
    </div>
  );
};

export default React.memo(DockerSettings);
