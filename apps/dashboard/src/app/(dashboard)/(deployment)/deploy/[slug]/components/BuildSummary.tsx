import React from "react";
import { Terminal, FolderOutput, Server, Globe, Container, Layers, Hash, Cloud, Monitor } from "lucide-react";
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
  const appDetailItems = [
    {
      label: "Framework",
      value: fw ? fw.name : stackDef?.name || "App",
      icon: fw
        ? (
            <span className="flex size-3.5 items-center justify-center overflow-hidden rounded-sm [&>img]:h-full [&>img]:w-full [&>img]:object-contain">
              {fw.icon("hsl(var(--foreground))")}
            </span>
          )
        : <Container className="size-3 text-muted-foreground" />,
    },
    config.options.installCommand
      ? { label: "Install", value: config.options.installCommand, icon: <Server className="size-3 text-muted-foreground" /> }
      : null,
    config.options.buildCommand
      ? { label: "Build", value: config.options.buildCommand, icon: <Terminal className="size-3 text-muted-foreground" /> }
      : null,
    config.options.outputDirectory
      ? { label: "Output", value: config.options.outputDirectory, icon: <FolderOutput className="size-3 text-muted-foreground" /> }
      : null,
  ].filter(Boolean) as Array<{ label: string; value: string; icon: React.ReactNode }>;

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

        {/* Build location — for apps with build step */}
        {isApp && config.options.hasBuild && (
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-md bg-muted/60 flex items-center justify-center">
              {config.buildStrategy === "local" ? (
                <Monitor className="size-3.5 text-muted-foreground" />
              ) : (
                <Cloud className="size-3.5 text-muted-foreground" />
              )}
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Build Location</p>
              <p className="text-sm font-medium text-foreground">
                {config.buildStrategy === "local" ? "Local Machine" : "Server"}
              </p>
            </div>
          </div>
        )}

        {/* Compact app details */}
        {isApp && (
          <div className="rounded-lg border border-border/40 bg-background/40 p-3">
            <div className="space-y-1.5">
              {appDetailItems.map((item) => (
                <div key={item.label} className="flex items-start gap-2 text-xs min-w-0">
                  <span className="mt-0.5 flex size-3.5 shrink-0 items-center justify-center overflow-hidden [&>img]:h-full [&>img]:w-full [&>img]:object-contain">
                    {item.icon}
                  </span>
                  <span className="text-muted-foreground shrink-0">{item.label}</span>
                  <span className="text-foreground font-medium truncate">{item.value}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Compact stack/runtime details for non-app projects */}
        {!isApp && (
          <div className="rounded-lg border border-border/40 bg-background/40 p-3 space-y-2">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-7 h-7 rounded-md bg-muted/60 flex items-center justify-center overflow-hidden shrink-0">
                {dockerIcon && !isServices ? (
                  <img src={dockerIcon} alt="Docker" className="w-4 h-4" />
                ) : isServices ? (
                  <Layers className="size-3.5 text-muted-foreground" />
                ) : (
                  <Container className="size-3.5 text-muted-foreground" />
                )}
              </div>
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">
                  {isServices ? "Stack" : "Runtime"}
                </p>
                <p className="text-sm font-medium text-foreground truncate">
                  {stackDef?.name || "Docker"}
                </p>
              </div>
            </div>

            {isDocker && config.options.productionPort && (
              <div className="flex items-start gap-2 text-xs min-w-0 border-t border-border/30 pt-2">
                <Hash className="size-3 mt-0.5 text-muted-foreground shrink-0" />
                <span className="text-muted-foreground shrink-0">Port</span>
                <span className="text-foreground font-medium truncate">{config.options.productionPort}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default React.memo(BuildSummary);
