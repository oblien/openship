"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { FolderUp, Github, Gitlab, Link2, Sparkles, Boxes } from "lucide-react";
import { useGitHub, type GitHubRepo } from "@/context/GitHubContext";
import { useGitLab, type GitLabProject } from "@/context/GitLabContext";
import { usePlatform } from "@/context/PlatformContext";
import { useCloud } from "@/context/CloudContext";
import { ConnectPrompt } from "./components/ConnectPrompt";
import { GitLabConnectPrompt } from "./components/GitLabConnectPrompt";
import { LoadingSkeleton } from "./components/LoadingSkeleton";
import { RepositoryList } from "./components/RepositoryList";
import { LocalProjects } from "./components/LocalProjects";
import { FolderUpload } from "./components/FolderUpload";
import { LibrarySidebar } from "./components/LibrarySidebar";
import { UrlImport } from "./components/UrlImport";
import { TemplateGrid } from "./components/TemplateGrid";
import { PageContainer } from "@/components/ui/PageContainer";
import { ServerMigrationWizard } from "@/components/migration/ServerMigrationWizard";
import { useI18n } from "@/components/i18n-provider";
import { encodeRepoSlug } from "@/utils/repoSlug";

/** Adapt GitLab's project/account shapes into the GitHub-shaped ones
 *  RepositoryList already knows how to render — avoids forking that
 *  component for a second provider. `id` carries the GitLab numeric
 *  project id (the REQUIRED `installationId` for git/link). */
function gitlabProjectsToRepoShape(projects: GitLabProject[]): GitHubRepo[] {
  return projects.map((p) => ({
    id: p.id,
    full_name: p.fullName,
    name: p.repo,
    description: p.description ?? "",
    private: p.private,
    stars: 0,
    forks: 0,
    language: "",
    updated_at: p.updatedAt,
    default_branch: p.defaultBranch,
    owner: p.owner,
    html_url: p.htmlUrl,
  }));
}

type Tab = "folder" | "repositories" | "gitlab" | "url" | "template" | "server";

interface TabItem {
  key: Tab;
  label: string;
  icon: React.ElementType;
}

