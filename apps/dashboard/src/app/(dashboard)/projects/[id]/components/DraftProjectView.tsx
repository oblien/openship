"use client";

/**
 * DraftProjectView — the focused screen shown for a project that has no
 * successful deployment yet (status: draft / failed / cancelled, i.e.
 * `activeDeploymentId == null`). The normal project dashboard assumes
 * analytics + an active deployment exist, so for a never-deployed project
 * it renders empty/broken; this replaces it with a purpose-built screen:
 *
 *   • a status hero with the primary "Deploy now" action
 *   • a two-column body: the full deploy-attempt history on the LEFT (each
 *     row opens that build directly at /build/{id} — no detour through the
 *     production deployments tab), and the source summary + danger zone
 *     stacked on the RIGHT.
 *
 * Everything a draft needs lives here — you never have to enter the
 * production tabbed UI while a project is still draft. The normal tabbed
 * dashboard returns automatically after the first successful deploy
 * (activeDeploymentId becomes non-null → status "live").
 *
 * Styling matches the rest of the project UI: `bg-card rounded-2xl border
 * border-border/50` cards, icon-in-rounded-box section headers, the shared
 * status pill (PROJECT_STATUS_META), and sidebar-style key/value rows.
 */

import { useCallback, useEffect, useState, type ComponentType } from "react";
import { useRouter } from "next/navigation";
import { Rocket, Settings, Trash2, Github, FolderCode, Boxes, Loader2, Info } from "lucide-react";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { AppLogo } from "@/components/AppLogo";
import { DeploymentsContent } from "@/app/(dashboard)/deployments/components";
import { projectsApi } from "@/lib/api";
import { getProjectStatus, PROJECT_STATUS_META, projectStatusLabel } from "@/utils/project-status";
import { encodeLocalSlug, encodeRepoSlug, encodeProjectSlug } from "@/utils/repoSlug";
import { useI18n, interpolate } from "@/components/i18n-provider";
import type { Dictionary } from "@/i18n";

