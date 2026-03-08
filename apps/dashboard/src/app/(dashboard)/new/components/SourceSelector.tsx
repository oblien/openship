"use client";

import React, { useState, useEffect, useRef, useMemo } from "react";
import {
  Github,
  Upload,
  Link2,
  Sparkles,
  Search,
  ArrowRight,
  Lock,
  Globe,
  Star,
  GitFork,
  Loader2,
  FolderUp,
  ChevronDown,
} from "lucide-react";
import { githubApi } from "@/lib/api";
import { initAuthWindow } from "@/utils/github";
import type { ProjectSource, GitHubSource, UrlSource, UploadSource, TemplateSource } from "../types";
import { frameworks, getFrameworkConfig } from "@/components/import-project/Frameworks";

/* ── GitHub types (reused from library) ──────────────────────────── */

interface Account {
  login: string;
  avatar_url: string;
  type: string;
}

interface Repository {
  id: number;
  full_name: string;
  name: string;
  description: string;
  private: boolean;
  stargazers_count: number;
  forks_count: number;
  language: string;
  updated_at: string;
  default_branch: string;
  owner: { login: string; avatar_url: string };
  html_url: string;
}

/* ── Tab picker ──────────────────────────────────────────────────── */

type SourceTab = "github" | "upload" | "url" | "template";

interface SourceTabItem {
  id: SourceTab;
  label: string;
  icon: React.ElementType;
  description: string;
}

const SOURCE_TABS: SourceTabItem[] = [
  { id: "github", label: "GitHub", icon: Github, description: "Import a repository" },
  { id: "upload", label: "Upload", icon: FolderUp, description: "Upload your code" },
  { id: "url", label: "Git URL", icon: Link2, description: "Clone from URL" },
  { id: "template", label: "Template", icon: Sparkles, description: "Start fresh" },
];

/* ── Main component ──────────────────────────────────────────────── */

interface SourceSelectorProps {
  onSelect: (source: ProjectSource) => void;
}

