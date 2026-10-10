"use client";
import { useDeployment } from "@/context/DeploymentContext";
import { GitHubChecksSettings } from "@/components/project-settings/GitHubChecksSettings";

export function DeployGitHubChecks() {
  const { config, updateConfig } = useDeployment();
  if (!config.owner || !config.repo || config.localPath || config.uploadSessionId || config.isApp) return null;
  const services = config.projectType === "monorepo"
    ? config.monorepoApps?.filter(service => service.enabled)
    : config.services;
  return <GitHubChecksSettings value={config.githubChecks} onChange={githubChecks => updateConfig({ githubChecks })}
    services={services?.map(service => service.name)} />;
}
