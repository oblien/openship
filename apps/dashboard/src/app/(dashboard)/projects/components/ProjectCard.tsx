"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import React, { useState } from "react";
import Link from "next/link";
import { type Project } from "@/constants/mock";
import { AppLogo } from "@/components/AppLogo";
import { getFrameworkConfig } from "@/components/import-project/Frameworks";
import { getProjectStatus, projectDisplayDomain } from "@/utils/project-status";
import { ProjectStatusBadge } from "@/components/shared/ProjectStatusBadge";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { useModal } from "@/context/ModalContext";
import { useToast } from "@/context/ToastContext";
import { projectsApi, getApiErrorMessage } from "@/lib/api";
import { timeAgo } from "@/lib/time";
import { useImageFallback } from "@/hooks/useImageFallback";
import type { Dictionary } from "@/i18n";

/* ── Helpers ──────────────────────────────────────────────────────── */

/* Exported for ProjectGridCard: the tile view shows the same hosting label as this
   row, so both read it from here instead of deriving their own (which is how the
   two views would drift). Relative time moved to `@/lib/time` once the Health tab
   and the issue feed needed it too. */

export function getHostingLabel(
  deployTarget: string | null | undefined,
  serverName: string | null | undefined,
  t: Dictionary,
): { icon: React.ReactNode; label: string } | null {
  if (!deployTarget) return null;
  if (deployTarget === "cloud")
    return { icon: <UiIcon name="cloud" className="size-3.5 shrink-0" />, label: t.projects.hosting.cloud };
  if (deployTarget === "server")
    return {
      icon: <UiIcon name="server" className="size-3.5 shrink-0" />,
      label: serverName || t.projects.hosting.server,
    };
  if (deployTarget === "local")
    return { icon: <UiIcon name="hard-drive" className="size-3.5 shrink-0" />, label: t.projects.hosting.local };
  return null;
}

/* ── Component ────────────────────────────────────────────────────── */

interface Props {
  /** `primaryDomain` — the project's PRIMARY persisted route — is enriched onto
   *  every row by the projects list and `/info`, but isn't declared on `Project`
   *  (constants/mock) yet, so it's spelled out here rather than cast away. */
  project: Project & { primaryDomain?: string | null };
  /** On the Apps page: show the catalog app's brand logo instead of the
   *  framework/service fallback icon. */
  preferAppLogo?: boolean;
  /** Show an "update available" badge (fed by the update scan). Off by default
   *  so the Projects page is unaffected. */
  updateAvailable?: boolean;
  /** Called after a draft app is deleted from its card menu, so the list can
   *  refresh. Only wired on the Apps page. */
  onChanged?: () => void;
}

