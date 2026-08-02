"use client";

import React, { useState, useEffect, useCallback } from "react";
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
import { useLibraryRepos } from "./useLibraryRepos";
import { GhCliConsent } from "./components/GhCliConsent";
import { LocalProjects } from "./components/LocalProjects";
import { FolderUpload } from "./components/FolderUpload";
import { LibrarySidebar } from "./components/LibrarySidebar";
import { UrlImport } from "./components/UrlImport";
import { TemplateGrid } from "./components/TemplateGrid";
import { PageContainer } from "@/components/ui/PageContainer";
import { HelpMenu } from "@/components/HelpMenu";
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

/** One-time gh-CLI repo-read consent flag (per browser — desktop is single-user). */
const GH_CLI_CONSENT_KEY = "openship.gh-cli-consent";

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
  // Server-paginated repo list for the Library (own hook so the shared
  // GitHubContext.repos — used by the GitSettings + migration pickers — stays a
  // full-set, client-side list). Fetches a page at a time + authoritative counts.
  const libRepos = useLibraryRepos(selectedOwner, connected);
  const { selfHosted, deployMode } = usePlatform();
  // Only the desktop app can read the user's folder off disk (native picker +
  // co-located API). A remote self-hosted browser can't — it uploads like SaaS.
  const isDesktop = deployMode === "desktop";
  const { connected: cloudConnected } = useCloud();

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

  // First-run consent before the gh-CLI source lists repos. The gh path runs
  // entirely on this machine (nothing to the cloud), but we ask once so the
  // Library doesn't silently enumerate the user's repos on first open.
  const [ghCliConsent, setGhCliConsent] = useState(true); // optimistic until localStorage reads
  useEffect(() => {
    setGhCliConsent(localStorage.getItem(GH_CLI_CONSENT_KEY) === "1");
  }, []);
  const allowGhCli = useCallback(() => {
    localStorage.setItem(GH_CLI_CONSENT_KEY, "1");
    setGhCliConsent(true);
  }, []);
  // Gate ONLY a credential we found on the host by ourselves. A device sign-in or
  // a pasted token was handed over by the operator inside Openship — asking them
  // to consent again to the thing they just did is a dead end that made a fresh
  // token look broken until the prompt was noticed and accepted.
  const needsGhCliConsent =
    state.primary === "gh-cli" &&
    (state.sources.ghCli.method ?? "host-cli") === "host-cli" &&
    !ghCliConsent;

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
      {/* No primary action here (the tabs below are the action), so the shared ⋮
          help menu sits alone at the title's trailing edge — level with the
          heading, matching the Projects / Apps headers. */}
      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-medium text-foreground/80" style={{ letterSpacing: "-0.2px" }}>
            {t.library.page.title}
          </h1>
          <p className="text-sm text-muted-foreground/70 mt-1">{t.library.page.subtitle}</p>
        </div>
        <HelpMenu className="shrink-0" />
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
            // Clean centered empty state, matching the GitHub tab's ConnectPrompt
            // (bg-card + illustration-style icon + heading/desc + primary button).
            <div className="bg-card rounded-2xl border border-border/50">
              <div className="px-6 py-12 text-center">
                <div className="mx-auto mb-5 flex size-14 items-center justify-center rounded-2xl bg-info/10 ring-4 ring-info/5">
                  <Boxes className="size-6 text-info" />
                </div>
                <h3 className="mb-1.5 text-lg font-medium text-foreground/85">
                  {t.migration.entry.cardTitle}
                </h3>
                <p className="mx-auto mb-7 max-w-md text-sm leading-relaxed text-muted-foreground">
                  {t.migration.entry.cardDesc}
                </p>
                <button
                  type="button"
                  onClick={() => setShowMigrate(true)}
                  className="inline-flex items-center gap-2 rounded-xl bg-primary px-6 py-3 text-sm font-medium text-primary-foreground transition-all hover:-translate-y-0.5 hover:bg-primary/90 hover:shadow-lg hover:shadow-primary/25"
                >
                  <Boxes className="size-4" />
                  {t.migration.entry.action}
                </button>
              </div>
            </div>
          ) : activeTab === "folder" ? (
            // Desktop reads the folder off disk (native picker, no upload/
            // stack). SaaS AND remote self-hosted browsers upload it instead
            // (they can't see the user's filesystem).
            isDesktop ? (
              <LocalProjects />
            ) : (
              <FolderUpload />
            )
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
            />
          ) : needsGhCliConsent ? (
            <GhCliConsent login={state.sources.ghCli.login} onAllow={allowGhCli} />
          ) : (
            <RepositoryList
              repos={libRepos.repos}
              accounts={accounts}
              selectedOwner={selectedOwner}
              setSelectedOwner={setSelectedOwner}
              loading={loading}
              loadingRepos={libRepos.loading}
              installUrl={installUrl}
              server={{
                search: libRepos.search,
                onSearch: libRepos.setSearch,
                visibility: libRepos.visibility,
                onVisibility: libRepos.setVisibility,
                sort: libRepos.sort,
                onSort: libRepos.setSort,
                page: libRepos.meta.page,
                totalPages: libRepos.meta.totalPages,
                onPage: libRepos.setPage,
                count: libRepos.meta.count,
              }}
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
            repos={libRepos.repos}
            selfHosted={selfHosted}
            state={state}
            cloudConnected={cloudConnected}
            counts={{
              total: libRepos.meta.total,
              publicCount: libRepos.meta.publicCount,
              privateCount: libRepos.meta.privateCount,
            }}
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
