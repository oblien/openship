"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon as UiIcon } from "@repo/ui/icons";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { AppLogo } from "@/components/AppLogo";
import { Button } from "@/components/ui/button";
import { getFrameworkConfig } from "@/components/import-project/Frameworks";
import { DeploymentsContent } from "@/app/(dashboard)/deployments/components";
import { getProjectStatus } from "@/utils/project-status";
import { ProjectStatusBadge } from "@/components/shared/ProjectStatusBadge";
import { encodeLocalSlug, encodeRepoSlug, encodeProjectSlug } from "@/utils/repoSlug";
import { useI18n, interpolate } from "@/components/i18n-provider";
import type { Dictionary } from "@/i18n";
import { DeleteConfirmationDialog } from "./DeleteConfirmationDialog";

interface DraftProjectViewProps {
  /** Deletes this environment using the page's normal cleanup policy. */
  onDeleteProject: () => void | Promise<void>;
}

function relativeTime(iso: string | undefined, t: Dictionary): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return "";
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return t.projects.time.justNow;
  if (m < 60) return interpolate(t.projects.time.minutesAgo, { count: String(m) });
  const h = Math.round(m / 60);
  if (h < 24) return interpolate(t.projects.time.hoursAgo, { count: String(h) });
  return interpolate(t.projects.time.daysAgo, { count: String(Math.round(h / 24)) });
}

