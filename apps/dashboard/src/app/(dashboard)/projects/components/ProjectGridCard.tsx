"use client";

import React from "react";
import { Icon } from "@repo/ui/icons";
import Link from "next/link";
import { useRouter } from "next/navigation";
import DropdownMenu from "@/components/ui/DropdownMenu";
import { type Project } from "@/constants/mock";
import { AppLogo } from "@/components/AppLogo";
import { ProjectStackIcon } from "@/components/shared/ProjectStackIcon";
import { getProjectStatus, projectCardHref, projectDisplayDomain } from "@/utils/project-status";
import { ProjectStatusBadge } from "@/components/shared/ProjectStatusBadge";
import { ServiceStatusIndicator } from "@/components/services/ServiceStatusBadge";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { timeAgo } from "@/lib/time";
import { useImageFallback } from "@/hooks/useImageFallback";
import { getHostingLabel } from "./ProjectCard";

/** Compact project summary with direct links to its management screens. */
const ProjectGridCard: React.FC<{
  /** `primaryDomain` — the project's PRIMARY persisted route — is enriched onto
   *  every row by the projects list and `/info`, but isn't declared on `Project`
   *  (constants/mock) yet, so it's spelled out here rather than cast away. */
  project: Project & { primaryDomain?: string | null };
  preferAppLogo?: boolean;
  updateAvailable?: boolean;
}> = ({ project, preferAppLogo, updateAvailable }) => {
  const { t } = useI18n();
  const router = useRouter();
  const favicon = useImageFallback(project.favicon);

  const domain = projectDisplayDomain(project);
  const hosting = getHostingLabel(project.deployTarget, project.serverName, t);
  const appTemplateId = (project as { appTemplateId?: string }).appTemplateId;
  const clickTarget = projectCardHref(project);
  const isLive = getProjectStatus(project) === "live";

  const serviceCount = typeof project.serviceCount === "number" && Number.isInteger(project.serviceCount) && project.serviceCount >= 0
    ? project.serviceCount
    : undefined;
  const shortcuts = [
    ...(serviceCount != null && serviceCount > 0 ? [{
      tab: project.activeDeploymentId ? "services" : "topology",
      label: t.projects.card.services,
      value: serviceCount,
    }] : []),
    {
      tab: "deployments",
      label: t.projects.sidebar.tabs.deployments,
      value: project.activeVersion != null ? `v${project.activeVersion}` : undefined,
      title: project.activeVersion != null
        ? interpolate(t.projects.card.liveVersion, { version: String(project.activeVersion) })
        : undefined,
    },
    { tab: "logs", label: t.projects.sidebar.tabs.logs },
  ];

  return (
    <div className="group relative flex min-w-0 flex-col gap-2 rounded-2xl bg-card p-4">
      <Link
        href={clickTarget}
        aria-label={project.name}
        className="absolute inset-0 z-0 rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />

      <div className="flex min-w-0 items-center gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-muted">
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
            <ProjectStackIcon framework={project.framework} />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <p className="truncate text-base font-medium text-foreground" title={project.name}>
              {project.name}
            </p>
          </div>
          {domain && (
            <p className="mt-0.5 truncate text-sm text-muted-foreground" title={domain}>
              {domain}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <DropdownMenu
            className="z-20"
            triggerLabel={`${project.name}: ${t.projects.card.more}`}
            triggerClassName="flex size-6 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            actions={[
              { id: "open", icon: <Icon name="arrow-right" className="size-4 text-muted-foreground" aria-hidden="true" />, label: t.projects.sidebar.open, onClick: () => router.push(clickTarget) },
              { id: "topology", icon: <Icon name="network" className="size-4 text-muted-foreground" aria-hidden="true" />, label: t.projects.sidebar.tabs.topology, onClick: () => router.push(`/projects/${project.id}/topology`) },
              { id: "domains", icon: <Icon name="globe" className="size-4 text-muted-foreground" aria-hidden="true" />, label: t.projects.sidebar.tabs.domains, onClick: () => router.push(`/projects/${project.id}/domains`) },
              { id: "source", icon: <Icon name="git-branch" className="size-4 text-muted-foreground" aria-hidden="true" />, label: t.projects.sidebar.tabs.source, onClick: () => router.push(`/projects/${project.id}/source`) },
              { id: "settings", icon: <Icon name="settings" className="size-4 text-muted-foreground" aria-hidden="true" />, label: t.projects.sidebar.tabs.advanced, onClick: () => router.push(`/projects/${project.id}/advanced`) },
            ]}
          />
        </div>
      </div>

      <div className="mt-auto flex min-w-0 items-center justify-between gap-3 text-xs text-muted-foreground">
        <div className="flex min-w-0 items-center gap-2">
          {!isLive && (
            <ProjectStatusBadge
              project={project}
              className="shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium"
            />
          )}
          <span className="inline-flex min-w-0 items-center gap-1.5" title={hosting?.label}>
            {hosting && <>
              <span className="shrink-0 opacity-70" aria-hidden="true">{hosting.icon}</span>
              <span className="truncate">{hosting.label}</span>
            </>}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {updateAvailable && (
            <span className="inline-flex items-center gap-1 text-warning">
              {t.projects.card.updateAvailable}
            </span>
          )}
          <span>{timeAgo(project.updatedAt || project.createdAt, t)}</span>
        </div>
      </div>

      <div className="relative z-10 flex min-h-7 min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <div className="flex min-w-0 items-center gap-2">
        {shortcuts.map(({ tab, label, value, title }) => (
          <Link
            key={tab}
            href={`/projects/${project.id}/${tab}`}
            aria-label={`${project.name}: ${label}`}
            title={title ?? label}
            className="flex min-w-0 items-center justify-center gap-1.5 rounded-lg bg-muted px-2.5 py-1 transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="truncate">{label}</span>
            {value != null && <span className="shrink-0 font-medium text-foreground">{value}</span>}
          </Link>
        ))}
        </div>
        {isLive && (
          <span className="ms-auto inline-flex shrink-0 items-center gap-1.5">
            <ServiceStatusIndicator status="running" />
            <ProjectStatusBadge
              project={project}
              className="whitespace-nowrap bg-transparent text-xs font-medium text-muted-foreground"
            />
          </span>
        )}
      </div>
    </div>
  );
};

export default ProjectGridCard;
