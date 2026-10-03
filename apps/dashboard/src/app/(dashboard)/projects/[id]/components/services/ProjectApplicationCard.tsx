"use client";

import Link from "next/link";
import { Icon } from "@repo/ui/icons";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { ProjectStatusBadge } from "@/components/shared/ProjectStatusBadge";

/** Uses the existing project deployment and controls, without a second service identity. */
export function ProjectApplicationCard() {
  const { id, projectData } = useProjectSettings();
  const { t } = useI18n();
  return (
    <section className="space-y-4 rounded-2xl bg-card p-5">
      <div className="flex items-center gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted/60">
          <Icon name="window" className="size-5 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted-foreground">{t.projects.services.application}</p>
          <h2 className="truncate text-sm font-medium text-foreground" title={projectData.name} dir="auto">{projectData.name}</h2>
        </div>
        <ProjectStatusBadge project={projectData} className="shrink-0 rounded-full px-2.5 py-1 text-xs font-medium" />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{t.projects.services.applicationHint}</p>
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm" variant="secondary"><Link href={`/projects/${id}/logs`}>{t.projects.sidebar.tabs.logs}</Link></Button>
          <Button asChild size="sm" variant="secondary"><Link href={`/projects/${id}/deployments`}>{t.projects.sidebar.tabs.deployments}</Link></Button>
        </div>
      </div>
    </section>
  );
}