/** Setup and deployment history for projects without a successful release. */
export function DraftProjectView({ onDeleteProject }: DraftProjectViewProps) {
  const { id, projectData } = useProjectSettings();
  const { t } = useI18n();
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const status = getProjectStatus(projectData);
  const busy = deleting || status === "deleting";

  const hasRepoSource = Boolean(projectData?.gitOwner && projectData?.gitRepo);
  const hasLocalSource = Boolean(projectData?.localPath);
  const isApp = Boolean(projectData?.isApp);
  const appTemplateId = (projectData as { appTemplateId?: string | null }).appTemplateId ?? undefined;
  const hasSource = hasRepoSource || hasLocalSource || isApp;
  const framework = projectData.framework ? getFrameworkConfig(projectData.framework) : null;
  // The project already carries its latest deployment. Let the shared history
  // own the request, pagination and errors instead of fetching a second list.
  const hasAttempts = Boolean(projectData.latestDeploymentId || projectData.latestDeploymentStatus);

  // A draft edits its config in the deploy WIZARD — the single edit owner — not
  // in the project's own (read-only) Configuration tab. `mode=config` opens the
  // wizard's config step and SAVES without deploying, so the draft stays a draft.
  // This is the same deep-link the live project's Configuration tab links out to.
  const goToConfig = useCallback(() => {
    const pid = projectData?.id;
    if (!pid) return;
    // A catalog app reopens its install wizard (its own config surface).
    if (isApp && appTemplateId) {
      router.push(`/apps/new/${appTemplateId}?projectId=${pid}`);
      return;
    }
    const slug = hasRepoSource
      ? encodeRepoSlug(projectData.gitOwner, projectData.gitRepo)
      : hasLocalSource
        ? encodeLocalSlug(projectData.localPath)
        : encodeProjectSlug(pid);
    router.push(`/deploy/${slug}?projectId=${pid}&mode=config`);
  }, [projectData, isApp, appTemplateId, hasRepoSource, hasLocalSource, router]);

  const handleDeploy = useCallback(() => {
    const pid = projectData?.id;
    if (!pid) return;
    // A catalog app reopens its install wizard (adopting this draft) rather than
    // the technical deploy wizard. Falls through to the saved-session deploy
    // below if the template id is somehow missing.
    if (isApp && appTemplateId) {
      router.push(`/apps/new/${appTemplateId}?projectId=${pid}`);
      return;
    }
    // A draft is NOT a fresh import — it already carries a saved deployment
    // session (build/runtime config, env, target). Deploy it by HYDRATING that
    // saved session: the wizard's project-slug path (decoded.kind === "project")
    // loads straight from the DB rows and keeps the finish button "Deploy". The
    // repo/local slugs instead RE-DETECTED from GitHub / the folder and threw the
    // saved settings away — turning "Deploy now" into a fresh first-deploy of an
    // already-configured project. Repo-less apps/services already deployed this
    // way; repo- and local-backed drafts now redeploy their session identically.
    if (hasSource) {
      router.push(`/deploy/${encodeProjectSlug(pid)}`);
      return;
    }
    // No source yet → open the wizard to set one up (never the in-project tab).
    goToConfig();
  }, [projectData, isApp, appTemplateId, hasSource, router, goToConfig]);

  const heading = status === "failed"
    ? t.projects.draft.headingFailed
    : status === "cancelled"
      ? t.projects.draft.headingCancelled
      : hasSource ? t.projects.draft.headingReady : t.projects.draft.connectSource;
  const subtext = !hasSource
    ? t.projects.draft.subtextNoSource
    : status === "draft" ? t.projects.draft.subtextDraft : t.projects.draft.subtextOther;
  const hostingLabel = projectData.serverName || (
    projectData.deployTarget === "cloud" ? t.projects.hosting.cloud
      : projectData.deployTarget === "server" ? t.projects.hosting.server
        : projectData.deployTarget === "local" ? t.projects.hosting.local
          : projectData.deployTarget === "cluster" ? t.servers.tabsNav.cluster
            : t.projects.draft.targetPending
  );

  const handleConfirmDelete = async () => {
    setShowDeleteDialog(false);
    setDeleting(true);
    try {
      await onDeleteProject();
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <Button asChild variant="ghost" size="icon" className="app-nav-fallback shrink-0">
            <Link href={isApp ? "/apps" : "/projects"} aria-label={isApp ? t.dashboard.nav.apps : t.dashboard.nav.projects}>
              <UiIcon name="arrow-left" className="size-4 rtl:rotate-180" />
            </Link>
          </Button>
          <div className="flex size-8 shrink-0 items-center justify-center" aria-hidden="true">
            {isApp ? <AppLogo appId={appTemplateId} className="size-8" />
              : framework ? framework.icon("var(--foreground)")
                : <UiIcon name="folder-code" className="size-7 text-muted-foreground" />}
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-medium tracking-tight text-foreground" title={projectData.name}>
              {projectData.name || t.projects.detail.projectFallback}
            </h1>
            <ProjectStatusBadge project={projectData} className="mt-1 rounded-full px-2 py-0.5 text-xs font-medium" />
          </div>
        </div>
        <Button
          variant="ghost"
          disabled={busy}
          className="shrink-0 text-danger hover:bg-danger-bg hover:text-danger"
          onClick={() => setShowDeleteDialog(true)}
        >
          <UiIcon name={busy ? "spinner" : "trash"} className={`size-4 ${busy ? "animate-spin" : ""}`} />
          {t.projects.draft.delete}
        </Button>
      </header>

      <div className="grid grid-cols-1 items-start gap-6 @min-[60rem]/project-draft:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-6">
          {hasAttempts && (
            <section aria-labelledby="draft-deployment-history">
              <div className="mb-4 space-y-1">
                <h2 id="draft-deployment-history" className="text-base font-medium text-foreground">{t.projects.draft.attemptsTitle}</h2>
                <p className="text-sm text-muted-foreground">{t.projects.draft.attemptsDescription}</p>
              </div>
              <DeploymentsContent projectId={id} projectName={projectData.name} appTemplateId={appTemplateId} hideHeader hideSidebar />
            </section>
          )}

          <section className="space-y-5 rounded-2xl bg-card p-5" aria-labelledby="draft-project-source">
            <div className="space-y-1">
              <h2 id="draft-project-source" className="text-base font-medium text-foreground">{t.projects.draft.sourceTitle}</h2>
              <p className="text-sm text-muted-foreground">{t.projects.draft.sourceDescription}</p>
            </div>
            {isApp ? (
              <div className="space-y-1 rounded-xl bg-background p-4">
                <p className="text-sm font-medium text-foreground">{t.projects.draft.managedImages}</p>
                <p className="text-sm text-muted-foreground">{t.projects.draft.managedImagesText}</p>
              </div>
            ) : hasSource ? (
              <dl className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
                {hasRepoSource && <DetailItem label={t.projects.draft.repository} value={`${projectData.gitOwner}/${projectData.gitRepo}`} />}
                {hasRepoSource && projectData.gitBranch && <DetailItem label={t.projects.draft.branch} value={String(projectData.gitBranch)} />}
                {hasLocalSource && <DetailItem label={t.projects.draft.localPath} value={String(projectData.localPath)} />}
                {framework && <DetailItem label={t.projects.draft.framework} value={framework.name} />}
                {projectData.options?.buildCommand && <DetailItem label={t.projects.draft.build} value={String(projectData.options.buildCommand)} code />}
                {projectData.options?.outputDirectory && <DetailItem label={t.projectSettings.build.runtime.outputDirectory} value={String(projectData.options.outputDirectory)} code />}
              </dl>
            ) : (
              <p className="rounded-xl bg-background p-4 text-sm text-muted-foreground">{t.projects.draft.noSourceText}</p>
            )}
            {(projectData.serviceCount ?? 0) > 1 && (
              <p className="text-sm text-muted-foreground">{t.projects.draft.services}<span className="ms-2 font-medium text-foreground">{projectData.serviceCount}</span></p>
            )}
          </section>
        </div>

        <aside className="order-first space-y-4 @min-[60rem]/project-draft:order-none @min-[60rem]/project-draft:sticky @min-[60rem]/project-draft:top-6">
          <section className="space-y-5 rounded-2xl bg-card p-5">
            <div className="space-y-2">
              <h2 className="text-base font-medium text-foreground">{heading}</h2>
              <p className="text-sm leading-relaxed text-muted-foreground">{subtext}</p>
            </div>
            <div className="flex items-center gap-3 rounded-xl bg-background p-4">
              <UiIcon name={projectData.deployTarget === "cloud" ? "cloud" : "server"} className="size-5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 space-y-1">
                <p className="text-xs text-muted-foreground">{t.projects.draft.target}</p>
                <p className="break-words text-sm font-medium text-foreground">{hostingLabel}</p>
              </div>
            </div>
            <div className="space-y-2">
              <Button className="h-11 w-full" disabled={busy} onClick={handleDeploy}>
                {hasSource ? t.projects.draft.deployNow : t.projects.draft.connectSource}
              </Button>
              {hasSource && !isApp && (
                <Button variant="secondary" className="w-full" disabled={busy} onClick={goToConfig}>
                  {t.projects.draft.settings}
                </Button>
              )}
            </div>
            {projectData.createdAt && (
              <p className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
                <span>{t.projects.draft.created}</span>
                <time dateTime={String(projectData.createdAt)}>{relativeTime(String(projectData.createdAt), t)}</time>
              </p>
            )}
          </section>
        </aside>
      </div>
      <DeleteConfirmationDialog
        isOpen={showDeleteDialog}
        onClose={() => setShowDeleteDialog(false)}
        onConfirm={handleConfirmDelete}
        projectName={projectData.name || ""}
      />
    </>
  );
}

function DetailItem({ label, value, code = false }: { label: string; value: string; code?: boolean }) {
  return (
    <div className="min-w-0 space-y-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={`whitespace-pre-wrap break-words text-sm text-foreground ${code ? "font-mono" : ""}`}>{value}</dd>
    </div>
  );
}
