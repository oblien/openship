import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  Download,
  Eye,
  EyeOff,
  ExternalLink,
  GitBranch,
  GitCommit,
  Github,
  Key,
  Loader2,
  Trash2,
} from "lucide-react";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { useGitHub } from "@/context/GitHubContext";
import type { GitHubRepo } from "@/context/GitHubContext";
import { useToast } from "@/context/ToastContext";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { formatDate } from "@/utils/date";
import { projectsApi } from "@/lib/api";
import { getApiErrorMessage } from "@/lib/api/client";
import { Modal } from "@/components/ui/Modal";
import { RepositoryList } from "../../../library/components/RepositoryList";
import { InfoCard } from "@/components/settings/InfoCard";
import { AppSource } from "./AppSource";
import { GitSettingsSkeleton } from "./GitSettingsSkeleton";

export const GitSettings = () => {
  const { gitData, refreshGit, id, projectData, updateProjectData } = useProjectSettings();
  const github = useGitHub();
  const { showToast } = useToast();
  const { t } = useI18n();
  const [isLinking, setIsLinking] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [togglingAuto, setTogglingAuto] = useState(false);
  const hasRefreshed = useRef(false);

  // Auto-deploy on push: one toggle → the API registers/removes the GitHub repo
  // webhook at this instance's public URL (repo strategy), or just flips the flag
  // for the GitHub App (cloud). No domain choice — the webhook gate is the
  // endpoint. Disabled when there's no public endpoint to receive pushes.
  const toggleAutoDeploy = async () => {
    setTogglingAuto(true);
    try {
      const res = await projectsApi.setAutoDeploy(id, !gitData.autoDeployEnabled);
      if (res.success) await refreshGit();
      else showToast(res.error || t.projectSettings.git.toast.autoDeployFailed, "error");
    } catch (err) {
      showToast(getApiErrorMessage(err, t.projectSettings.git.toast.autoDeployFailed), "error");
    } finally {
      setTogglingAuto(false);
    }
  };

  /* ── Per-project clone-token override ─────────────────────────── */
  const [cloneToken, setCloneToken] = useState<{ hasToken: boolean; setAt: string | null } | null>(null);
  const [cloneTokenLoading, setCloneTokenLoading] = useState(false);
  const [cloneTokenInput, setCloneTokenInput] = useState("");
  const [showCloneToken, setShowCloneToken] = useState(false);
  const [editingCloneToken, setEditingCloneToken] = useState(false);
  const [savingCloneToken, setSavingCloneToken] = useState(false);

  const refreshCloneToken = useCallback(async () => {
    if (!id) return;
    setCloneTokenLoading(true);
    try {
      const res = await projectsApi.getCloneToken(id);
      setCloneToken(res);
    } catch {
      setCloneToken({ hasToken: false, setAt: null });
    } finally {
      setCloneTokenLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void refreshCloneToken();
  }, [refreshCloneToken]);

  const saveCloneToken = async () => {
    const trimmed = cloneTokenInput.trim();
    if (!trimmed) {
      showToast(t.projectSettings.git.toast.pasteToken, "error", t.projectSettings.git.toast.cloneTokenTitle);
      return;
    }
    setSavingCloneToken(true);
    try {
      const res = await projectsApi.updateCloneToken(id, { token: trimmed });
      setCloneToken(res);
      setCloneTokenInput("");
      setEditingCloneToken(false);
      showToast(t.projectSettings.git.toast.tokenSaved, "success", t.projectSettings.git.toast.cloneTokenTitle);
    } catch (error) {
      showToast(getApiErrorMessage(error, t.projectSettings.git.toast.tokenSaveFailed), "error", t.projectSettings.git.toast.cloneTokenTitle);
    } finally {
      setSavingCloneToken(false);
    }
  };

  const clearCloneToken = async () => {
    setSavingCloneToken(true);
    try {
      const res = await projectsApi.updateCloneToken(id, { token: null });
      setCloneToken(res);
      setCloneTokenInput("");
      setEditingCloneToken(false);
      showToast(t.projectSettings.git.toast.tokenCleared, "success", t.projectSettings.git.toast.cloneTokenTitle);
    } catch (error) {
      showToast(getApiErrorMessage(error, t.projectSettings.git.toast.tokenClearFailed), "error", t.projectSettings.git.toast.cloneTokenTitle);
    } finally {
      setSavingCloneToken(false);
    }
  };

  useEffect(() => {
    if (!hasRefreshed.current) {
      hasRefreshed.current = true;
      refreshGit();
    }
  }, [refreshGit]);

  if (gitData.isLoading) {
    // Mirror the real SectionCard layout below (header → repository sub-card with
    // its inline auto-deploy toggle → rollback grid → recent commits) so the page
    // doesn't reflow when data lands.
    return <GitSettingsSkeleton />;
  }

  // Release/image apps (n8n, Convex, webmail…) deploy from a release or registry
  // tag, not a pushable git repo — show their release source + version + update
  // instead of the git-link/webhook UI. The Openship control plane is the one
  // exception: it updates itself via the CLI, and its per-app "Update" button
  // would no-op against its adopt deployment (the backend now 403s that path),
  // so show a CLI note instead of the update UI.
  if (projectData.isApp) {
    if (projectData.appTemplateId === "openship") {
      return (
        <div className="rounded-2xl border border-border/50 bg-card p-5">
          <p className="text-sm leading-relaxed text-muted-foreground">
            {t.projectSettings.appSource.cliManaged}
          </p>
        </div>
      );
    }
    return <AppSource />;
  }

  if (!gitData.repository) {
    const handleLinkRepo = async (ownerLogin: string, repo: GitHubRepo) => {
      setIsLinking(true);
      try {
        const result = await projectsApi.linkRepo(id, { owner: ownerLogin, repo: repo.name });
        if (result.success) {
          showToast(interpolate(t.projectSettings.git.toast.linked, { repo: `${ownerLogin}/${repo.name}` }), "success");
          setShowPicker(false);
          await refreshGit();
        } else if (result.install_url) {
          showToast(result.error || t.projectSettings.git.toast.appNotInstalled, "error");
          setShowPicker(false);
          window.open(result.install_url, "_blank", "noopener,noreferrer");
        } else {
          showToast(result.error || t.projectSettings.git.toast.linkFailed, "error");
        }
      } catch (error) {
        showToast(getApiErrorMessage(error, t.projectSettings.git.toast.linkFailed), "error");
      } finally {
        setIsLinking(false);
      }
    };

    // Not connected to GitHub at all
    if (!github.connected && !github.loading) {
      return (
        <div className="rounded-2xl border border-border/50 bg-card p-8 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-muted/40">
            <Github className="size-6 text-muted-foreground/50" />
          </div>
          <h3 className="mt-4 text-base font-semibold text-foreground">{t.projectSettings.git.connectFirst.title}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {t.projectSettings.git.connectFirst.description}
          </p>
          <button
            onClick={() => void github.connect()}
            disabled={github.connecting}
            className="mt-4 inline-flex items-center gap-2 rounded-xl bg-foreground px-4 py-2.5 text-[13px] font-medium text-background transition-colors hover:bg-foreground/90 disabled:opacity-50"
          >
            {github.connecting ? <Loader2 className="size-4 animate-spin" /> : <Github className="size-4" />}
            {github.connecting ? t.projectSettings.git.connectFirst.connecting : t.projectSettings.git.connectFirst.connect}
          </button>
        </div>
      );
    }

    // Connected - show CTA + modal picker
    return (
      <>
        <div className="rounded-2xl border border-border/50 bg-card p-8 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
            <Github className="size-6 text-primary" />
          </div>
          <h3 className="mt-4 text-base font-semibold text-foreground">{t.projectSettings.git.link.title}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {t.projectSettings.git.link.description}
          </p>
          <button
            onClick={() => setShowPicker(true)}
            className="mt-4 inline-flex items-center gap-2 rounded-xl bg-foreground px-4 py-2.5 text-[13px] font-medium text-background transition-colors hover:bg-foreground/90"
          >
            <Github className="size-4" />
            {t.projectSettings.git.link.select}
          </button>
        </div>

        <Modal
          isOpen={showPicker}
          onClose={() => setShowPicker(false)}
          maxWidth="640px"
          width="640px"
          maxHeight="80vh"
          showCloseButton
          overflow="hidden"
        >
          <div className="px-5 py-4 border-b border-border/50">
            <h2 className="text-base font-semibold text-foreground">{t.projectSettings.git.picker.title}</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">{t.projectSettings.git.picker.description}</p>
          </div>
          {isLinking && (
            <div className="flex items-center gap-2 px-5 py-2.5 bg-primary/5 border-b border-border/50 text-sm text-primary">
              <Loader2 className="size-4 animate-spin" />
              {t.projectSettings.git.picker.linking}
            </div>
          )}
          <div className="overflow-y-auto" style={{ maxHeight: "calc(80vh - 120px)" }}>
            <RepositoryList
              repos={github.repos}
              accounts={github.accounts}
              selectedOwner={github.selectedOwner}
              setSelectedOwner={github.setSelectedOwner}
              loading={false}
              loadingRepos={github.loadingRepos}
              onSelect={handleLinkRepo}
              installUrl={github.installUrl}
            />
          </div>
        </Modal>
      </>
    );
  }

  return (
    <div className="space-y-5">
      {/* Install GitHub App banner - cloud-deployed projects that lack the app */}
      {projectData.deployTarget === "cloud" && !gitData.installationInstalled && (
        <div className="flex items-start gap-3 rounded-2xl border border-warning-border bg-warning-bg px-5 py-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-warning-bg">
            <AlertTriangle className="size-4 text-warning" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-[14px] font-semibold text-foreground">{t.projectSettings.git.appBanner.title}</h3>
            <p className="mt-0.5 text-[12px] text-muted-foreground">
              {t.projectSettings.git.appBanner.description}
            </p>
            <a
              href={gitData.installUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-flex items-center gap-2 rounded-xl bg-foreground px-4 py-2 text-[13px] font-medium text-background transition-colors hover:bg-foreground/90"
            >
              <Download className="size-4" />
              {t.projectSettings.git.appBanner.install}
            </a>
          </div>
        </div>
      )}

      <div className="space-y-5">
        <SectionCard
          title={t.projectSettings.git.source.title}
          description={t.projectSettings.git.source.description}
          icon={Github}
          iconTone="primary"
        >
          <div className="rounded-xl border border-border/50 bg-muted/20 px-4 py-3.5">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/70">{t.projectSettings.git.source.repository}</div>
                {/* owner/repo as the prominent, clickable identity (opens on GitHub). */}
                <a
                  href={gitData.repository.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group mt-1.5 inline-flex max-w-full items-center gap-2 underline-offset-4"
                >
                  <span className="truncate text-[15px] font-semibold text-foreground transition-colors group-hover:text-primary group-hover:underline">
                    {gitData.repository.full_name || gitData.repository.name}
                  </span>
                  <ExternalLink className="size-3.5 shrink-0 text-muted-foreground transition-colors group-hover:text-primary" />
                </a>
                {/* Branch + latest commit at a glance — what's actually connected. */}
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    <GitBranch className="size-3.5 shrink-0" />
                    {gitData.branch || "main"}
                  </span>
                  {gitData.recentCommits?.[0] && (
                    <>
                      <span className="text-muted-foreground/40">·</span>
                      <span className="inline-flex min-w-0 items-center gap-1.5">
                        <GitCommit className="size-3.5 shrink-0" />
                        <code className="rounded bg-muted/50 px-1 py-px text-[10px] font-medium">
                          {gitData.recentCommits[0].id?.slice(0, 7)}
                        </code>
                        <span className="truncate">{gitData.recentCommits[0].message?.split("\n")[0]}</span>
                      </span>
                    </>
                  )}
                </div>
              </div>

              {/* Auto-deploy on push — inline with the repo identity. Enabling
                  registers the GitHub repo webhook at this instance's public URL
                  (or uses the GitHub App on cloud); no domain picker. Disabled
                  with a hover tooltip when there's no public endpoint. */}
              {gitData.repository?.full_name && (() => {
                const cannotReceive = gitData.webhookStrategy === "none";
                const disabled = togglingAuto || (cannotReceive && !gitData.autoDeployEnabled);
                return (
                  <div className="flex shrink-0 flex-col items-end gap-1.5 pt-0.5">
                    <div className="flex items-center gap-2">
                    <span className="text-[12px] font-medium text-muted-foreground">{t.projectSettings.gitInfo.autoDeploy}</span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={!!gitData.autoDeployEnabled}
                      aria-label={t.projectSettings.gitInfo.autoDeploy}
                      onClick={toggleAutoDeploy}
                      disabled={disabled}
                      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                        gitData.autoDeployEnabled ? "bg-primary" : "bg-muted"
                      } ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
                    >
                      {togglingAuto ? (
                        <Loader2 className="mx-auto size-3.5 animate-spin text-background" />
                      ) : (
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-background transition-transform ${
                            gitData.autoDeployEnabled ? "translate-x-6 rtl:-translate-x-6" : "translate-x-1 rtl:-translate-x-1"
                          }`}
                        />
                      )}
                    </button>
                    </div>
                    {/* When there's no public endpoint the toggle is disabled — show WHY
                        inline (was hover-tooltip-only), using the space under the switch. */}
                    {cannotReceive && (
                      <p className="max-w-[220px] text-end text-[11px] leading-snug text-muted-foreground/70">
                        {t.projectSettings.git.webhookBanner.description}
                      </p>
                    )}
                  </div>
                );
              })()}
            </div>
          </div>

          {/* Rollback retention used to live here. It moved to the Backup tab,
              next to the other recovery controls — and to the deploy wizard's
              target panel, since retention is a property of the machine you
              deploy to. Both render the one RollbackRetentionCards component. */}
        </SectionCard>

        <SectionCard
          title={t.projectSettings.git.commits.title}
          description={interpolate(t.projectSettings.git.commits.subtitle, { branch: gitData.branch || 'main' })}
          icon={GitCommit}
          iconTone="orange"
        >
          {gitData.recentCommits.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border/60 bg-muted/15 px-4 py-5 text-center">
              <p className="text-sm font-medium text-foreground">{t.projectSettings.git.commits.empty}</p>
              <p className="mt-1 text-sm text-muted-foreground">{t.projectSettings.git.commits.emptyDesc}</p>
            </div>
          ) : (
            <>
              <div className="overflow-hidden rounded-xl border border-border/40 divide-y divide-border/30">
                {gitData.recentCommits.slice(0, 8).map((commit: any) => (
                  <div key={commit.id} className="flex items-center gap-3 px-4 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        {commit.authorAvatar ? (
                          <img src={commit.authorAvatar} alt={commit.author} className="size-4 rounded-full" />
                        ) : null}
                        <span className="text-[11px] font-medium text-muted-foreground">{commit.author}</span>
                        <span className="text-muted-foreground/40">·</span>
                        <span className="text-[11px] text-muted-foreground">{formatDate(commit.time, undefined, undefined, true)}</span>
                        <code className="rounded-full bg-muted/50 px-1.5 py-px text-[10px] font-medium text-muted-foreground">{commit.id?.slice(0, 7)}</code>
                      </div>
                      <p className="mt-0.5 truncate text-[12px] text-foreground">{commit.message?.split('\n')[0]}</p>
                    </div>
                    {commit.url ? (
                      <a
                        href={commit.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
                      >
                        <ExternalLink className="size-3" />
                      </a>
                    ) : null}
                  </div>
                ))}
              </div>
              <a
                href={`${gitData.repository.url}/commits/${gitData.branch || 'main'}`}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-flex items-center gap-1.5 text-[13px] font-medium text-primary transition-colors hover:text-primary/80"
              >
                {t.projectSettings.git.commits.viewAll}
                <ExternalLink className="size-3.5" />
              </a>
            </>
          )}
        </SectionCard>

        <SectionCard
          title={t.projectSettings.git.cloneToken.title}
          description={t.projectSettings.git.cloneToken.description}
          icon={Key}
          iconTone="primary"
        >
          {cloneTokenLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t.projectSettings.git.cloneToken.loading}
            </div>
          ) : (!cloneToken?.hasToken || editingCloneToken) ? (
            <div className="space-y-2.5">
              <p className="text-[13px] text-muted-foreground">
                {t.projectSettings.git.cloneToken.explainer}
              </p>
              <div className="relative">
                <input
                  type={showCloneToken ? "text" : "password"}
                  value={cloneTokenInput}
                  onChange={(e) => setCloneTokenInput(e.target.value)}
                  placeholder="ghp_… or github_pat_…"
                  spellCheck={false}
                  autoComplete="off"
                  className="h-10 w-full rounded-xl border border-border/50 bg-muted/20 px-3 pe-10 text-sm font-mono text-foreground outline-none transition-colors focus:border-primary/40"
                />
                <button
                  type="button"
                  onClick={() => setShowCloneToken((s) => !s)}
                  className="absolute end-2 top-1/2 -translate-y-1/2 size-7 rounded-lg flex items-center justify-center text-muted-foreground hover:bg-muted/40 hover:text-foreground transition-colors"
                  aria-label={showCloneToken ? t.projectSettings.git.cloneToken.hide : t.projectSettings.git.cloneToken.show}
                >
                  {showCloneToken ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                </button>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={saveCloneToken}
                  disabled={savingCloneToken || !cloneTokenInput.trim()}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-foreground px-3.5 py-2 text-[13px] font-medium text-background transition-colors hover:bg-foreground/90 disabled:opacity-50"
                >
                  {savingCloneToken ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                  {t.projectSettings.git.cloneToken.saveToken}
                </button>
                {editingCloneToken && (
                  <button
                    type="button"
                    onClick={() => {
                      setEditingCloneToken(false);
                      setCloneTokenInput("");
                    }}
                    disabled={savingCloneToken}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-foreground/[0.06] px-3.5 py-2 text-[13px] font-medium text-foreground transition-colors hover:bg-foreground/[0.1]"
                  >
                    {t.projectSettings.git.cloneToken.cancel}
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-border/50 bg-muted/15 p-3.5 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">{t.projectSettings.git.cloneToken.savedTitle}</p>
                <p className="text-sm text-muted-foreground mt-0.5">
                  {interpolate(t.projectSettings.git.cloneToken.lastUpdated, { when: cloneToken.setAt ? new Date(cloneToken.setAt).toLocaleString() : t.projectSettings.git.cloneToken.justNow })}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => setEditingCloneToken(true)}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-foreground/[0.06] px-3 py-1.5 text-[12px] font-medium text-foreground transition-colors hover:bg-foreground/[0.1]"
                >
                  {t.projectSettings.git.cloneToken.replace}
                </button>
                <button
                  type="button"
                  onClick={clearCloneToken}
                  disabled={savingCloneToken}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-danger-bg px-3 py-1.5 text-[12px] font-medium text-danger transition-colors hover:bg-danger-bg disabled:opacity-50"
                >
                  <Trash2 className="size-3" />
                  {t.projectSettings.git.cloneToken.clear}
                </button>
              </div>
            </div>
          )}
        </SectionCard>
      </div>
    </div>
  );
};

const ICON_TONES = {
  primary: "bg-primary/10 text-primary",
  emerald: "bg-success-bg text-success",
  orange: "bg-orange-500/10 text-orange-500",
} as const;

function SectionCard({
  title,
  description,
  icon: Icon,
  iconTone,
  children,
}: {
  title: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  iconTone: keyof typeof ICON_TONES;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border/50 bg-card">
      <div className="flex items-start gap-3 border-b border-border/40 px-5 py-4">
        <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${ICON_TONES[iconTone]}`}>
          <Icon className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-semibold text-foreground">{title}</h3>
          <p className="mt-0.5 text-[12px] text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="space-y-4 px-5 py-4">{children}</div>
    </div>
  );
}


