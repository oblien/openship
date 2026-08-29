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
 *   • the draft's reference facts in a folded "Details" card BELOW the attempt
 *     list — deliberately last and shut, so nothing static sits between the
 *     hero and the builds you came to read.
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

import { useCallback, useEffect, useId, useState, type ComponentType } from "react";
import { useRouter } from "next/navigation";
import {
  Rocket,
  Settings,
  Trash2,
  Github,
  FolderCode,
  Boxes,
  Loader2,
  Info,
  ChevronDown,
} from "lucide-react";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { AppLogo } from "@/components/AppLogo";
import { DeploymentsContent } from "@/app/(dashboard)/deployments/components";
import { projectsApi } from "@/lib/api";
import { getProjectStatus, PROJECT_STATUS_META, projectStatusLabel } from "@/utils/project-status";
import { encodeLocalSlug, encodeRepoSlug, encodeProjectSlug } from "@/utils/repoSlug";
import { useI18n, interpolate } from "@/components/i18n-provider";
import type { Dictionary } from "@/i18n";

interface DraftProjectViewProps {
  /** Deletes this environment. Page passes its handleDeleteProject (defaults:
   *  wipeVolumes=false, force=false — correct for a draft
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
  const { id, projectData } = useProjectSettings();
  const { t } = useI18n();
  const router = useRouter();

  const [attemptCount, setAttemptCount] = useState(0);
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
                  className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-1 text-[11px] font-semibold ${meta.badge}`}
                >
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
                  onClick={goToConfig}
                  className="inline-flex items-center justify-center gap-2 rounded-xl border border-border/60 px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted"
                >
                  <Settings className="size-4" />
                  {t.projects.draft.settings}
                </button>
              </div>
            </div>
          </div>
        </div>

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

        {/* Details LAST, and folded shut. What you came to a failed draft for is
            the attempt list — which build broke, open it — while type/framework/
            target are reference facts that don't change and mostly repeat the
            Source card beside them. Directly under the hero they pushed the
            attempts a whole card down the page; behind one press they cost a row. */}
        <SectionCard
          icon={Info}
          title={t.projects.draft.detailsTitle}
          description={t.projects.draft.detailsDescription}
          collapsible
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
                onClick={goToConfig}
                className="font-medium text-primary hover:underline"
              >
                {t.projects.draft.connectLink}
              </button>
              .
            </p>
          )}
        </SectionCard>

        {/* Delete — always in its final state, no reveal step. A draft has no
            workload to lose, and hiding Delete behind a quiet trigger only made
            it take two clicks to bin an abandoned draft (which is most of what
            this view is for).
            Its counterpart is the constructive half of the same decision —
            finish this draft, or drop it — so the pair reads as one fork rather
            than a lone red button. That slot used to hold "Cancel", which had
            nothing left to cancel once the confirm is permanent. */}
        <SectionCard
          icon={Trash2}
          title={t.projects.draft.deleteTitle}
          description={t.projects.draft.deleteDescription}
        >
          <div className="space-y-3">
            <p className="text-sm text-foreground">
              {t.projects.draft.deleteConfirmPrefix}{" "}
              <span className="font-medium">{projectData?.name}</span>
              {t.projects.draft.deleteConfirmSuffix}
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={handleDeploy}
                disabled={deleting}
                className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl border border-border px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
              >
                <Rocket className="size-4" />
                {hasSource ? t.projects.draft.deployNow : t.projects.draft.connectSource}
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
        </SectionCard>
      </div>
    </div>
  );
}

/* ── Themed building blocks ─────────────────────────────────────── */

// Lighter section card: inline icon + title (no ring box, no heavy divider),
// content flush below. Reads calmer than a bordered-header card.
//
// `collapsible` turns the header into the disclosure control and starts the card
// shut, so a card of static reference facts costs one row instead of a screenful.
// Collapsed it drops the description too — a folded card should be a single line,
// and the subtitle only earns its space once you've asked for the content.
function SectionCard({
  icon: Icon,
  title,
  description,
  action,
  collapsible = false,
  children,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  action?: React.ReactNode;
  collapsible?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(!collapsible);
  const contentId = useId();

  const header = (
    <>
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <h3 className="text-[14px] font-semibold leading-none text-foreground">{title}</h3>
        {description && open && (
          <p className="mt-1.5 text-[12px] text-muted-foreground">{description}</p>
        )}
      </div>
      {action}
    </>
  );

  return (
    <div className="bg-card rounded-2xl border border-border/50 p-5">
      {collapsible ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={contentId}
          className={`group flex w-full items-start gap-2.5 text-start ${open ? "mb-4" : ""}`}
        >
          {header}
          <ChevronDown
            className={`mt-0.5 size-4 shrink-0 text-muted-foreground transition-all group-hover:text-foreground ${
              open ? "rotate-180" : ""
            }`}
          />
        </button>
      ) : (
        <div className="mb-4 flex items-start gap-2.5">{header}</div>
      )}
      {open && <div id={contentId}>{children}</div>}
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
