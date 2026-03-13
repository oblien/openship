import React from "react";
import { Terminal, FolderOutput, Server, Globe, Container, Layers, Hash, ExternalLink } from "lucide-react";
import { useDeployment } from "@/context/DeploymentContext";
import { getFrameworkConfig } from "@/components/import-project/Frameworks";
import { STACKS, STACK_ICONS } from "@repo/core";

const BuildSummary: React.FC = () => {
  const { config } = useDeployment();
  const isApp = config.projectType === "app";
  const isDocker = config.projectType === "docker";
  const isServices = config.projectType === "services";

  const fw = isApp ? getFrameworkConfig(config.framework) : null;
  const stackDef = STACKS[config.framework as keyof typeof STACKS];
  const dockerIcon = STACK_ICONS["docker"];

  const services = config.services || [];
  const exposedServices = services.filter((s) => s.exposed);

  // For app/docker: single domain display
  const domainDisplay =
    !isServices && (config.domainType === "custom" && config.customDomain
      ? config.customDomain
      : config.domain
        ? `${config.domain}.opsh.io`
        : null);

  return (
    <div className="p-4 rounded-xl bg-gradient-to-br from-primary/5 via-primary/3 to-transparent border border-primary/10 space-y-3">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
        Deploy Summary
      </p>
      <div className="space-y-2.5">
        {/* Domain — for app/docker */}
        {domainDisplay && (
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-md bg-primary/10 flex items-center justify-center">
              <Globe className="size-3.5 text-primary" />
            </div>
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">Domain</p>
              <p className="text-sm font-medium text-foreground truncate">
                {domainDisplay}
              </p>
            </div>
          </div>
        )}

        {/* Services summary — for compose */}
        {isServices && (
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-md bg-primary/10 flex items-center justify-center">
              <Layers className="size-3.5 text-primary" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Services</p>
              <p className="text-sm font-medium text-foreground">
                {services.length} total · {exposedServices.length} exposed
              </p>
            </div>
          </div>
        )}

        {/* Stack identity */}
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-md bg-muted/60 flex items-center justify-center overflow-hidden">
            {isApp && fw ? (
              fw.icon("hsl(var(--foreground))")
            ) : dockerIcon ? (
              <img src={dockerIcon} alt="Docker" className="w-4 h-4" />
            ) : isServices ? (
              <Layers className="size-3.5 text-muted-foreground" />
            ) : (
              <Container className="size-3.5 text-muted-foreground" />
            )}
          </div>
          <div>
            <p className="text-xs text-muted-foreground">
              {isApp ? "Framework" : isServices ? "Stack" : "Runtime"}
            </p>
            <p className="text-sm font-medium text-foreground">
              {isApp && fw ? fw.name : stackDef?.name || "Docker"}
            </p>
          </div>
        </div>

        {/* App-specific: build/install/output */}
        {isApp && config.options.buildCommand && (
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-md bg-muted/60 flex items-center justify-center">
              <Terminal className="size-3.5 text-muted-foreground" />
            </div>
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">Build</p>
              <p className="text-sm font-medium text-foreground truncate">
                {config.options.buildCommand}
              </p>
            </div>
          </div>
        )}
        {isApp && config.options.installCommand && (
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-md bg-muted/60 flex items-center justify-center">
              <Server className="size-3.5 text-muted-foreground" />
            </div>
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">Install</p>
              <p className="text-sm font-medium text-foreground truncate">
                {config.options.installCommand}
              </p>
            </div>
          </div>
        )}
        {isApp && config.options.outputDirectory && (
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-md bg-muted/60 flex items-center justify-center">
              <FolderOutput className="size-3.5 text-muted-foreground" />
            </div>
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">Output</p>
              <p className="text-sm font-medium text-foreground truncate">
                {config.options.outputDirectory}
              </p>
            </div>
          </div>
        )}

        {/* Docker-specific: port */}
        {isDocker && config.options.productionPort && (
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-md bg-muted/60 flex items-center justify-center">
              <Hash className="size-3.5 text-muted-foreground" />
            </div>
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">Port</p>
              <p className="text-sm font-medium text-foreground">
                {config.options.productionPort}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default React.memo(BuildSummary);
