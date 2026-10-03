"use client";

import { Icon as UiIcon, type IconName } from "@repo/ui/icons";

import React, { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { useGitHub } from "@/context/GitHubContext";
import { usePlatform } from "@/context/PlatformContext";
import { useCloud } from "@/context/CloudContext";
import { ConnectPrompt } from "./components/ConnectPrompt";
import { LoadingSkeleton } from "./components/LoadingSkeleton";
import { RepositoryList } from "./components/RepositoryList";
import { useLibraryRepos } from "./useLibraryRepos";
import { GhCliConsent } from "./components/GhCliConsent";
import { LocalProjects } from "./components/LocalProjects";
import { FolderUpload } from "./components/FolderUpload";
import { LibrarySidebar } from "./components/LibrarySidebar";
import { UrlImport } from "./components/UrlImport";
import { RepositoryAccounts } from "./components/RepositoryAccounts";
import { PageContainer } from "@/components/ui/PageContainer";
import { HelpMenu } from "@/components/HelpMenu";
import { ServerMigrationWizard } from "@/components/migration/ServerMigrationWizard";
import { useI18n } from "@/components/i18n-provider";
import { AppCatalog } from "@/components/apps/AppCatalog";

type Tab = "folder" | "repositories" | "url" | "server" | "apps";

/** One-time gh-CLI repo-read consent flag (per browser — desktop is single-user). */
const GH_CLI_CONSENT_KEY = "openship.gh-cli-consent";

interface TabItem {
  key: Tab;
  label: string;
  icon: IconName;
}

export default function LibraryPage() {
  const { t } = useI18n();
  const router = useRouter();
  const {
    state,
    connected,
    connecting,
    loading,
    capabilities,
    connect,
    cliAction,
    accounts,
    selectedOwner,
    setSelectedOwner,
    refresh,
    installUrl,
  } = useGitHub();
  // Server-paginated repo list for the Library (own hook so the shared
  // GitHubContext.repos — used by the GitSettings + migration pickers — stays a
  // full-set, client-side list). Fetches a page at a time + authoritative counts.
  const libRepos = useLibraryRepos(selectedOwner, connected);
  const { selfHosted, deployMode } = usePlatform();
  // Only the desktop app can read the user's folder off disk (native picker +
  // co-located API). A remote self-hosted browser can't — it uploads like SaaS.
  const isDesktop = deployMode === "desktop";
  const { connected: cloudConnected } = useCloud();

  // Cloud has a dedicated URL tab. Self-hosted instances keep its shortcut in
  // the account row; both use the same selection and public import flow.
  const [activeTab, setActiveTab] = useState<Tab>("repositories");
  const appsTabRef = useRef<HTMLButtonElement>(null);
  const importingUrl = activeTab === "url";
  const [showMigrate, setShowMigrate] = useState(false);

  const importUrl = () => setActiveTab("url");
  const selectOwner = (login: string) => {
    setActiveTab("repositories");
    if (login) setSelectedOwner(login);
  };
  const addAccount = () => {
    setActiveTab("repositories");
    const app = capabilities?.methods.find((method) => method.kind === "app");
    const available = app
      ? app.available && (!app.requiresCloud || cloudConnected)
      : !selfHosted || !!installUrl;
    if (available) void connect("oauth");
    else router.push("/settings?tab=git");
  };
  const sourceHeader = (
    <div className="px-5 pt-4">
      <RepositoryAccounts
        accounts={accounts}
        selectedOwner={selectedOwner}
        onSelectOwner={selectOwner}
        onAddAccount={addAccount}
        addingAccount={loading || connecting}
        onImportUrl={selfHosted ? importUrl : undefined}
        importingUrl={importingUrl}
      />
    </div>
  );

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

  // Cloud's Templates entry starts with a framework, then uploads the source.
  // Desktop can read a folder directly; remote self-hosted browsers upload it.
  const tabs: TabItem[] = [
    { key: "apps", label: t.dashboard.pages.apps.title, icon: "grid" },
    { key: "repositories", label: t.library.page.tabs.github, icon: "github" },
    ...(!selfHosted
      ? [{ key: "url" as const, label: t.library.page.tabs.gitUrl, icon: "link" as const }]
      : []),
    {
      key: "folder",
      label: selfHosted ? t.library.page.tabs.folder : t.library.page.tabs.templates,
      icon: selfHosted ? "folder-out" : "layers",
    },
    { key: "server", label: t.migration.entry.tab, icon: "migration" },
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
      <div className="flex flex-wrap items-center gap-1 mb-6">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const selected =
            activeTab === tab.key || (selfHosted && importingUrl && tab.key === "repositories");
          return (
            <button
              key={tab.key}
              ref={tab.key === "apps" ? appsTabRef : undefined}
              type="button"
              aria-pressed={selected}
              onClick={() => {
                setActiveTab(tab.key);
                if (tab.key === "server") setShowMigrate(true);
              }}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 ${
                selected
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
              }`}
            >
              <UiIcon name={Icon} className="size-4" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* ── Main Grid ──────────────────────────────────────────── */}
      <div className={activeTab === "server" ? "hidden" : "grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px] gap-6"}>
        {/* ── LEFT COLUMN ────────────────────────────────────────── */}
        <div className="space-y-6 min-w-0">
          {activeTab === "apps" ? (
            <AppCatalog embedded />
          ) : activeTab === "folder" ? (
            // Desktop reads the folder off disk (native picker, no upload/
            // stack). SaaS AND remote self-hosted browsers upload it instead
            // (they can't see the user's filesystem).
            isDesktop ? (
              <LocalProjects />
            ) : (
              <FolderUpload />
            )
          ) : importingUrl ? (
            <UrlImport header={selfHosted ? sourceHeader : undefined} />
          ) : loading ? (
            <LoadingSkeleton header={sourceHeader} />
          ) : !connected ? (
            <ConnectPrompt
              header={sourceHeader}
              connecting={connecting}
              onConnect={connect}
              cliAction={cliAction}
              onRefresh={refresh}
              onBrowseApps={() => {
                setActiveTab("apps");
                appsTabRef.current?.focus();
              }}
              selfHosted={selfHosted}
            />
          ) : needsGhCliConsent ? (
            <GhCliConsent header={sourceHeader} login={state.sources.ghCli.login} onAllow={allowGhCli} />
          ) : (
            <RepositoryList
              repos={libRepos.repos}
              accounts={accounts}
              selectedOwner={selectedOwner}
              setSelectedOwner={selectOwner}
              loading={loading}
              loadingRepos={libRepos.loading}
              installUrl={installUrl}
              onInstall={addAccount}
              installing={connecting}
              onImportUrl={selfHosted ? importUrl : undefined}
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
      </div>

      {showMigrate && (
        <div className={activeTab === "server" ? undefined : "hidden"}>
          <ServerMigrationWizard
            variant="tab"
            onClose={() => {
              setShowMigrate(false);
              setActiveTab("repositories");
            }}
          />
        </div>
      )}
    </PageContainer>
  );
}