const ProjectCard: React.FC<Props> = ({ project, preferAppLogo, updateAvailable, onChanged }) => {
  const { t } = useI18n();
  const { showModal, hideModal } = useModal();
  const { showToast } = useToast();
  const [menuOpen, setMenuOpen] = useState(false);
  const status = getProjectStatus(project);
  const fw = getFrameworkConfig(project.framework);
  const favicon = useImageFallback(project.favicon);

  const isLocal = !!project.localPath;
  const hasRepo = !!(project.gitOwner && project.gitRepo);
  const repoSlug = hasRepo ? `${project.gitOwner}/${project.gitRepo}` : null;
  const domain = projectDisplayDomain(project);
  const hasMultipleServices =
    project.hasMultipleServices === true || Number(project.serviceCount ?? 0) > 1;

  const hosting = getHostingLabel(project.deployTarget, project.serverName, t);
  const appTemplateId = (project as { appTemplateId?: string }).appTemplateId;
  // A not-yet-deployed app reopens the install wizard (adopting its draft);
  // a deployed app opens as a normal project.
  const isDraftApp = !!project.isApp && status === "draft" && !!appTemplateId;
  const clickTarget = isDraftApp
    ? `/apps/new/${appTemplateId}?projectId=${project.id}`
    : `/projects/${project.id}`;

  const confirmDeleteApp = () => {
    const id = showModal({
      title: t.projects.draft.deleteTitle,
      message: `${t.projects.draft.deleteConfirmPrefix} ${project.name}${t.projects.draft.deleteConfirmSuffix}`,
      icon: "warning",
      buttons: [
        { label: t.projects.draft.cancel, variant: "secondary", onClick: () => hideModal(id) },
        {
          label: t.projects.draft.delete,
          variant: "danger",
          onClick: async () => {
            hideModal(id);
            try {
              await projectsApi.delete(project.id, {});
              showToast(t.projects.delete.successProject, "success");
              onChanged?.();
            } catch (e) {
              showToast(getApiErrorMessage(e, t.projects.delete.failed), "error");
            }
          },
        },
      ],
    });
  };

  return (
    <div className="@container/project-row relative hover:bg-muted/40 transition-colors group">
      {/* Stretched-link overlay: the whole row is a real anchor (cmd/middle-click
          → open in new tab) without nesting a <button> inside an <a>. It sits
          above the static content (captures row clicks) but below the draft menu
          (lifted with z-10), which stays independently clickable. */}
      <Link href={clickTarget} aria-label={project.name} className="absolute inset-0 z-0" />

      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2 px-4 py-3.5 @xl/project-row:flex @xl/project-row:gap-4 @xl/project-row:px-5">
        {/* Icon — on the Apps page show the catalog app's brand logo; otherwise
            the project favicon, falling back to the framework/service glyph. */}
        <div className="w-10 h-10 rounded-xl bg-muted/60 flex items-center justify-center shrink-0 group-hover:bg-muted transition-colors overflow-hidden">
          {preferAppLogo && project.isApp ? (
            <AppLogo appId={appTemplateId} className="w-6 h-6 object-contain" />
          ) : favicon.showImage ? (
            <img
              ref={favicon.ref}
              src={project.favicon!}
              alt=""
              className="w-6 h-6 object-contain"
              onError={favicon.onError}
            />
          ) : (
            fw.icon("var(--foreground)")
          )}
        </div>

        {/* Name + domain */}
        <div className="min-w-0 text-start @xl/project-row:w-44 @xl/project-row:flex-none @3xl/project-row:w-56">
          <div className="flex min-w-0 items-center gap-1.5">
            <p className="min-w-0 truncate text-sm font-medium text-foreground" title={project.name}>{project.name}</p>
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
            {updateAvailable && (
              <span className="shrink-0 whitespace-nowrap rounded-md bg-warning-bg px-1.5 py-0.5 text-[10px] font-medium text-warning">
                {t.projects.card.updateAvailable}
              </span>
            )}
          </div>
          {domain && <p className="text-xs text-muted-foreground truncate mt-0.5">{domain}</p>}
        </div>

        {/* Keep metadata on one line; reveal secondary fields when the row itself
            has room, including when the Projects sidebar narrows a desktop list. */}
        <div className="hidden min-w-0 flex-1 items-center gap-3 whitespace-nowrap @xl/project-row:flex">
          {/* Stack */}
          <span className="inline-flex min-w-0 max-w-[40%] shrink-0 items-center gap-1.5 px-2 py-0.5 rounded-md bg-secondary text-xs th-text-body" title={fw.name}>
            <span className="truncate">{fw.name}</span>
          </span>

          {/* App marker — catalog-installed (Convex, webmail, …) */}
          {project.isApp && (
            <span className="hidden min-w-0 max-w-[30%] shrink-0 items-center gap-1.5 px-2 py-0.5 rounded-md bg-primary/10 text-xs font-medium text-primary @2xl/project-row:inline-flex" title={t.projects.card.appBadge}>
              <span className="truncate">{t.projects.card.appBadge}</span>
            </span>
          )}

          {/* Hosting target */}
          {hosting && (
            <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" title={hosting.label}>
              {hosting.icon}
              <span className="truncate">{hosting.label}</span>
            </span>
          )}

          {/* Source */}
          {isLocal ? (
            <span className="hidden min-w-0 items-center gap-1.5 text-xs text-muted-foreground @3xl/project-row:inline-flex" title={t.projects.card.sourceLocal}>
              <UiIcon name="folder-open" className="size-3.5 shrink-0" />
              <span className="truncate">{t.projects.card.sourceLocal}</span>
            </span>
          ) : repoSlug ? (
            <span className="hidden min-w-0 items-center gap-1.5 text-xs text-muted-foreground @3xl/project-row:inline-flex" title={repoSlug}>
              <UiIcon name="git-branch" className="size-3.5 shrink-0" />
              <span className="truncate">{project.gitRepo}</span>
            </span>
          ) : null}

          {/* Build target */}
          {!hasMultipleServices && (project.workloadType === "worker" ? (
            <span className="hidden min-w-0 max-w-32 shrink-0 items-center gap-1.5 text-xs text-muted-foreground @4xl/project-row:inline-flex" title={t.projects.card.worker}>
              <UiIcon name="server" className="size-3.5 shrink-0" />
              <span className="truncate">{t.projects.card.worker}</span>
            </span>
          ) : project.hasServer === false ? (
            <span className="hidden min-w-0 max-w-32 shrink-0 items-center gap-1.5 text-xs text-muted-foreground @4xl/project-row:inline-flex" title={t.projects.card.static}>
              <UiIcon name="globe" className="size-3.5 shrink-0" />
              <span className="truncate">{t.projects.card.static}</span>
            </span>
          ) : project.productionMode === "standalone" ? (
            <span className="hidden min-w-0 max-w-32 shrink-0 items-center gap-1.5 text-xs text-muted-foreground @4xl/project-row:inline-flex" title={t.projects.card.standalone}>
              <UiIcon name="server" className="size-3.5 shrink-0" />
              <span className="truncate">{t.projects.card.standalone}</span>
            </span>
          ) : null)}
        </div>

        {/* Right side */}
        <div className="col-start-2 flex min-w-0 max-w-full items-center gap-3 whitespace-nowrap @xl/project-row:shrink-0">
          {/* Time */}
          <span className="hidden text-xs text-muted-foreground @4xl/project-row:block">
            {timeAgo(project.updatedAt || project.createdAt, t)}
          </span>

          {/* Status pill (badge only — no dot) */}
          <ProjectStatusBadge
            project={project}
            className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium"
          />

          {/* Draft apps get a "delete app" menu (deployed apps delete from the
              project page). Stops row navigation. */}
          {isDraftApp && (
            <div className="relative z-10" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                onClick={() => setMenuOpen((v) => !v)}
                className="flex size-7 items-center justify-center rounded-lg text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
                aria-label={t.projects.draft.deleteTitle}
              >
                <UiIcon name="more" className="size-4" />
              </button>
              {menuOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
                  <div className="absolute end-0 top-full z-50 mt-1 w-44 rounded-xl border border-border bg-popover py-1 shadow-lg">
                    <button
                      type="button"
                      onClick={() => {
                        setMenuOpen(false);
                        confirmDeleteApp();
                      }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-sm text-danger transition-colors hover:bg-danger-bg"
                    >
                      <UiIcon name="trash" className="size-3.5" />
                      {t.projects.draft.delete}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          <UiIcon name="arrow-right" className="size-4 shrink-0 text-muted-foreground/40 group-hover:text-muted-foreground transition-colors rtl:rotate-180" />
        </div>
      </div>
    </div>
  );
};

export default ProjectCard;
