import React, { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  Download,
  ExternalLink,
  GitBranch,
  GitCommit,
  Globe,
  Github,
  Loader2,
  Webhook,
  Zap,
} from "lucide-react";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { useGitHub } from "@/context/GitHubContext";
import type { GitHubRepo } from "@/context/GitHubContext";
import { useToast } from "@/context/ToastContext";
import { formatDate } from "@/utils/date";
import { projectsApi } from "@/lib/api";
import { getApiErrorMessage } from "@/lib/api/client";
import { Modal } from "@/components/ui/Modal";
import { RepositoryList } from "../../../library/components/RepositoryList";

export const GitSettings = () => {
  const { gitData, refreshGit, id, projectData } = useProjectSettings();
  const github = useGitHub();
  const { showToast } = useToast();
  const [isTogglingAutoDeploy, setIsTogglingAutoDeploy] = useState(false);
  const [isLinking, setIsLinking] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [isSettingDomain, setIsSettingDomain] = useState(false);
  const [showDomainMenu, setShowDomainMenu] = useState(false);
  const hasRefreshed = useRef(false);

  useEffect(() => {
    if (!hasRefreshed.current) {
      hasRefreshed.current = true;
      refreshGit();
    }
  }, [refreshGit]);

  const handleAutoDeployToggle = async () => {
    setIsTogglingAutoDeploy(true);
    try {
      const newState = !gitData.autoDeployEnabled;
      const response = await projectsApi.setAutoDeploy(id, newState);
      if (response.success) {
        showToast(newState ? "Auto-deploy enabled" : "Auto-deploy disabled", "success");
        await refreshGit();
      } else {
        showToast(response.error || "Failed to toggle auto-deploy", "error");
        await refreshGit();
      }
    } catch (error) {
      showToast(getApiErrorMessage(error, "Failed to toggle auto-deploy"), "error");
      await refreshGit();
    } finally {
      setIsTogglingAutoDeploy(false);
    }
  };

  const handleSetWebhookDomain = async (domain: string | null) => {
    setIsSettingDomain(true);
    setShowDomainMenu(false);
    try {
      const response = await projectsApi.setWebhookDomain(id, domain);
      if (response.success) {
        showToast(domain ? `Webhook domain set to ${domain}` : "Webhook domain cleared", "success");
        await refreshGit();
      } else {
        showToast(response.error || "Failed to set webhook domain", "error");
      }
    } catch (error) {
      showToast(getApiErrorMessage(error, "Failed to set webhook domain"), "error");
    } finally {
      setIsSettingDomain(false);
    }
  };

  if (gitData.isLoading) {
    return (
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1fr_320px]">
        <div className="space-y-5">
          <LoadingCard />
          <LoadingCard />
        </div>
        <div>
          <LoadingCard />
        </div>
      </div>
    );
  }

  if (!gitData.repository) {
    const handleLinkRepo = async (ownerLogin: string, repo: GitHubRepo) => {
      setIsLinking(true);
      try {
        const result = await projectsApi.linkRepo(id, { owner: ownerLogin, repo: repo.name });
        if (result.success) {
          showToast(`Linked to ${ownerLogin}/${repo.name}`, "success");
          setShowPicker(false);
          await refreshGit();
        } else if (result.install_url) {
          showToast(result.error || "GitHub App is not installed for this account", "error");
          setShowPicker(false);
          window.open(result.install_url, "_blank", "noopener,noreferrer");
        } else {
          showToast(result.error || "Failed to link repository", "error");
        }
      } catch (error) {
        showToast(getApiErrorMessage(error, "Failed to link repository"), "error");
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
          <h3 className="mt-4 text-base font-semibold text-foreground">Connect GitHub first</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Link your GitHub account to connect a repository to this project.
          </p>
          <button
            onClick={() => void github.connect()}
            disabled={github.connecting}
            className="mt-4 inline-flex items-center gap-2 rounded-xl bg-foreground px-4 py-2.5 text-[13px] font-medium text-background transition-colors hover:bg-foreground/90 disabled:opacity-50"
          >
            {github.connecting ? <Loader2 className="size-4 animate-spin" /> : <Github className="size-4" />}
            {github.connecting ? "Connecting…" : "Connect GitHub"}
          </button>
        </div>
      );
    }

    // Connected — show CTA + modal picker
    return (
      <>
        <div className="rounded-2xl border border-border/50 bg-card p-8 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
            <Github className="size-6 text-primary" />
          </div>
          <h3 className="mt-4 text-base font-semibold text-foreground">Link a Repository</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Connect a GitHub repository to enable webhook-triggered deployments.
          </p>
          <button
            onClick={() => setShowPicker(true)}
            className="mt-4 inline-flex items-center gap-2 rounded-xl bg-foreground px-4 py-2.5 text-[13px] font-medium text-background transition-colors hover:bg-foreground/90"
          >
            <Github className="size-4" />
            Select Repository
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
            <h2 className="text-base font-semibold text-foreground">Select a repository</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">Choose a repository to link to this project</p>
          </div>
          {isLinking && (
            <div className="flex items-center gap-2 px-5 py-2.5 bg-primary/5 border-b border-border/50 text-sm text-primary">
              <Loader2 className="size-4 animate-spin" />
              Linking repository…
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
            />
          </div>
        </Modal>
      </>
    );
  }

  return (
    <div className="space-y-5">
      {/* Install GitHub App banner — cloud-deployed projects that lack the app */}
      {projectData.deployTarget === "cloud" && !gitData.installationInstalled && (
        <div className="flex items-start gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/5 px-5 py-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-500/10">
            <AlertTriangle className="size-4 text-amber-500" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-[14px] font-semibold text-foreground">GitHub App not installed</h3>
            <p className="mt-0.5 text-[12px] text-muted-foreground">
              Install the Openship GitHub App on your account or organization to enable auto-deploy and webhook-triggered deployments for cloud projects.
            </p>
            <a
              href={gitData.installUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-flex items-center gap-2 rounded-xl bg-foreground px-4 py-2 text-[13px] font-medium text-background transition-colors hover:bg-foreground/90"
            >
              <Download className="size-4" />
              Install GitHub App
            </a>
          </div>
        </div>
      )}

      {/* No webhook endpoint banner — local/private instances need a direct endpoint */}
      {gitData.webhookStrategy === "none" && (
        <div className="flex items-start gap-3 rounded-2xl border border-blue-500/30 bg-blue-500/5 px-5 py-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-blue-500/10">
            <Globe className="size-4 text-blue-500" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-[14px] font-semibold text-foreground">Enable auto-deploy</h3>
            <p className="mt-0.5 text-[12px] text-muted-foreground">
              Auto-deploy needs a direct webhook endpoint. Expose this Openship API on a public URL or configure a verified webhook domain for direct delivery.
            </p>
          </div>
        </div>
      )}

      <div className="space-y-5">
        <SectionCard
          title="Source Repository"
          description="Git integration, deployment triggers, and repository health"
          icon={Github}
          iconTone="primary"
        >
          <div className="rounded-xl border border-border/50 bg-muted/20 px-4 py-3">
            <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/70">Repository</div>
            <div className="mt-2 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="truncate text-[14px] font-semibold text-foreground">{gitData.repository.name}</div>
                <div className="mt-1 flex items-center gap-2 text-[12px] text-muted-foreground">
                  <GitBranch className="size-3.5" />
                  <span>{gitData.branch || "main"}</span>
                </div>
              </div>
              <a
                href={gitData.repository.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl bg-foreground/[0.06] px-3 text-[13px] font-medium text-foreground transition-colors hover:bg-foreground/[0.1]"
              >
                <ExternalLink className="size-3.5" />
                Open
              </a>
            </div>
          </div>

          {/* Only show auto-deploy/webhook when prerequisites are met */}
          {!(
            (projectData.deployTarget === "cloud" && !gitData.installationInstalled) ||
            (gitData.webhookStrategy === "none" && !gitData.verifiedDomains?.length)
          ) && (
            <>
              {/* Webhook Domain Picker — show when verified domains are available */}
              {gitData.verifiedDomains && gitData.verifiedDomains.length > 0 && projectData.deployTarget !== "cloud" && (
                <div className="rounded-xl border border-border/50 bg-muted/20 px-4 py-3">
                  <div className="flex items-start gap-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <Globe className="size-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-medium text-foreground">Webhook Endpoint</p>
                      <p className="mt-0.5 text-[12px] text-muted-foreground">
                        {gitData.webhookDomain
                          ? "GitHub delivers push events directly to this domain"
                          : "Choose a domain for direct webhook delivery"
                        }
                      </p>
                      <div className="relative mt-2">
                        <button
                          type="button"
                          onClick={() => setShowDomainMenu(!showDomainMenu)}
                          disabled={isSettingDomain}
                          className="flex w-full items-center justify-between gap-2 rounded-lg border border-border/60 bg-background px-3 py-2 text-left text-[13px] transition-colors hover:border-border disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <span className={gitData.webhookDomain ? "text-foreground" : "text-muted-foreground"}>
                            {isSettingDomain ? "Updating..." : gitData.webhookDomain || "Select domain..."}
                          </span>
                          {isSettingDomain ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : <ChevronDown className="size-3.5 text-muted-foreground" />}
                        </button>
                        {showDomainMenu && (
                          <div className="absolute left-0 right-0 top-full z-10 mt-1 overflow-hidden rounded-lg border border-border/60 bg-popover shadow-lg">
                            {gitData.verifiedDomains.map((d) => (
                              <button
                                key={d.hostname}
                                type="button"
                                onClick={() => handleSetWebhookDomain(d.hostname)}
                                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] transition-colors hover:bg-muted/50 ${gitData.webhookDomain === d.hostname ? "bg-primary/5 text-primary" : "text-foreground"}`}
                              >
                                <Globe className="size-3.5 shrink-0" />
                                {d.hostname}
                                {d.ssl && <span className="ml-auto text-[11px] text-emerald-500">SSL</span>}
                              </button>
                            ))}
                            {gitData.webhookDomain && (
                              <button
                                type="button"
                                onClick={() => handleSetWebhookDomain(null)}
                                className="flex w-full items-center gap-2 border-t border-border/30 px-3 py-2 text-left text-[13px] text-muted-foreground transition-colors hover:bg-muted/50"
                              >
                                Clear selection
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              <div className="grid gap-3 sm:grid-cols-2">
                <InfoCard
                  icon={Zap}
                  title="Auto Deploy"
                  value={gitData.autoDeployEnabled ? "Enabled" : "Disabled"}
                  description={
                    gitData.autoDeployEnabled
                      ? gitData.webhookStrategy === "domain"
                          ? `Pushes deliver to ${gitData.webhookDomain}`
                          : "Pushes trigger deployments automatically"
                      : "Deployments must be started manually"
                  }
                  action={
                    <button
                      type="button"
                      role="switch"
                      aria-checked={gitData.autoDeployEnabled}
                      onClick={handleAutoDeployToggle}
                      disabled={isTogglingAutoDeploy}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${gitData.autoDeployEnabled ? "bg-primary" : "bg-muted"} ${isTogglingAutoDeploy ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
                    >
                      {isTogglingAutoDeploy ? (
                        <span className="mx-auto">
                          <Loader2 className="size-3.5 animate-spin text-background" />
                        </span>
                      ) : (
                        <span className={`inline-block h-4 w-4 transform rounded-full bg-background transition-transform ${gitData.autoDeployEnabled ? "translate-x-6" : "translate-x-1"}`} />
                      )}
                    </button>
                  }
                />
                <InfoCard
                  icon={Webhook}
                  title="Webhook"
                  value={
                    gitData.webhookStrategy === "domain" && gitData.webhookActive
                      ? "Direct"
                      : gitData.webhookActive
                          ? "Active"
                          : "Inactive"
                  }
                  description={
                    gitData.webhookStrategy === "domain" && gitData.webhookActive
                      ? `Events deliver directly via ${gitData.webhookDomain}`
                      : gitData.webhookActive
                          ? "Repository events are reaching Openship"
                          : "Webhook has not been configured or is not responding"
                  }
                  tone={gitData.webhookActive ? "success" : "neutral"}
                />
              </div>
            </>
          )}
        </SectionCard>

        <SectionCard
          title="Recent Commits"
          description={`Latest commits on ${gitData.branch || 'main'}`}
          icon={GitCommit}
          iconTone="orange"
        >
          {gitData.recentCommits.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border/60 bg-muted/15 px-4 py-5 text-center">
              <p className="text-sm font-medium text-foreground">No commits found</p>
              <p className="mt-1 text-sm text-muted-foreground">Push to your repository and recent commit activity will appear here.</p>
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
                View all commits on GitHub
                <ExternalLink className="size-3.5" />
              </a>
            </>
          )}
        </SectionCard>
      </div>
    </div>
  );
};

const ICON_TONES = {
  primary: "bg-primary/10 text-primary",
  emerald: "bg-emerald-500/10 text-emerald-500",
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

function LoadingCard() {
  return (
    <div className="rounded-2xl border border-border/50 bg-card p-5 animate-pulse">
      <div className="h-4 w-28 rounded bg-muted/50" />
      <div className="mt-4 space-y-3">
        <div className="h-10 rounded-xl bg-muted/40" />
        <div className="h-10 rounded-xl bg-muted/40" />
        <div className="h-10 rounded-xl bg-muted/40" />
      </div>
    </div>
  );
}

function InfoCard({
  icon: Icon,
  title,
  value,
  description,
  action,
  tone = "neutral",
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  value: string;
  description: string;
  action?: React.ReactNode;
  tone?: "neutral" | "success";
}) {
  return (
    <div className="rounded-xl border border-border/50 bg-muted/20 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${tone === "success" ? "bg-emerald-500/10 text-emerald-500" : "bg-primary/10 text-primary"}`}>
            <Icon className="size-4" />
          </div>
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-foreground">{title}</p>
            <p className="mt-1 text-[13px] font-semibold text-foreground">{value}</p>
            <p className="mt-1 text-[12px] text-muted-foreground">{description}</p>
          </div>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
    </div>
  );
}

