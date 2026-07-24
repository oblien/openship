"use client";

import React, { useState, useEffect, useCallback } from "react";
import { FolderUp, Github, Link2, Sparkles, Boxes } from "lucide-react";
import { useGitHub } from "@/context/GitHubContext";
import { usePlatform } from "@/context/PlatformContext";
import { useCloud } from "@/context/CloudContext";
import { ConnectPrompt } from "./components/ConnectPrompt";
import { LoadingSkeleton } from "./components/LoadingSkeleton";
import { RepositoryList } from "./components/RepositoryList";
import { GhCliConsent } from "./components/GhCliConsent";
import { LocalProjects } from "./components/LocalProjects";
import { FolderUpload } from "./components/FolderUpload";
import { LibrarySidebar } from "./components/LibrarySidebar";
import { UrlImport } from "./components/UrlImport";
import { TemplateGrid } from "./components/TemplateGrid";
import { PageContainer } from "@/components/ui/PageContainer";
import { ServerMigrationWizard } from "@/components/migration/ServerMigrationWizard";
import { useI18n } from "@/components/i18n-provider";
import { useToast } from "@/context/ToastContext";

type Tab = "folder" | "repositories" | "url" | "template" | "server";

/** One-time gh-CLI repo-read consent flag (per browser — desktop is single-user). */
const GH_CLI_CONSENT_KEY = "openship.gh-cli-consent";

interface TabItem {
  key: Tab;
  label: string;
  icon: React.ElementType;
}

export default function LibraryPage() {
  const { t } = useI18n();
  const { showToast } = useToast();
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
  // Gate only the gh-CLI source; the Openship App (OAuth) is already an explicit
  // connection and needs no extra prompt.
  const needsGhCliConsent = state.primary === "gh-cli" && !ghCliConsent;

  // One "Folder" tab, environment-dependent behavior:
  //   - self-hosted / desktop → deploy straight from a path on the box (native
  //     picker, no upload, no stack pick — the local pipeline reads it).
  //   - SaaS → upload the folder to a cloud build workspace (stack picked up
  //     front so we know which image to provision).
  const tabs: TabItem[] = [
    { key: "folder", label: t.library.page.tabs.folder, icon: FolderUp },
    { key: "repositories", label: t.library.page.tabs.github, icon: Github },
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
        <p className="text-sm text-muted-foreground/70 mt-1">{t.library.page.subtitle}</p>
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
          ) : needsGhCliConsent ? (
            <GhCliConsent login={state.sources.ghCli.login} onAllow={allowGhCli} />
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
        <LibrarySidebar
          selectedOwner={selectedOwner}
          repos={repos}
          selfHosted={selfHosted}
          state={state}
          cloudConnected={cloudConnected}
        />
      </div>

      <ServerMigrationWizard isOpen={showMigrate} onClose={() => setShowMigrate(false)} />
    </PageContainer>
  );
}
