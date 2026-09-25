"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import React from "react";
import Link from "next/link";
import { type Project } from "@/constants/mock";
import { AppLogo } from "@/components/AppLogo";
import { getFrameworkConfig } from "@/components/import-project/Frameworks";
import { getProjectStatus, projectDisplayDomain } from "@/utils/project-status";
import { ProjectStatusBadge } from "@/components/shared/ProjectStatusBadge";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { timeAgo } from "@/lib/time";
import { useImageFallback } from "@/hooks/useImageFallback";
import { getHostingLabel } from "./ProjectCard";

/**
 * Grid (tile) view of a project — the same data as {@link ProjectCard}, stacked
 * vertically instead of strung along a row. Helpers and status meta are imported
 * from the list card rather than re-derived, so the two views can't disagree.
 *
 * The row version hides meta progressively as its available width shrinks
 * because it competes for one line. A tile has its own column,
 * so everything stays visible here — that is the actual reason to offer grid.
 */
const ProjectGridCard: React.FC<{
  /** `primaryDomain` — the project's PRIMARY persisted route — is enriched onto
   *  every row by the projects list and `/info`, but isn't declared on `Project`
   *  (constants/mock) yet, so it's spelled out here rather than cast away. */
  project: Project & { primaryDomain?: string | null };
  preferAppLogo?: boolean;
  updateAvailable?: boolean;
}> = ({ project, preferAppLogo, updateAvailable }) => {
  const { t } = useI18n();
  const status = getProjectStatus(project);
  const fw = getFrameworkConfig(project.framework);
  const favicon = useImageFallback(project.favicon);

  const isLocal = !!project.localPath;
  const hasRepo = !!(project.gitOwner && project.gitRepo);
  const domain = projectDisplayDomain(project);
  const hasMultipleServices =
    project.hasMultipleServices === true || Number(project.serviceCount ?? 0) > 1;
  const hosting = getHostingLabel(project.deployTarget, project.serverName, t);
  const appTemplateId = (project as { appTemplateId?: string }).appTemplateId;
  const isDraftApp = !!project.isApp && status === "draft" && !!appTemplateId;
  const clickTarget = isDraftApp
    ? `/apps/new/${appTemplateId}?projectId=${project.id}`
    : `/projects/${project.id}`;

  return (
    <div className="group relative flex flex-col gap-3.5 rounded-2xl bg-card p-4 transition-colors hover:bg-muted/40">
      <Link href={clickTarget} aria-label={project.name} className="absolute inset-0 z-0" />

      {/* Identity */}
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-muted/60 transition-colors group-hover:bg-muted">
          {preferAppLogo && project.isApp ? (
            <AppLogo appId={appTemplateId} className="size-6 object-contain" />
          ) : favicon.showImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              ref={favicon.ref}
              src={project.favicon!}
              alt=""
              className="size-6 object-contain"
              onError={favicon.onError}
            />
          ) : (
            fw.icon("var(--foreground)")
          )}
        </div>

        <div className="min-w-0 flex-1 text-start">
          <div className="flex min-w-0 items-center gap-1.5">
            <p className="min-w-0 truncate text-sm font-medium text-foreground" title={project.name}>{project.name}</p>
            {updateAvailable && (
              <span className="shrink-0 whitespace-nowrap rounded-full bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium text-warning">
                {t.projects.card.updateAvailable}
              </span>
            )}
            {project.activeVersion != null && (
              <span
                className="shrink-0 rounded-md bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] font-medium text-muted-foreground"
                title={interpolate(t.projects.card.liveVersion, {
                  version: String(project.activeVersion),
                })}
              >
                v{project.activeVersion}
              </span>
            )}
          </div>
          {domain && <p className="mt-0.5 truncate text-xs text-muted-foreground">{domain}</p>}
        </div>
      </div>

      {/* Meta — nothing is hidden here, the tile has the room the row didn't */}
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 whitespace-nowrap text-muted-foreground">
        <span className="inline-flex min-w-0 max-w-full items-center rounded-md bg-secondary px-2 py-0.5 text-xs th-text-body" title={fw.name}>
          <span className="truncate">{fw.name}</span>
        </span>

        {project.isApp && (
          <span className="inline-flex min-w-0 max-w-full items-center rounded-md bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary" title={t.projects.card.appBadge}>
            <span className="truncate">{t.projects.card.appBadge}</span>
          </span>
        )}

        {hosting && (
          <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 text-xs" title={hosting.label}>
            {hosting.icon}
            <span className="truncate">{hosting.label}</span>
          </span>
        )}

        {isLocal ? (
          <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 text-xs" title={t.projects.card.sourceLocal}>
            <UiIcon name="folder-open" className="size-3.5 shrink-0" />
            <span className="truncate">{t.projects.card.sourceLocal}</span>
          </span>
        ) : hasRepo ? (
          <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 text-xs" title={`${project.gitOwner}/${project.gitRepo}`}>
            <UiIcon name="git-branch" className="size-3.5 shrink-0" />
            <span className="truncate">{project.gitRepo}</span>
          </span>
        ) : null}

        {!hasMultipleServices && (project.workloadType === "worker" ? (
          <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 text-xs" title={t.projects.card.worker}>
            <UiIcon name="server" className="size-3.5 shrink-0" />
            <span className="truncate">{t.projects.card.worker}</span>
          </span>
        ) : project.hasServer === false ? (
          <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 text-xs" title={t.projects.card.static}>
            <UiIcon name="globe" className="size-3.5 shrink-0" />
            <span className="truncate">{t.projects.card.static}</span>
          </span>
        ) : project.productionMode === "standalone" ? (
          <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 text-xs" title={t.projects.card.standalone}>
            <UiIcon name="server" className="size-3.5 shrink-0" />
            <span className="truncate">{t.projects.card.standalone}</span>
          </span>
        ) : null)}
      </div>

      {/* Footer */}
      <div className="mt-auto flex items-center justify-between gap-2 pt-0.5">
        <ProjectStatusBadge
          project={project}
          className="shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-medium"
        />
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-xs text-muted-foreground">
            {timeAgo(project.updatedAt || project.createdAt, t)}
          </span>
          <UiIcon name="arrow-right" className="size-4 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-muted-foreground rtl:rotate-180" />
        </div>
      </div>
    </div>
  );
};

export default ProjectGridCard;
