"use client";

import { Icon } from "@repo/ui/icons";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { ProjectStatusBadge } from "@/components/shared/ProjectStatusBadge";
import { WorkloadListItem } from "./WorkloadListItem";
import { resolveWorkload } from "@repo/core";

export function ProjectApplicationListItem() {
  const { id, projectData, domain } = useProjectSettings();
  const { t } = useI18n();
  const port =
    resolveWorkload(projectData.options?.workloadType, projectData.options?.hasServer) === "static"
      ? null
      : projectData.port;
  return (
    <WorkloadListItem
      name={projectData.name}
      href={`/projects/${id}/services/application`}
      icon={<Icon name="window" className="size-5 text-muted-foreground" />}
      address={domain || t.projects.services.application}
      port={port}
      portLabel={port ? interpolate(t.projects.services.port, { port: String(port) }) : null}
      status={
        <ProjectStatusBadge
          project={projectData}
          linked={false}
          className="gap-1.5 bg-transparent text-xs font-medium before:size-2.5 before:shrink-0 before:rounded-full before:border-2 before:border-current"
        />
      }
    />
  );
}
