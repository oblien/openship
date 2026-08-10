"use client";

import React, { useState } from "react";
import Link from "next/link";
import { ArrowRight, FolderOpen, GitBranch, Globe, Server } from "lucide-react";
import { type Project } from "@/constants/mock";
import { AppLogo } from "@/components/AppLogo";
import { getFrameworkConfig } from "@/components/import-project/Frameworks";
import {
  getProjectStatus,
  projectDisplayDomain,
  projectStatusHint,
  PROJECT_STATUS_META,
  projectStatusLabel,
} from "@/utils/project-status";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { timeAgo } from "@/lib/time";
import { getHostingLabel } from "./ProjectCard";

/**
 * Grid (tile) view of a project — the same data as {@link ProjectCard}, stacked
 * vertically instead of strung along a row. Helpers and status meta are imported
 * from the list card rather than re-derived, so the two views can't disagree.
 *
 * The row version hides meta progressively at narrow widths (`hidden md:`,
 * `hidden lg:` …) because it competes for one line. A tile has its own column,
 * so everything stays visible here — that is the actual reason to offer grid.
 */
const ProjectGridCard: React.FC<{
  /** `primaryDomain` — the project's PRIMARY persisted route — is enriched onto
   *  every row by the projects list and `/info`, but isn't declared on `Project`
   *  (constants/mock) yet, so it's spelled out here rather than cast away. */
  project: Project & { primaryDomain?: string | null };
  preferAppLogo?: boolean;
}> = ({ project, preferAppLogo }) => {
  const { t } = useI18n();
  const status = getProjectStatus(project);
  const statusMeta = PROJECT_STATUS_META[status];
  const statusHint = projectStatusHint(project, t);
  const fw = getFrameworkConfig(project.framework);
  const [faviconError, setFaviconError] = useState(false);

  const isLocal = !!project.localPath;
  const hasRepo = !!(project.gitOwner && project.gitRepo);
  const domain = projectDisplayDomain(project);
  const hasMultipleServices =
    project.hasMultipleServices === true || Number(project.serviceCount ?? 0) > 1;
  const hosting = getHostingLabel(project.deployTarget, project.serverName, t);
  const hasFavicon = !!project.favicon && !faviconError;
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
          ) : hasFavicon ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={project.favicon!}
              alt=""
              className="size-6 object-contain"
              onError={() => setFaviconError(true)}
            />
          ) : (
            fw.icon("var(--foreground)")
          )}
        </div>

        <div className="min-w-0 flex-1 text-start">
          <div className="flex items-center gap-1.5">
            <p className="truncate text-sm font-medium text-foreground">{project.name}</p>
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

        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${statusMeta.badge}`}
          // Amber "Action Required" without a named move is a dead end — some
          // attention states (rolled back after a failed deploy) have no
          // clearable pending-action, so the pill has to say what to do.
          {...(statusHint ? { title: statusHint } : {})}
        >
          {projectStatusLabel(status, t)}
        </span>
      </div>

      {/* Meta — nothing is hidden here, the tile has the room the row didn't */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-muted-foreground/60">
        <span className="inline-flex items-center rounded-md bg-muted/60 px-2 py-0.5 text-xs">
          {fw.name}
        </span>

        {project.isApp && (
          <span className="inline-flex items-center rounded-md bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
            {t.projects.card.appBadge}
          </span>
        )}

        {hosting && (
          <span className="inline-flex min-w-0 items-center gap-1.5 text-xs">
            {hosting.icon}
            <span className="truncate">{hosting.label}</span>
          </span>
        )}

        {isLocal ? (
          <span className="inline-flex min-w-0 items-center gap-1.5 text-xs">
            <FolderOpen className="size-3.5" />
            <span className="truncate">{t.projects.card.sourceLocal}</span>
          </span>
        ) : hasRepo ? (
          <span className="inline-flex min-w-0 items-center gap-1.5 text-xs">
            <GitBranch className="size-3.5" />
            <span className="truncate">{project.gitRepo}</span>
          </span>
        ) : null}

        {hasMultipleServices ? (
          <span className="inline-flex items-center gap-1.5 text-xs">
            <Server className="size-3.5" />
            {t.projects.card.services}
          </span>
        ) : project.hasServer === false ? (
          <span className="inline-flex items-center gap-1.5 text-xs">
            <Globe className="size-3.5" />
            {t.projects.card.static}
          </span>
        ) : project.productionMode === "standalone" ? (
          <span className="inline-flex items-center gap-1.5 text-xs">
            <Server className="size-3.5" />
            {t.projects.card.standalone}
          </span>
        ) : null}
      </div>

      {/* Footer */}
      <div className="mt-auto flex items-center justify-between gap-2 pt-0.5">
        <span className="text-xs text-muted-foreground">
          {timeAgo(project.updatedAt || project.createdAt, t)}
        </span>
        <ArrowRight className="size-4 text-muted-foreground/40 transition-colors group-hover:text-muted-foreground rtl:rotate-180" />
      </div>
    </div>
  );
};

export default ProjectGridCard;