interface DraftProjectViewProps {
  /** Deletes the project. Page passes its handleDeleteProject (defaults:
   *  deleteApp=true, wipeVolumes=false, force=false — correct for a draft
   *  with nothing provisioned). */
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

export function DraftProjectView({ onDeleteProject }: DraftProjectViewProps) {
  const { id, projectData, setActiveTab } = useProjectSettings();
  const { t } = useI18n();
  const router = useRouter();

  const [attemptCount, setAttemptCount] = useState(0);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const status = getProjectStatus(projectData);
  const meta = PROJECT_STATUS_META[status] ?? PROJECT_STATUS_META.draft;

  const hasRepoSource = Boolean(projectData?.gitOwner && projectData?.gitRepo);
  const hasLocalSource = Boolean(projectData?.localPath);
  // A one-click app has no git/local source — its prebuilt images ARE the source,
  // so it's deployable straight from its saved rows (like a repo-backed project).
  const isApp = Boolean(projectData?.isApp);
  const appTemplateId = (projectData as { appTemplateId?: string })?.appTemplateId ?? undefined;
  const hasSource = hasRepoSource || hasLocalSource || isApp;

  // Only used to decide whether to render the deployments list (a pristine
  // draft has none → the hero already says "not deployed yet"). The list
  // itself is rendered by the shared DeploymentsContent, which re-fetches.
  useEffect(() => {
    let cancelled = false;
    projectsApi
      .getDeployments(id)
      .then((res: unknown) => {
        if (cancelled) return;
        const list = Array.isArray(res) ? res : ((res as { data?: unknown[] })?.data ?? []);
        setAttemptCount(Array.isArray(list) ? list.length : 0);
      })
      .catch(() => {
        /* non-fatal — deployments section just stays hidden */
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const handleDeploy = useCallback(() => {
    if (!projectData?.id) return;
    const params = new URLSearchParams({ projectId: projectData.id });
    if (hasRepoSource) {
      router.push(`/deploy/${encodeRepoSlug(projectData.gitOwner, projectData.gitRepo)}?${params}`);
      return;
    }
    if (hasLocalSource) {
      router.push(`/deploy/${encodeLocalSlug(projectData.localPath)}?${params}`);
      return;
    }
    // A catalog app reopens its install wizard (adopting this draft) rather than
    // the technical deploy wizard. Fall back to /deploy if the template id is
    // somehow missing.
    if (isApp && appTemplateId) {
      router.push(`/apps/new/${appTemplateId}?projectId=${projectData.id}`);
      return;
    }
    if (isApp) {
      router.push(`/deploy/${encodeProjectSlug(projectData.id)}`);
      return;
    }
    setActiveTab("settings");
  }, [projectData, hasRepoSource, hasLocalSource, isApp, appTemplateId, router, setActiveTab]);

  const heading =
    status === "failed"
      ? t.projects.draft.headingFailed
      : status === "cancelled"
        ? t.projects.draft.headingCancelled
        : t.projects.draft.headingReady;
  const subtext =
    status === "draft" ? t.projects.draft.subtextDraft : t.projects.draft.subtextOther;

  // Draft "Details" — the key facts a draft can carry before its first deploy.
  const info = projectData as {
    deployTarget?: string | null;
    serverName?: string | null;
    serviceCount?: number;
    hasMultipleServices?: boolean;
    createdAt?: string;
  };
  const hostingLabel =
    info.deployTarget === "cloud"
      ? t.projects.hosting.cloud
      : info.deployTarget === "server"
        ? info.serverName || t.projects.hosting.server
        : info.deployTarget === "local"
          ? t.projects.hosting.local
          : null;
  const hasServiceFanout = info.hasMultipleServices || (info.serviceCount ?? 0) > 1;

  const confirmDelete = async () => {
    setDeleting(true);
    try {
      await onDeleteProject();
    } finally {
      setDeleting(false);
      setConfirmOpen(false);
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-5">
      {/* ── LEFT COLUMN — status + deploy history ─────────────────── */}
      <div className="space-y-5 min-w-0">
        {/* Status hero — soft icon, heading, status pill, primary actions.
            Lighter than a full section card: no divider, no eyebrow. */}
        <div className="bg-card rounded-2xl border border-border/50 p-5">
          <div className="flex items-start gap-3.5">
            {isApp ? (
              <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border/50 bg-background">
                <AppLogo appId={appTemplateId} className="size-6" />
              </div>
            ) : (
              <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 ring-1 ring-primary/15">
                <Rocket className="size-4 text-primary" />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-3">
                <h2 className="text-[15px] font-semibold text-foreground">{heading}</h2>
                <span
                  className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${meta.badge}`}
                >
                  <span className={`size-1.5 rounded-full ${meta.dot}`} />
                  {projectStatusLabel(status, t)}
                </span>
              </div>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{subtext}</p>

              <div className="mt-4 flex flex-wrap items-center gap-2">
                <button
                  onClick={handleDeploy}
                  className="inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                >
                  <Rocket className="size-4" />
                  {hasSource ? t.projects.draft.deployNow : t.projects.draft.connectSource}
                </button>
                <button
                  onClick={() => setActiveTab("settings")}
                  className="inline-flex items-center justify-center gap-2 rounded-xl border border-border/60 px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted"
                >
                  <Settings className="size-4" />
                  {t.projects.draft.settings}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Details — the draft's key facts (type, stack, where it'll run). */}
        <SectionCard
          icon={Info}
          title={t.projects.draft.detailsTitle}
          description={t.projects.draft.detailsDescription}
        >
          <div className="space-y-3">
            <InfoRow
              label={t.projects.draft.type}
              value={isApp ? t.projects.draft.typeApp : t.projects.draft.typeProject}
            />
            {projectData?.framework && (
              <InfoRow label={t.projects.draft.framework} value={String(projectData.framework)} />
            )}
            <InfoRow
              label={t.projects.draft.target}
              value={hostingLabel ?? t.projects.draft.targetPending}
            />
            {hasServiceFanout && (
              <InfoRow label={t.projects.draft.services} value={String(info.serviceCount ?? "—")} />
            )}
            {info.createdAt && (
              <InfoRow label={t.projects.draft.created} value={relativeTime(info.createdAt, t)} />
            )}
          </div>
        </SectionCard>

        {/* Deploy history — reuses the production deployment cards. Hidden for a
            pristine draft (the hero already says "not deployed yet"). */}
        {attemptCount > 0 && (
          <div>
            <h3 className="mb-3 px-1 text-[14px] font-semibold text-foreground">
              {t.projects.draft.attemptsTitle}
            </h3>
            <DeploymentsContent
              projectId={id}
              projectName={projectData?.name}
              hideHeader
              hideSidebar
            />
          </div>
        )}
      </div>

      {/* ── RIGHT COLUMN — source + delete ────────────────────────── */}
      <div className="space-y-5">
        <SectionCard
          icon={isApp ? Boxes : hasRepoSource ? Github : FolderCode}
          title={t.projects.draft.sourceTitle}
          description={t.projects.draft.sourceDescription}
        >
          {isApp ? (
            <div className="space-y-2">
              <InfoRow
                label={t.projects.draft.sourceTitle}
                value={t.projects.draft.managedImages}
              />
              <p className="text-xs text-muted-foreground/70">
                {t.projects.draft.managedImagesText}
              </p>
            </div>
          ) : hasSource ? (
            <div className="space-y-3">
              {hasRepoSource && (
                <InfoRow
                  label={t.projects.draft.repository}
                  value={`${projectData.gitOwner}/${projectData.gitRepo}`}
                />
              )}
              {hasRepoSource && projectData.gitBranch && (
                <InfoRow label={t.projects.draft.branch} value={String(projectData.gitBranch)} />
              )}
              {hasLocalSource && (
                <InfoRow label={t.projects.draft.localPath} value={String(projectData.localPath)} />
              )}
              {projectData?.framework && (
                <InfoRow label={t.projects.draft.framework} value={String(projectData.framework)} />
              )}
              {projectData?.options?.buildCommand && (
                <InfoRow
                  label={t.projects.draft.build}
                  value={`${projectData.options.buildCommand}${projectData.options.outputDirectory ? ` → ${projectData.options.outputDirectory}` : ""}`}
                />
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t.projects.draft.noSourceText}{" "}
              <button
                onClick={() => setActiveTab("settings")}
                className="font-medium text-primary hover:underline"
              >
                {t.projects.draft.connectLink}
              </button>
              .
            </p>
          )}
        </SectionCard>

        {/* Delete — de-emphasized. The section header owns the icon/title/
            "can't be undone" copy; a single quiet trigger lives in the header's
            action slot (right), escalating to a red confirm in the body only
            when the user opts in — no duplicated "Delete project" row. */}
        <SectionCard
          icon={Trash2}
          title={t.projects.draft.deleteTitle}
          description={t.projects.draft.deleteDescription}
          action={
            confirmOpen ? undefined : (
              <button
                onClick={() => setConfirmOpen(true)}
                className="inline-flex shrink-0 items-center rounded-xl border border-border/60 px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:border-danger/40 hover:text-danger"
              >
                {t.projects.draft.delete}
              </button>
            )
          }
        >
          {confirmOpen && (
            <div className="space-y-3">
              <p className="text-sm text-foreground">
                {t.projects.draft.deleteConfirmPrefix}{" "}
                <span className="font-medium">{projectData?.name}</span>
                {t.projects.draft.deleteConfirmSuffix}
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setConfirmOpen(false)}
                  disabled={deleting}
                  className="flex-1 rounded-xl border border-border px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
                >
                  {t.projects.draft.cancel}
                </button>
                <button
                  onClick={confirmDelete}
                  disabled={deleting}
                  className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-danger-solid px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-danger-solid/90 disabled:opacity-50"
                >
                  {deleting ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Trash2 className="size-4" />
                  )}
                  {t.projects.draft.delete}
                </button>
              </div>
            </div>
          )}
        </SectionCard>
      </div>
    </div>
  );
}

/* ── Themed building blocks ─────────────────────────────────────── */

// Lighter section card: inline icon + title (no ring box, no heavy divider),
// content flush below. Reads calmer than a bordered-header card.
function SectionCard({
  icon: Icon,
  title,
  description,
  action,
  children,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-card rounded-2xl border border-border/50 p-5">
      <div className="mb-4 flex items-start gap-2.5">
        <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-semibold leading-none text-foreground">{title}</h3>
          {description && <p className="mt-1.5 text-[12px] text-muted-foreground">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="truncate text-sm font-medium text-foreground" title={value}>
        {value}
      </span>
    </div>
  );
}
