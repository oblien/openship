"use client";

import { Icon as UiIcon, type IconName } from "@repo/ui/icons";

import React, { useState, useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { migrationHref, parseMigrationSource, type MigrationSourceKind } from "@repo/core";
import { LibrarySidebar } from "./components/LibrarySidebar";
import { useGit } from "@/context/GitContext";
import { usePlatform } from "@/context/PlatformContext";
import { LoadingSkeleton } from "./components/LoadingSkeleton";
import { RepositoryList } from "./components/RepositoryList";
import { useLibraryRepos } from "./useLibraryRepos";
import { LocalProjects } from "./components/LocalProjects";
import { FolderUpload } from "./components/FolderUpload";
import { UrlImport } from "./components/UrlImport";
import { RepositoryAccounts } from "./components/RepositoryAccounts";
import { PageContainer } from "@/components/ui/PageContainer";
import { HelpMenu } from "@/components/HelpMenu";
import { MigrationWizard } from "@/components/migration/MigrationWizard";
import { useI18n } from "@/components/i18n-provider";
import { AppCatalog } from "@/components/apps/AppCatalog";

type Tab = "folder" | "repositories" | "url" | "server" | "apps";

/** One-time gh-CLI repo-read consent flag (per browser — desktop is single-user). */

interface TabItem {
  key: Tab;
  label: string;
  icon: IconName;
}

export function LibraryContent() {
  const { t } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const migrating = pathname === migrationHref();
  const requestedSource = parseMigrationSource(searchParams.get("from"));
  const connection = useGit();
  const { connected, connecting, loading, accounts, selectedOwner, setSelectedOwner, installUrl } = connection;
  const provider = connection.definition.id;
  const libRepos = useLibraryRepos(selectedOwner, connected, provider, connection.catalog);
  const { selfHosted, deployMode } = usePlatform();
  // Only the desktop app can read the user's folder off disk (native picker +
  // co-located API). A remote self-hosted browser uploads it instead.
  const isDesktop = deployMode === "desktop";

  // Cloud has a dedicated URL tab. Self-hosted instances keep its shortcut in
  // the account row; both use the same selection and public import flow.
  const [selectedTab, setActiveTab] = useState<Tab>("repositories");
  const activeTab = migrating ? "server" : selectedTab;
  const appsTabRef = useRef<HTMLButtonElement>(null);
  const importingUrl = activeTab === "url";
  const [showMigrate, setShowMigrate] = useState(migrating);
  const [migrationSource, setMigrationSource] = useState<MigrationSourceKind | null>(
    requestedSource,
  );
  // The shared layout keeps an import draft/progress mounted while browsing
  // other Library tabs. Browser navigation still selects the source from its URL.
  useEffect(() => {
    if (!migrating) return;
    setShowMigrate(true);
    setMigrationSource(requestedSource);
  }, [migrating, requestedSource]);

  const importUrl = () => setActiveTab("url");
  const selectOwner = (login: string) => {
    setActiveTab("repositories");
    if (login) setSelectedOwner(login);
  };
  const addAccount = () => {
    setActiveTab("repositories");
    connection.connectMore();
  };
  const sourceHeader = (
    <div className="px-5 pt-4">
      <RepositoryAccounts
        provider={provider}
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

  // Folder import is available on self-hosted instances. Cloud offers a Git URL tab.
  const tabs: TabItem[] = [
    { key: "apps", label: t.dashboard.pages.apps.title, icon: "grid" },
    { key: "repositories", label: connection.connections.length > 1 ? t.library.page.tabs.repositories : connection.definition.name, icon: connection.connections.length > 1 ? "git-branch" : connection.icon },
    ...(selfHosted
      ? [{ key: "folder" as const, label: t.library.page.tabs.folder, icon: "folder-out" as const }]
      : [{ key: "url" as const, label: t.library.page.tabs.gitUrl, icon: "link" as const }]),
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
          <h1
            className="text-2xl font-medium text-foreground/80"
            style={{ letterSpacing: "-0.2px" }}
          >
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
                if (tab.key === "server") {
                  if (!migrating) router.push(migrationHref(migrationSource), { scroll: false });
                } else {
                  setActiveTab(tab.key);
                  if (migrating) router.push("/library", { scroll: false });
                }
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
      <div
        className={
          activeTab === "server"
            ? "hidden"
            : "grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px] gap-6"
        }
      >
        {/* ── RIGHT COLUMN ───────────────────────────────────────── */}
        <LibrarySidebar
          connection={connection}
          counts={libRepos.meta}
          showProviderSelect={activeTab === "repositories" || activeTab === "apps"}
        />

        {/* ── LEFT COLUMN ────────────────────────────────────────── */}
        <div className="space-y-6 min-w-0">
          {activeTab === "apps" ? (
            <AppCatalog embedded />
          ) : selfHosted && activeTab === "folder" ? (
            // Desktop reads the folder off disk; remote self-hosted browsers upload it.
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
            connection.renderConnect({
              header: sourceHeader,
              onBrowseApps: () => { setActiveTab("apps"); appsTabRef.current?.focus(); },
            })
          ) : connection.consentRequired ? (
            connection.renderConsent(sourceHeader)
          ) : (
            <RepositoryList
              provider={provider}
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
      </div>

      {(migrating || showMigrate) && (
        <div className={activeTab === "server" ? undefined : "hidden"}>
          <MigrationWizard
            variant="tab"
            source={migrating ? requestedSource : migrationSource}
            onSourceChange={(source) => router.push(migrationHref(source), { scroll: false })}
            onClose={() => {
              setShowMigrate(false);
              setMigrationSource(null);
              setActiveTab("repositories");
              router.push("/library", { scroll: false });
            }}
          />
        </div>
      )}
    </PageContainer>
  );
}
