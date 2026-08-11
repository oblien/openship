"use client";

import React from "react";
import { Terminal, FolderOutput, Server, Globe, Container, Layers, Hash, Cloud, Monitor } from "lucide-react";
import { useDeployment } from "@/context/DeploymentContext";
import { getPublicEndpointHosts, usesServiceDeployment } from "@/context/deployment/types";
import { usePlatform } from "@/context/PlatformContext";
import { getFrameworkConfig } from "@/components/import-project/Frameworks";
import { STACKS } from "@repo/core";
import { DockerMark } from "@/components/icons/DockerMark";
import { useI18n, interpolate } from "@/components/i18n-provider";

const BuildSummary: React.FC = () => {
  const { config } = useDeployment();
  const { t } = useI18n();
  const { baseDomain } = usePlatform();
  const isServices = usesServiceDeployment(config);
  const isApp = config.projectType === "app" || (config.projectType === "services" && !isServices);
  const isDocker = config.projectType === "docker";

  const fw = isApp ? getFrameworkConfig(config.framework) : null;
  const stackDef = STACKS[config.framework as keyof typeof STACKS];

  const services = config.services || [];
  const exposedServices = services.filter((s) => s.exposed);
  // Build location follows buildStrategy FIRST: a "local" build runs on this
  // machine even when the deploy target is Openship Cloud (local-orchestrated
  // cloud — build here, upload the output to the cloud workspace). Only a
  // SERVER build takes the target's name ("Openship Cloud" vs generic "Server").
  const buildLocation = config.buildStrategy === "local"
    ? {
        label: t.deploy.buildSummary.localMachine,
        icon: <Monitor className="size-3.5 text-muted-foreground" />,
      }
    : config.deployTarget === "cloud"
      ? {
          label: t.deploy.buildSummary.cloud,
          icon: <Cloud className="size-3.5 text-muted-foreground" />,
        }
      : {
          label: t.deploy.buildSummary.server,
          icon: <Cloud className="size-3.5 text-muted-foreground" />,
        };
  const appDetailItems = [
    {
      label: t.deploy.buildSummary.framework,
      value: fw ? fw.name : stackDef?.name || t.deploy.buildSummary.app,
      icon: fw
        ? (
            <span className="flex size-3.5 items-center justify-center overflow-hidden rounded-sm [&>img]:h-full [&>img]:w-full [&>img]:object-contain">
              {fw.icon("var(--foreground)")}
            </span>
          )
        : <Container className="size-3 text-muted-foreground" />,
    },
    config.options.installCommand
      ? { label: t.deploy.buildSummary.install, value: config.options.installCommand, icon: <Server className="size-3 text-muted-foreground" /> }
      : null,
    config.options.buildCommand
      ? { label: t.deploy.buildSummary.build, value: config.options.buildCommand, icon: <Terminal className="size-3 text-muted-foreground" /> }
      : null,
    config.options.outputDirectory
      ? { label: t.deploy.buildSummary.output, value: config.options.outputDirectory, icon: <FolderOutput className="size-3 text-muted-foreground" /> }
      : null,
  ].filter(Boolean) as Array<{ label: string; value: string; icon: React.ReactNode }>;

  // For app/docker: single domain display. "None" routing wins over whatever is
  // still in `publicEndpoints` — the summary used to keep advertising the free
  // subdomain after the user picked None, which read as "it's still going to
  // assign that domain". Report None explicitly rather than hiding the row, so
  // the summary never goes quiet about the app's reachability.
  const noPublicRoute = !isServices && !!config.noPublicRoute;
  const endpointHosts = !isServices && !noPublicRoute
    ? getPublicEndpointHosts(config.publicEndpoints, baseDomain)
    : [];
  // A config that names no host gets "—", not a host composed from the project
  // name (which is neither what the deploy creates nor a real hostname). The row
  // still renders, so the summary never goes quiet about reachability — but "—"
  // says "nothing chosen" instead of advertising a URL that won't resolve.
  // Explicit "None" stays reserved for the operator's own no-route choice.
  const domainDisplay = noPublicRoute
    ? t.deploy.domainSettings.routeNoneLabel
    : isServices
      ? null
      : (endpointHosts[0] ?? "—");
  const extraEndpointCount = endpointHosts.length > 1 ? endpointHosts.length - 1 : 0;
  return (
    <div className="p-4 rounded-xl bg-gradient-to-br from-primary/5 via-primary/3 to-transparent border border-primary/10 space-y-3">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
        {t.deploy.buildSummary.title}
      </p>
      <div className="space-y-2.5">
        {/* Domain - for app/docker */}
        {domainDisplay && (
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-md bg-primary/10 flex items-center justify-center">
              <Globe className="size-3.5 text-primary" />
            </div>
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">{t.deploy.buildSummary.domain}</p>
              <p className="text-sm font-medium text-foreground truncate">
                {domainDisplay}
                {extraEndpointCount > 0 ? interpolate(t.deploy.buildSummary.extraMore, { count: String(extraEndpointCount) }) : ""}
              </p>
            </div>
          </div>
        )}

        {/* Services summary - for compose */}
        {isServices && (
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-md bg-primary/10 flex items-center justify-center">
              <Layers className="size-3.5 text-primary" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{t.deploy.buildSummary.services}</p>
              <p className="text-sm font-medium text-foreground">
                {interpolate(t.deploy.buildSummary.servicesValue, { total: String(services.length), exposed: String(exposedServices.length) })}
              </p>
            </div>
          </div>
        )}

        {/* Build location - for apps with build step */}
        {isApp && config.options.hasBuild && (
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-md bg-muted/60 flex items-center justify-center">
              {buildLocation.icon}
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{t.deploy.buildSummary.buildLocation}</p>
              <p className="text-sm font-medium text-foreground">
                {buildLocation.label}
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
              <div
                className={`w-7 h-7 rounded-md flex items-center justify-center overflow-hidden shrink-0 ${
                  isServices || isDocker
                    ? "bg-[#2496ED]/12 ring-1 ring-inset ring-[#2496ED]/25"
                    : "bg-muted/60"
                }`}
              >
                {isServices || isDocker ? (
                  // Docker / Compose: the whale in its brand blue on a faint
                  // tinted chip — a light brand touch, not the full logo lockup.
                  <DockerMark className="size-4 text-[#2496ED]" />
                ) : (
                  <Container className="size-3.5 text-muted-foreground" />
                )}
              </div>
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">
                  {isServices ? t.deploy.buildSummary.stack : t.deploy.buildSummary.runtime}
                </p>
                <p className="text-sm font-medium text-foreground truncate">
                  {/* A compose project has no single top-level stack (framework
                      is "unknown" by design — the real stack is per-service), so
                      don't surface STACKS['unknown'].name = "Unknown"; label it
                      as the compose stack it is. */}
                  {config.projectType === "services" ? "Docker Compose" : stackDef?.name || "Docker"}
                </p>
              </div>
            </div>

            {isDocker && config.options.productionPort && (
              <div className="flex items-start gap-2 text-xs min-w-0 border-t border-border/30 pt-2">
                <Hash className="size-3 mt-0.5 text-muted-foreground shrink-0" />
                <span className="text-muted-foreground shrink-0">{t.deploy.buildSummary.port}</span>
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