export default function SourceSelector({ onSelect }: SourceSelectorProps) {
  const [activeTab, setActiveTab] = useState<SourceTab>("github");

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-xl font-semibold text-foreground" style={{ letterSpacing: "-0.3px" }}>
          Import Project
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          Choose where your code lives to get started
        </p>
      </div>

      {/* Source tabs */}
      <div className="flex gap-2">
        {SOURCE_TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all ${
                isActive
                  ? "bg-foreground text-background shadow-sm"
                  : "bg-card border border-border/50 text-muted-foreground hover:text-foreground hover:border-border"
              }`}
            >
              <Icon className="size-4" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <div className="bg-card rounded-2xl border border-border/50">
        {activeTab === "github" && <GitHubPanel onSelect={onSelect} />}
        {activeTab === "upload" && <UploadPanel onSelect={onSelect} />}
        {activeTab === "url" && <UrlPanel onSelect={onSelect} />}
        {activeTab === "template" && <TemplatePanel onSelect={onSelect} />}
      </div>
    </div>
  );
}

/* ── GitHub Panel ────────────────────────────────────────────────── */

function GitHubPanel({ onSelect }: { onSelect: (source: GitHubSource) => void }) {
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [connectLoading, setConnectLoading] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [repos, setRepos] = useState<Repository[]>([]);
  const [selectedOwner, setSelectedOwner] = useState("");
  const [search, setSearch] = useState("");
  const [loadingRepos, setLoadingRepos] = useState(false);
  const initRef = useRef(false);

  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    (async () => {
      try {
        const res = await githubApi.getUserHome();
        if (res?.status?.connected && res.accounts?.length > 0) {
          setConnected(true);
          setAccounts(res.accounts);
          setSelectedOwner(res.status.login);
          setRepos(res.repos ?? []);
        }
      } catch { /* silent */ }
      setLoading(false);
    })();
  }, []);

  /* Switch owner → load repos */
  useEffect(() => {
    if (!selectedOwner || !connected) return;
    (async () => {
      setLoadingRepos(true);
      try {
        const isOrg = accounts.find((a) => a.login === selectedOwner)?.type === "Organization";
        const res = isOrg
          ? await githubApi.getOrgRepos(selectedOwner)
          : await githubApi.getUserRepos(selectedOwner);
        setRepos(res?.repos ?? []);
      } catch { /* silent */ }
      setLoadingRepos(false);
    })();
  }, [selectedOwner, connected, accounts]);

  const filtered = useMemo(() => {
    if (!search) return repos;
    const q = search.toLowerCase();
    return repos.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.description?.toLowerCase().includes(q)
    );
  }, [repos, search]);

  const handleConnect = async () => {
    setConnectLoading(true);
    try {
      const res = await githubApi.connect();
      if (res?.redirectUrl) {
        initAuthWindow(res.redirectUrl, () => {
          setConnectLoading(false);
          // Re-check connection
          initRef.current = false;
          (async () => {
            try {
              const home = await githubApi.getUserHome();
              if (home?.status?.connected && home.accounts?.length > 0) {
                setConnected(true);
                setAccounts(home.accounts);
                setSelectedOwner(home.status.login);
                setRepos(home.repos ?? []);
              }
            } catch { /* silent */ }
          })();
        });
      }
    } catch {
      setConnectLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="p-8">
        <div className="space-y-3">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="flex items-center gap-4 animate-pulse">
              <div className="w-10 h-10 bg-muted rounded-xl" />
              <div className="flex-1 space-y-2">
                <div className="h-4 w-40 bg-muted rounded" />
                <div className="h-3 w-64 bg-muted rounded" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  /* Not connected */
  if (!connected) {
    return (
      <div className="p-8 text-center">
        <div className="w-14 h-14 rounded-2xl bg-foreground/[0.06] flex items-center justify-center mx-auto mb-4">
          <Github className="size-7 text-foreground" />
        </div>
        <h3 className="text-lg font-semibold text-foreground mb-2">Connect GitHub</h3>
        <p className="text-sm text-muted-foreground max-w-sm mx-auto mb-6 leading-relaxed">
          Link your GitHub account to import repositories. Get automatic deployments on every push.
        </p>
        <button
          onClick={handleConnect}
          disabled={connectLoading}
          className="inline-flex items-center gap-2 px-6 py-3 bg-foreground text-background text-sm font-medium rounded-xl hover:opacity-90 transition-all disabled:opacity-50"
        >
          {connectLoading ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Github className="size-4" />
          )}
          {connectLoading ? "Connecting..." : "Connect GitHub"}
        </button>
      </div>
    );
  }

  /* Connected — show repo picker */
  return (
    <div>
      {/* Owner selector + search */}
      <div className="flex items-center gap-3 p-4 border-b border-border/50">
        <div className="relative">
          <select
            value={selectedOwner}
            onChange={(e) => setSelectedOwner(e.target.value)}
            className="appearance-none pl-3 pr-8 py-2 bg-muted/50 border border-border/50 rounded-xl text-sm font-medium text-foreground cursor-pointer hover:bg-muted transition-colors focus:outline-none focus:ring-2 focus:ring-primary/20"
          >
            {accounts.map((a) => (
              <option key={a.login} value={a.login}>
                {a.login}
              </option>
            ))}
          </select>
          <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
        </div>
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search repositories..."
            className="w-full pl-9 pr-4 py-2 bg-muted/50 border border-border/50 rounded-xl text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
          />
        </div>
      </div>

      {/* Repo list */}
      <div className="max-h-[400px] overflow-y-auto">
        {loadingRepos ? (
          <div className="p-6 space-y-3">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="flex items-center gap-4 animate-pulse">
                <div className="w-8 h-8 bg-muted rounded-lg" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-4 w-36 bg-muted rounded" />
                  <div className="h-3 w-56 bg-muted rounded" />
                </div>
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-8 text-center">
            <Search className="size-8 text-muted-foreground/40 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">
              {search ? `No repositories matching "${search}"` : "No repositories found"}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border/40">
            {filtered.map((repo) => (
              <button
                key={repo.id}
                onClick={() =>
                  onSelect({
                    kind: "github",
                    owner: repo.owner.login,
                    repo: repo.name,
                    branch: repo.default_branch,
                    branches: [repo.default_branch],
                    isPrivate: repo.private,
                  })
                }
                className="w-full flex items-center gap-4 px-5 py-3.5 hover:bg-muted/40 transition-colors text-left group"
              >
                <div className="w-9 h-9 rounded-xl bg-muted/60 flex items-center justify-center shrink-0">
                  {repo.private ? (
                    <Lock className="size-4 text-muted-foreground" />
                  ) : (
                    <Globe className="size-4 text-muted-foreground" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">
                    {repo.name}
                  </p>
                  {repo.description && (
                    <p className="text-xs text-muted-foreground truncate mt-0.5">
                      {repo.description}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  {repo.language && (
                    <span className="text-xs text-muted-foreground">{repo.language}</span>
                  )}
                  {repo.stargazers_count > 0 && (
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Star className="size-3" />
                      {repo.stargazers_count}
                    </span>
                  )}
                  <ArrowRight className="size-4 text-muted-foreground/40 group-hover:text-foreground transition-colors" />
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Upload Panel ────────────────────────────────────────────────── */

function UploadPanel({ onSelect }: { onSelect: (source: UploadSource) => void }) {
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFiles = (fileList: FileList) => {
    const files = Array.from(fileList);
    if (files.length === 0) return;

    // Try to derive a name from the first directory or file
    const firstPath = files[0]?.webkitRelativePath || files[0]?.name || "my-project";
    const rootName = firstPath.split("/")[0] || "my-project";

    onSelect({ kind: "upload", files, rootName });
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files);
    }
  };

  return (
    <div className="p-8">
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => fileRef.current?.click()}
        className={`border-2 border-dashed rounded-2xl p-12 text-center cursor-pointer transition-all ${
          dragging
            ? "border-primary bg-primary/5"
            : "border-border/60 hover:border-border hover:bg-muted/30"
        }`}
      >
        <input
          ref={fileRef}
          type="file"
          className="hidden"
          /* @ts-expect-error webkitdirectory is non-standard */
          webkitdirectory=""
          multiple
          onChange={(e) => e.target.files && handleFiles(e.target.files)}
        />
        <div className="w-14 h-14 rounded-2xl bg-foreground/[0.06] flex items-center justify-center mx-auto mb-4">
          <Upload className="size-7 text-muted-foreground" />
        </div>
        <h3 className="text-base font-semibold text-foreground mb-1.5">
          Drop your project folder here
        </h3>
        <p className="text-sm text-muted-foreground max-w-sm mx-auto leading-relaxed">
          Or click to browse. Select a project folder and we'll detect the framework automatically.
        </p>
        <p className="text-xs text-muted-foreground/60 mt-4">
          Supports any web framework — Next.js, Vite, Astro, Express, and more
        </p>
      </div>
    </div>
  );
}

/* ── URL Panel ───────────────────────────────────────────────────── */

function UrlPanel({ onSelect }: { onSelect: (source: UrlSource) => void }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    // Parse git URL to extract owner/repo
    const match = url.match(
      /(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/.]+)/
    );
    if (!match) {
      setError("Enter a valid GitHub repository URL");
      return;
    }

    const [, owner, repo] = match;
    onSelect({
      kind: "url",
      gitUrl: url.trim(),
      owner: owner!,
      repo: repo!,
      branch: "main",
    });
  };

  return (
    <div className="p-8">
      <div className="max-w-lg mx-auto">
        <div className="w-14 h-14 rounded-2xl bg-foreground/[0.06] flex items-center justify-center mx-auto mb-4">
          <Link2 className="size-7 text-muted-foreground" />
        </div>
        <h3 className="text-base font-semibold text-foreground text-center mb-1.5">
          Import from Git URL
        </h3>
        <p className="text-sm text-muted-foreground text-center mb-6 leading-relaxed">
          Paste a public repository URL to import. No GitHub connection required.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <input
              type="url"
              value={url}
              onChange={(e) => { setUrl(e.target.value); setError(""); }}
              placeholder="https://github.com/username/repository"
              className={`w-full px-4 py-3 bg-background border rounded-xl text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 transition-all ${
                error
                  ? "border-red-500/50 focus:ring-red-500/20"
                  : "border-border/50 focus:ring-primary/20"
              }`}
            />
            {error && (
              <p className="text-xs text-red-500 mt-1.5">{error}</p>
            )}
          </div>
          <button
            type="submit"
            disabled={!url.trim()}
            className="w-full inline-flex items-center justify-center gap-2 px-6 py-3 bg-foreground text-background text-sm font-medium rounded-xl hover:opacity-90 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Import Repository
            <ArrowRight className="size-4" />
          </button>
        </form>
      </div>
    </div>
  );
}

/* ── Template Panel ──────────────────────────────────────────────── */

function TemplatePanel({ onSelect }: { onSelect: (source: TemplateSource) => void }) {
  return (
    <div className="p-6">
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
        {frameworks
          .filter((fw) => fw.id !== "static")
          .map((fw) => (
            <button
              key={fw.id}
              onClick={() =>
                onSelect({
                  kind: "template",
                  templateId: fw.id,
                  templateName: fw.name,
                  framework: fw.id,
                })
              }
              className="flex flex-col items-center gap-3 p-5 rounded-xl border border-border/50 bg-background hover:bg-muted/40 hover:border-border transition-all group"
            >
              <div className="w-10 h-10 rounded-xl bg-muted/60 flex items-center justify-center group-hover:scale-105 transition-transform">
                {fw.icon("hsl(var(--foreground))")}
              </div>
              <span className="text-sm font-medium text-foreground">{fw.name}</span>
            </button>
          ))}
      </div>
    </div>
  );
}
