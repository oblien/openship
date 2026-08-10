"use client";

import React, { useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  GitBranch,
  Globe,
  Server,
  FolderOpen,
  Cloud,
  HardDrive,
  MoreHorizontal,
  Trash2,
} from "lucide-react";
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
import { useModal } from "@/context/ModalContext";
import { useToast } from "@/context/ToastContext";
import { projectsApi, getApiErrorMessage } from "@/lib/api";
import { timeAgo } from "@/lib/time";
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
    return { icon: <Cloud className="size-3.5" />, label: t.projects.hosting.cloud };
  if (deployTarget === "server")
    return {
      icon: <Server className="size-3.5" />,
      label: serverName || t.projects.hosting.server,
    };
  if (deployTarget === "local")
    return { icon: <HardDrive className="size-3.5" />, label: t.projects.hosting.local };
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
  const statusMeta = PROJECT_STATUS_META[status];
  const statusHint = projectStatusHint(project, t);
  const fw = getFrameworkConfig(project.framework);
  const [faviconError, setFaviconError] = useState(false);

  const isLocal = !!project.localPath;
  const hasRepo = !!(project.gitOwner && project.gitRepo);
  const repoSlug = hasRepo ? `${project.gitOwner}/${project.gitRepo}` : null;
  const domain = projectDisplayDomain(project);
  const hasMultipleServices =
    project.hasMultipleServices === true || Number(project.serviceCount ?? 0) > 1;

  const hosting = getHostingLabel(project.deployTarget, project.serverName, t);
  const hasFavicon = !!project.favicon && !faviconError;
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
              await projectsApi.delete(project.id, { deleteApp: true });
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
    <div className="relative flex items-center gap-4 px-5 py-3.5 hover:bg-muted/40 transition-colors group">
      {/* Stretched-link overlay: the whole row is a real anchor (cmd/middle-click
          → open in new tab) without nesting a <button> inside an <a>. It sits
          above the static content (captures row clicks) but below the draft menu
          (lifted with z-10), which stays independently clickable. */}
      <Link href={clickTarget} aria-label={project.name} className="absolute inset-0 z-0" />

      {/* Icon — on the Apps page show the catalog app's brand logo; otherwise
          the project favicon, falling back to the framework/service glyph. */}
      <div className="w-10 h-10 rounded-xl bg-muted/60 flex items-center justify-center shrink-0 group-hover:bg-muted transition-colors overflow-hidden">
        {preferAppLogo && project.isApp ? (
          <AppLogo appId={appTemplateId} className="w-6 h-6 object-contain" />
        ) : hasFavicon ? (
          <img
            src={project.favicon!}
            alt=""
            className="w-6 h-6 object-contain"
            onError={() => setFaviconError(true)}
          />
        ) : (
          fw.icon("var(--foreground)")
        )}
      </div>

      {/* Name + domain */}
      <div className="min-w-0 flex-shrink-0 w-44 lg:w-56 text-start">
        <div className="flex items-center gap-1.5">
          <p className="text-sm font-medium text-foreground truncate">{project.name}</p>
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
            <span className="shrink-0 rounded-md bg-warning-bg px-1.5 py-0.5 text-[10px] font-medium text-warning">
              {t.projects.card.updateAvailable}
            </span>
          )}
        </div>
        {domain && <p className="text-xs text-muted-foreground truncate mt-0.5">{domain}</p>}
      </div>

      {/* Meta badges */}
      <div className="flex-1 min-w-0 flex items-center gap-3 overflow-hidden">
        {/* Stack */}
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-muted/60 text-xs text-muted-foreground shrink-0">
          {fw.name}
        </span>

        {/* App marker — catalog-installed (Convex, webmail, …) */}
        {project.isApp && (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-primary/10 text-xs font-medium text-primary shrink-0">
            {t.projects.card.appBadge}
          </span>
        )}

        {/* Hosting target */}
        {hosting && (
          <span className="hidden sm:inline-flex items-center gap-1.5 text-xs text-muted-foreground shrink-0">
            {hosting.icon}
            <span className="truncate max-w-[120px]">{hosting.label}</span>
          </span>
        )}

        {/* Source */}
        {isLocal ? (
          <span className="hidden md:inline-flex items-center gap-1.5 text-xs text-muted-foreground shrink-0">
            <FolderOpen className="size-3.5" />
            <span className="truncate max-w-[140px]">{t.projects.card.sourceLocal}</span>
          </span>
        ) : repoSlug ? (
          <span className="hidden md:inline-flex items-center gap-1.5 text-xs text-muted-foreground shrink-0">
            <GitBranch className="size-3.5" />
            <span className="truncate max-w-[140px]">{project.gitRepo}</span>
          </span>
        ) : null}

        {/* Build target */}
        {hasMultipleServices ? (
          <span className="hidden lg:inline-flex items-center gap-1.5 text-xs text-muted-foreground shrink-0">
            <Server className="size-3.5" />
            {t.projects.card.services}
          </span>
        ) : project.hasServer === false ? (
          <span className="hidden lg:inline-flex items-center gap-1.5 text-xs text-muted-foreground shrink-0">
            <Globe className="size-3.5" />
            {t.projects.card.static}
          </span>
        ) : project.productionMode === "standalone" ? (
          <span className="hidden lg:inline-flex items-center gap-1.5 text-xs text-muted-foreground shrink-0">
            <Server className="size-3.5" />
            {t.projects.card.standalone}
          </span>
        ) : null}
      </div>

      {/* Right side */}
      <div className="flex items-center gap-3 shrink-0">
        {/* Time */}
        <span className="hidden lg:block text-xs text-muted-foreground">
          {timeAgo(project.updatedAt || project.createdAt, t)}
        </span>

        {/* Status pill (badge only — no dot) */}
        <span
          className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium ${statusMeta.badge}`}
          // Amber "Action Required" without a named move is a dead end — some
          // attention states (rolled back after a failed deploy) have no
          // clearable pending-action, so the pill has to say what to do.
          {...(statusHint ? { title: statusHint } : {})}
        >
          {projectStatusLabel(status, t)}
        </span>

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
              <MoreHorizontal className="size-4" />
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
                    <Trash2 className="size-3.5" />
                    {t.projects.draft.delete}
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        <ArrowRight className="size-4 text-muted-foreground/40 group-hover:text-muted-foreground transition-colors rtl:rotate-180" />
      </div>
    </div>
  );
};

export default ProjectCard;
