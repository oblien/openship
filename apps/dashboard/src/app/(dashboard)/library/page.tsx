"use client";

import React, { useEffect, useState } from "react";
import { FolderOpen, Github, Link2, Sparkles } from "lucide-react";
import { useGitHub } from "@/context/GitHubContext";
import { usePlatform } from "@/context/PlatformContext";
import { ConnectPrompt } from "./components/ConnectPrompt";
import { LoadingSkeleton } from "./components/LoadingSkeleton";
import { RepositoryList } from "./components/RepositoryList";
import { LocalProjects } from "./components/LocalProjects";
import { LibrarySidebar } from "./components/LibrarySidebar";
import { UrlImport } from "./components/UrlImport";
import { TemplateGrid } from "./components/TemplateGrid";

type Tab = "local" | "repositories" | "url" | "template";

interface TabItem {
  key: Tab;
  label: string;
  icon: React.ElementType;
}

export default function LibraryPage() {
  const {
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
  } = useGitHub();
  const { selfHosted } = usePlatform();

  const [activeTab, setActiveTab] = useState<Tab>(selfHosted ? "local" : "repositories");

  // Auto-select GitHub tab once connected; hide Local tab if not self-hosted
  useEffect(() => {
    if (!selfHosted && activeTab === "local") setActiveTab("repositories");
    if (connected && activeTab === "local") setActiveTab("repositories");
  }, [selfHosted, connected]);

  const tabs: TabItem[] = [
    ...(selfHosted ? [{ key: "local" as Tab, label: "Local", icon: FolderOpen }] : []),
    { key: "repositories", label: "GitHub", icon: Github },
    { key: "url", label: "Git URL", icon: Link2 },
    { key: "template", label: "Template", icon: Sparkles },
  ];

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 py-6">

        {/* ── Header ───────────────────────────────────────────── */}
        <div className="mb-6">
          <h1 className="text-2xl font-medium text-foreground/80" style={{ letterSpacing: "-0.2px" }}>
            New Project
          </h1>
          <p className="text-sm text-muted-foreground/70 mt-1">
            Import a repository, paste a URL, or start from a template
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
            {activeTab === "local" ? (
              <LocalProjects />
            ) : activeTab === "url" ? (
              <UrlImport />
            ) : activeTab === "template" ? (
              <TemplateGrid />
            ) : loading ? (
              <LoadingSkeleton />
            ) : !connected ? (
              <ConnectPrompt connecting={connecting} onConnect={connect} cliAction={cliAction} onRefresh={refresh} />
            ) : (
              <RepositoryList
                repos={repos}
                accounts={accounts}
                selectedOwner={selectedOwner}
                setSelectedOwner={setSelectedOwner}
                loading={loading}
                loadingRepos={loadingRepos}
              />
            )}
          </div>

          {/* ── RIGHT COLUMN ───────────────────────────────────────── */}
          <LibrarySidebar connected={connected} selectedOwner={selectedOwner} repos={repos} onSwitchTab={setActiveTab} />
        </div>
      </div>
    </div>
  );
}
