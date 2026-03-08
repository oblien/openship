"use client";

import React, { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  Github,
  Search,
  Lock,
  Globe,
  Star,
  GitFork,
  ArrowRight,
  Plus,
  Loader2,
  ChevronDown,
  Filter,
  FolderUp,
  Link2,
  Clock,
} from "lucide-react";
import { useGitHub } from "@/context/GitHubContext";
import { encodeRepoSlug } from "@/utils/repoSlug";
import type { VisibilityFilter, SortBy } from "./types";

/* ── Helpers ─────────────────────────────────────────────────────── */

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

const LANG_COLORS: Record<string, string> = {
  TypeScript: "#3178c6",
  JavaScript: "#f1e05a",
  Python: "#3572A5",
  Rust: "#dea584",
  Go: "#00ADD8",
  Java: "#b07219",
  Ruby: "#701516",
  PHP: "#4F5D95",
  CSS: "#563d7c",
  HTML: "#e34c26",
  Vue: "#41b883",
  Svelte: "#ff3e00",
  Swift: "#F05138",
  Kotlin: "#A97BFF",
  C: "#555555",
  "C++": "#f34b7d",
  "C#": "#178600",
  Shell: "#89e051",
  Dart: "#00B4AB",
};

/* ── Page ─────────────────────────────────────────────────────────── */