export default function LibraryPage() {
  const { t } = useI18n();
  const router = useRouter();
  const {
    state,
    connected,
    connecting,
    loading,
    connect,
    cliAction,
    accounts,
    selectedOwner,
    setSelectedOwner,
    repos,
    loadingRepos,
    refresh,
    installUrl,
  } = useGitHub();
  const {
    state: gitlabState,
    connected: gitlabConnected,
    connecting: gitlabConnecting,
    loading: gitlabLoading,
    connect: connectGitLab,
    accounts: gitlabAccounts,
    selectedNamespace,
    setSelectedNamespace,
    projects: gitlabProjects,
    loadingProjects: loadingGitlabProjects,
  } = useGitLab();
  const { selfHosted, deployMode } = usePlatform();
  // Only the desktop app can read the user's folder off disk (native picker +
  // co-located API). A remote self-hosted browser can't — it uploads like SaaS.
  const isDesktop = deployMode === "desktop";
  const { connected: cloudConnected, startConnect: startCloudConnect } = useCloud();

  // Default to the GitHub tab everywhere. When GitHub isn't connected it shows
  // the connect prompt (a fine call-to-action); the Folder/URL/Template tabs
  // are one click away for local/self-hosted deploys.
  const [activeTab, setActiveTab] = useState<Tab>("repositories");
  const [showMigrate, setShowMigrate] = useState(false);

  const gitlabRepos = React.useMemo(() => gitlabProjectsToRepoShape(gitlabProjects), [gitlabProjects]);
  const gitlabAccountRows = React.useMemo(
    () => gitlabAccounts.map((a) => ({ login: a.fullPath, avatar_url: a.avatarUrl ?? "" })),
    [gitlabAccounts],
  );

  // GitLab select-for-deploy: encode the slug like GitHub, but tag the query
  // string with `provider=gitlab` + the numeric GitLab project id (the
  // REQUIRED `installationId` for git/link) so the deploy wizard and the
  // eventual project-git-link both resolve through the GitLab source.
  const handleSelectGitLabRepo = (ownerLogin: string, repo: GitHubRepo) => {
    const slug = encodeRepoSlug(ownerLogin, repo.name);
    router.push(`/deploy/${slug}?provider=gitlab&installationId=${repo.id}`);
  };

  // One "Folder" tab, environment-dependent behavior:
  //   - self-hosted / desktop → deploy straight from a path on the box (native
  //     picker, no upload, no stack pick — the local pipeline reads it).
  //   - SaaS → upload the folder to a cloud build workspace (stack picked up
  //     front so we know which image to provision).
  const tabs: TabItem[] = [
    { key: "folder", label: t.library.page.tabs.folder, icon: FolderUp },
    { key: "repositories", label: t.library.page.tabs.github, icon: Github },
    { key: "gitlab", label: t.library.page.tabs.gitlab, icon: Gitlab },
    { key: "url", label: t.library.page.tabs.url, icon: Link2 },
    { key: "template", label: t.library.page.tabs.template, icon: Sparkles },
    // Adopting a running Docker deployment needs SSH into the user's own box —
    // self-hosted / desktop only (cloud mode has no server inventory).
    ...(selfHosted ? [{ key: "server" as const, label: t.migration.entry.tab, icon: Boxes }] : []),
  ];

  return (
    <PageContainer>

        {/* ── Header ───────────────────────────────────────────── */}
        <div className="mb-6">
          <h1 className="text-2xl font-medium text-foreground/80" style={{ letterSpacing: "-0.2px" }}>
            {t.library.page.title}
          </h1>
          <p className="text-sm text-muted-foreground/70 mt-1">
            {t.library.page.subtitle}
          </p>
        </div>

        {/* ── Tabs ─────────────────────────────────────────────── */}
        <div className="flex items-center gap-1 mb-6">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                  activeTab === tab.key
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                }`}
              >
                <Icon className="size-4" />
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* ── Main Grid ──────────────────────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-6">

          {/* ── LEFT COLUMN ────────────────────────────────────────── */}
          <div className="space-y-6 min-w-0">
            {activeTab === "server" ? (
              <div className="rounded-2xl border border-border/60 p-6 space-y-3">
                <div className="flex items-center gap-2">
                  <Boxes className="size-5 text-info" />
                  <h2 className="text-base font-medium text-foreground">
                    {t.migration.entry.cardTitle}
                  </h2>
                </div>
                <p className="text-sm text-muted-foreground">{t.migration.entry.cardDesc}</p>
                <button
                  type="button"
                  onClick={() => setShowMigrate(true)}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-foreground text-background text-sm font-medium hover:opacity-90 transition-opacity"
                >
                  <Boxes className="size-4" />
                  {t.migration.entry.action}
                </button>
              </div>
            ) : activeTab === "folder" ? (
              // Desktop reads the folder off disk (native picker, no upload/
              // stack). SaaS AND remote self-hosted browsers upload it instead
              // (they can't see the user's filesystem).
              isDesktop ? <LocalProjects /> : <FolderUpload />
            ) : activeTab === "url" ? (
              <UrlImport />
            ) : activeTab === "template" ? (
              <TemplateGrid />
            ) : activeTab === "gitlab" ? (
              gitlabLoading ? (
                <LoadingSkeleton />
              ) : !gitlabConnected ? (
                <GitLabConnectPrompt
                  connecting={gitlabConnecting}
                  onConnect={connectGitLab}
                  oauthConfigured={gitlabState.oauthConfigured}
                />
              ) : (
                  <RepositoryList
                  repos={gitlabRepos}
                  accounts={gitlabAccountRows}
                  selectedOwner={selectedNamespace}
                  setSelectedOwner={setSelectedNamespace}
                  loading={gitlabLoading}
                  loadingRepos={loadingGitlabProjects}
                  onSelect={handleSelectGitLabRepo}
                  provider="gitlab"
                />
              )
            ) : loading ? (
              <LoadingSkeleton />
            ) : !connected ? (
              <ConnectPrompt
                connecting={connecting}
                onConnect={connect}
                cliAction={cliAction}
                onRefresh={refresh}
                selfHosted={selfHosted}
                cloudConnected={cloudConnected}
                onConnectCloud={startCloudConnect}
              />
            ) : (
              <RepositoryList
                repos={repos}
                accounts={accounts}
                selectedOwner={selectedOwner}
                setSelectedOwner={setSelectedOwner}
                loading={loading}
                loadingRepos={loadingRepos}
                installUrl={installUrl}
              />
            )}
          </div>

          {/* ── RIGHT COLUMN ───────────────────────────────────────── */}
          {activeTab === "gitlab" ? (
            <GitLabSidebar
              connected={gitlabConnected}
              login={gitlabState.login}
              mode={gitlabState.mode}
              projectCount={gitlabRepos.length}
            />
          ) : (
            <LibrarySidebar
              selectedOwner={selectedOwner}
              repos={repos}
              selfHosted={selfHosted}
              state={state}
              cloudConnected={cloudConnected}
            />
          )}
        </div>

        <ServerMigrationWizard isOpen={showMigrate} onClose={() => setShowMigrate(false)} />
    </PageContainer>
  );
}

/** Minimal GitLab counterpart to LibrarySidebar — GitLab has one credential
 *  slot (no dual App/CLI sources), so there's no need for its richer layout. */
function GitLabSidebar({
  connected,
  login,
  mode,
  projectCount,
}: {
  connected: boolean;
  login: string | null;
  mode: "oauth" | "pat" | null;
  projectCount: number;
}) {
  return (
    <div className="space-y-4 lg:sticky lg:top-6 lg:self-start">
      <div className="bg-card rounded-2xl border border-border/50 p-5">
        <div className="flex items-center gap-2 mb-4">
          <Gitlab className="size-4 text-muted-foreground" />
          <h3 className="font-semibold text-foreground text-sm">Connection</h3>
        </div>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div
              className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${
                connected ? "bg-success-bg" : "bg-muted/60"
              }`}
            >
              <Gitlab className={`size-4 ${connected ? "text-success" : "text-muted-foreground"}`} />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground truncate">GitLab</p>
              <p className="text-xs text-muted-foreground truncate">
                {connected ? `@${login}${mode === "pat" ? " · PAT" : ""}` : "Not connected"}
              </p>
            </div>
          </div>
          <span
            className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium shrink-0 ${
              connected ? "bg-success-bg text-success" : "bg-muted/60 text-muted-foreground"
            }`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${connected ? "bg-success-solid" : "bg-muted-foreground/40"}`} />
            {connected ? "Connected" : "—"}
          </span>
        </div>
        {connected && (
          <div className="mt-4 pt-4 border-t border-border/40 flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Projects</span>
            <span className="text-lg font-semibold text-foreground">{projectCount}</span>
          </div>
        )}
      </div>
    </div>
  );
}