export default function LibraryPage() {
  const router = useRouter();
  const {
    connected,
    connecting,
    loading,
    connect,
    accounts,
    selectedOwner,
    setSelectedOwner,
    repos,
    loadingRepos,
  } = useGitHub();

  const [search, setSearch] = useState("");
  const [visibility, setVisibility] = useState<VisibilityFilter>("all");
  const [sortBy, setSortBy] = useState<SortBy>("updated");

  /* ── Filter + sort ──────────────────────────────────────────── */
  const filtered = useMemo(() => {
    if (!Array.isArray(repos)) return [];
    let list = repos;

    if (search) {
      const q = search.toLowerCase();
      list = list.filter(
        (r) =>
          r.name?.toLowerCase().includes(q) ||
          r.description?.toLowerCase().includes(q)
      );
    }
    if (visibility === "public") list = list.filter((r) => !r.private);
    if (visibility === "private") list = list.filter((r) => r.private);

    list = [...list].sort((a, b) => {
      if (sortBy === "name") return a.name.localeCompare(b.name);
      if (sortBy === "stars")
        return (b.stars ?? b.stargazers_count ?? 0) - (a.stars ?? a.stargazers_count ?? 0);
      return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    });

    return list;
  }, [repos, search, visibility, sortBy]);

  const handleDeploy = (ownerLogin: string, repoName: string) => {
    const slug = encodeRepoSlug(ownerLogin, repoName);
    router.push(`/deploy/${slug}`);
  };

  const getOwnerLogin = (owner: { login: string } | string): string =>
    typeof owner === "string" ? owner : owner.login;

  /* ── Render ─────────────────────────────────────────────────── */
  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-[1400px] mx-auto px-6 lg:px-10 py-8">
        {/* ── Header ───────────────────────────────────────────── */}
        <div className="mb-8">
          <h1
            className="text-2xl font-semibold text-foreground"
            style={{ letterSpacing: "-0.3px" }}
          >
            Library
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Your repositories and code sources — ready to deploy
          </p>
        </div>

        {/* ── Layout: main + sidebar ───────────────────────────── */}
        <div className="flex gap-8 items-start">
          {/* ── Left: main content ─────────────────────────────── */}
          <div className="flex-1 min-w-0">
            {loading ? (
              <LoadingSkeleton />
            ) : !connected ? (
              <ConnectPrompt connecting={connecting} onConnect={connect} />
            ) : (
              <>
                {/* Owner pills + filters */}
                <div className="flex flex-col sm:flex-row gap-3 mb-6">
                  {/* Owner selector */}
                  {accounts.length > 1 && (
                    <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
                      {accounts.map((acc) => (
                        <button
                          key={acc.login}
                          onClick={() => setSelectedOwner(acc.login)}
                          className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-all whitespace-nowrap ${
                            selectedOwner === acc.login
                              ? "bg-foreground text-background"
                              : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                          }`}
                        >
                          <img
                            src={acc.avatar_url}
                            alt=""
                            className="w-5 h-5 rounded-full"
                          />
                          {acc.login}
                        </button>
                      ))}
                    </div>
                  )}

                  <div className="flex-1" />

                  {/* Search + filters */}
                  <div className="flex items-center gap-2">
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
                      <input
                        type="text"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search repos…"
                        className="pl-9 pr-4 py-2 w-56 bg-card border border-border/50 rounded-xl text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
                      />
                    </div>

                    {/* Visibility pills */}
                    <div className="hidden sm:flex items-center bg-card border border-border/50 rounded-xl p-0.5">
                      {(["all", "public", "private"] as VisibilityFilter[]).map(
                        (v) => (
                          <button
                            key={v}
                            onClick={() => setVisibility(v)}
                            className={`px-3 py-1.5 rounded-lg text-xs font-medium capitalize transition-all ${
                              visibility === v
                                ? "bg-foreground text-background"
                                : "text-muted-foreground hover:text-foreground"
                            }`}
                          >
                            {v}
                          </button>
                        )
                      )}
                    </div>

                    {/* Sort */}
                    <div className="relative">
                      <select
                        value={sortBy}
                        onChange={(e) => setSortBy(e.target.value as SortBy)}
                        className="appearance-none pl-3 pr-7 py-2 bg-card border border-border/50 rounded-xl text-xs font-medium text-foreground cursor-pointer hover:bg-muted/50 focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
                      >
                        <option value="updated">Recent</option>
                        <option value="name">Name</option>
                        <option value="stars">Stars</option>
                      </select>
                      <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 size-3 text-muted-foreground pointer-events-none" />
                    </div>
                  </div>
                </div>

                {/* Repo list */}
                {loadingRepos ? (
                  <RepoSkeleton />
                ) : filtered.length === 0 ? (
                  <div className="bg-card rounded-2xl border border-border/50 p-12 text-center">
                    <Search className="size-8 text-muted-foreground/30 mx-auto mb-3" />
                    <p className="text-sm font-medium text-foreground mb-1">
                      {search ? "No matching repositories" : "No repositories found"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {search
                        ? `Try a different search term`
                        : "This account doesn't have any repositories yet"}
                    </p>
                  </div>
                ) : (
                  <div className="bg-card rounded-2xl border border-border/50 divide-y divide-border/40">
                    {filtered.map((repo) => {
                      const ownerLogin = getOwnerLogin(repo.owner);
                      const stars = repo.stars ?? repo.stargazers_count ?? 0;
                      const forks = repo.forks ?? repo.forks_count ?? 0;
                      return (
                        <div
                          key={repo.id}
                          className="flex items-center gap-4 px-5 py-3.5 hover:bg-muted/30 transition-colors group"
                        >
                          {/* Icon */}
                          <div className="w-9 h-9 rounded-xl bg-muted/60 flex items-center justify-center shrink-0">
                            {repo.private ? (
                              <Lock className="size-4 text-muted-foreground" />
                            ) : (
                              <Globe className="size-4 text-muted-foreground" />
                            )}
                          </div>

                          {/* Info */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="text-sm font-medium text-foreground truncate">
                                {repo.name}
                              </p>
                              {repo.private && (
                                <span className="px-1.5 py-0.5 rounded-md bg-muted text-[10px] font-medium text-muted-foreground">
                                  Private
                                </span>
                              )}
                            </div>
                            {repo.description && (
                              <p className="text-xs text-muted-foreground truncate mt-0.5 max-w-lg">
                                {repo.description}
                              </p>
                            )}
                            <div className="flex items-center gap-3 mt-1.5">
                              {repo.language && (
                                <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                                  <span
                                    className="w-2.5 h-2.5 rounded-full"
                                    style={{
                                      backgroundColor:
                                        LANG_COLORS[repo.language] ?? "#888",
                                    }}
                                  />
                                  {repo.language}
                                </span>
                              )}
                              {stars > 0 && (
                                <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                                  <Star className="size-3" />
                                  {stars}
                                </span>
                              )}
                              {forks > 0 && (
                                <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                                  <GitFork className="size-3" />
                                  {forks}
                                </span>
                              )}
                              <span className="flex items-center gap-1 text-[11px] text-muted-foreground/60">
                                <Clock className="size-3" />
                                {timeAgo(repo.updated_at)}
                              </span>
                            </div>
                          </div>

                          {/* Deploy button */}
                          <button
                            onClick={() =>
                              handleDeploy(ownerLogin, repo.name)
                            }
                            className="shrink-0 inline-flex items-center gap-1.5 px-4 py-2 bg-foreground text-background text-xs font-medium rounded-xl opacity-0 group-hover:opacity-100 transition-all hover:opacity-90"
                          >
                            Deploy
                            <ArrowRight className="size-3" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}

                <p className="text-xs text-muted-foreground/50 mt-4 text-center">
                  {filtered.length} repositor{filtered.length === 1 ? "y" : "ies"}
                  {search && ` matching "${search}"`}
                </p>
              </>
            )}
          </div>

          {/* ── Right sidebar ──────────────────────────────────── */}
          <div className="hidden lg:block w-[320px] xl:w-[350px] shrink-0 sticky top-8 space-y-4">
            {/* Quick actions */}
            <div className="rounded-2xl border border-border/50 bg-card p-5">
              <h3 className="text-[13px] font-semibold text-foreground mb-4">
                Quick Actions
              </h3>
              <div className="space-y-2">
                <button
                  onClick={() => router.push("/new")}
                  className="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium text-foreground bg-foreground/[0.04] hover:bg-foreground/[0.08] transition-colors"
                >
                  <Plus className="size-4 text-muted-foreground" />
                  New Project
                </button>
                <button
                  onClick={() => router.push("/new")}
                  className="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-foreground/[0.04] transition-colors"
                >
                  <FolderUp className="size-4" />
                  Upload Code
                </button>
                <button
                  onClick={() => router.push("/new")}
                  className="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-foreground/[0.04] transition-colors"
                >
                  <Link2 className="size-4" />
                  Import from URL
                </button>
              </div>
            </div>

            {/* Connection status */}
            <div className="rounded-2xl border border-border/50 bg-card p-5">
              <h3 className="text-[13px] font-semibold text-foreground mb-3">
                Connections
              </h3>
              <div className="flex items-center gap-3">
                <div
                  className={`w-9 h-9 rounded-xl flex items-center justify-center ${
                    connected ? "bg-emerald-500/10" : "bg-muted/60"
                  }`}
                >
                  <Github
                    className={`size-4 ${
                      connected
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-muted-foreground"
                    }`}
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-medium text-foreground">
                    GitHub
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {connected ? `Connected as ${selectedOwner}` : "Not connected"}
                  </p>
                </div>
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${
                    connected ? "bg-emerald-500" : "bg-muted-foreground/30"
                  }`}
                />
              </div>
            </div>

            {/* Stats (when connected) */}
            {connected && repos.length > 0 && (
              <div className="rounded-2xl border border-dashed border-border/50 bg-muted/20 p-5">
                <div className="grid grid-cols-3 gap-4 text-center">
                  <div>
                    <p className="text-lg font-semibold text-foreground">
                      {repos.length}
                    </p>
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
                      Repos
                    </p>
                  </div>
                  <div>
                    <p className="text-lg font-semibold text-foreground">
                      {repos.filter((r) => !r.private).length}
                    </p>
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
                      Public
                    </p>
                  </div>
                  <div>
                    <p className="text-lg font-semibold text-foreground">
                      {repos.filter((r) => r.private).length}
                    </p>
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
                      Private
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Connect GitHub prompt ────────────────────────────────────────── */

function ConnectPrompt({
  connecting,
  onConnect,
}: {
  connecting: boolean;
  onConnect: () => void;
}) {
  return (
    <div className="bg-card rounded-2xl border border-border/50 p-10 text-center">
      <div className="w-16 h-16 rounded-2xl bg-foreground/[0.05] flex items-center justify-center mx-auto mb-5">
        <Github className="size-8 text-foreground" />
      </div>
      <h2 className="text-xl font-semibold text-foreground mb-2">
        Connect GitHub
      </h2>
      <p className="text-sm text-muted-foreground max-w-md mx-auto mb-8 leading-relaxed">
        Link your GitHub account to browse repositories, deploy with one click,
        and get automatic deployments on every push.
      </p>
      <button
        onClick={onConnect}
        disabled={connecting}
        className="inline-flex items-center gap-2.5 px-8 py-3.5 bg-foreground text-background text-sm font-medium rounded-xl hover:opacity-90 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {connecting ? (
          <>
            <Loader2 className="size-4 animate-spin" />
            Connecting…
          </>
        ) : (
          <>
            <Github className="size-4" />
            Connect GitHub
          </>
        )}
      </button>
      <p className="text-xs text-muted-foreground/50 mt-4">
        We request read access to your repositories. You can revoke anytime.
      </p>
    </div>
  );
}

/* ── Loading skeleton ─────────────────────────────────────────────── */

function LoadingSkeleton() {
  return (
    <div className="space-y-4">
      {/* Filter bar skeleton */}
      <div className="flex items-center gap-3">
        <div className="h-9 w-56 bg-muted rounded-xl animate-pulse" />
        <div className="flex-1" />
        <div className="h-9 w-24 bg-muted rounded-xl animate-pulse" />
        <div className="h-9 w-20 bg-muted rounded-xl animate-pulse" />
      </div>
      {/* Repo list skeleton */}
      <div className="bg-card rounded-2xl border border-border/50 divide-y divide-border/40">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="flex items-center gap-4 px-5 py-4 animate-pulse">
            <div className="w-9 h-9 bg-muted rounded-xl" />
            <div className="flex-1 space-y-2">
              <div className="h-4 w-40 bg-muted rounded" />
              <div className="h-3 w-64 bg-muted rounded" />
              <div className="flex gap-3">
                <div className="h-3 w-16 bg-muted rounded" />
                <div className="h-3 w-12 bg-muted rounded" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function RepoSkeleton() {
  return (
    <div className="bg-card rounded-2xl border border-border/50 divide-y divide-border/40">
      {[...Array(5)].map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-5 py-4 animate-pulse">
          <div className="w-9 h-9 bg-muted rounded-xl" />
          <div className="flex-1 space-y-2">
            <div className="h-4 w-36 bg-muted rounded" />
            <div className="h-3 w-52 bg-muted rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}
