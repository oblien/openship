"use client";

import React, { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  Search,
  Lock,
  Globe,
  Star,
  GitFork,
  ArrowRight,
  ChevronDown,
} from "lucide-react";
import type { GitHubRepo } from "@/context/GitHubContext";
import { encodeRepoSlug } from "@/utils/repoSlug";
import type { VisibilityFilter, SortBy } from "../types";
import { LANG_COLORS } from "@/constants/lang-colors";

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

/* ── Component ────────────────────────────────────────────────────── */

interface Account {
  login: string;
  avatar_url: string;
}

interface RepositoryListProps {
  repos: GitHubRepo[];
  accounts: Account[];
  selectedOwner: string;
  setSelectedOwner: (login: string) => void;
  loading: boolean;
  loadingRepos: boolean;
  /** When provided, clicking a repo calls this instead of navigating to deploy */
  onSelect?: (owner: string, repo: GitHubRepo) => void;
}

export function RepositoryList({
  repos,
  accounts,
  selectedOwner,
  setSelectedOwner,
  loading,
  loadingRepos,
  onSelect,
}: RepositoryListProps) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [visibility, setVisibility] = useState<VisibilityFilter>("all");
  const [sortBy, setSortBy] = useState<SortBy>("updated");

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

  return (
    <div className="bg-card rounded-2xl border border-border/50">
      {/* ── Card header: account selector + search ──── */}
      <div className="px-5 py-4 border-b border-border/50">
        {/* ── Accounts row ──────────────────────────────── */}
        {accounts.length > 0 && (
          <div className="flex items-center gap-1.5 mb-4 overflow-x-auto no-scrollbar">
            {accounts.map((acc) => (
              <button
                key={acc.login}
                onClick={() => setSelectedOwner(acc.login)}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-[13px] font-medium transition-all whitespace-nowrap ${
                  selectedOwner === acc.login
                    ? "bg-primary/10 text-primary"
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

        {/* ── Search + filter row ───────────────────────── */}
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search repositories..."
              className="w-full pl-10 pr-4 py-2.5 bg-muted/40 border border-border/50 rounded-xl text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:bg-background transition-all"
            />
          </div>

          {/* Visibility pills */}
          <div className="hidden sm:flex items-center bg-muted/40 border border-border/50 rounded-xl p-0.5">
            {(["all", "public", "private"] as VisibilityFilter[]).map((v) => (
              <button
                key={v}
                onClick={() => setVisibility(v)}
                className={`px-3.5 py-2 rounded-lg text-xs font-medium capitalize transition-all ${
                  visibility === v
                    ? "bg-foreground text-background shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {v}
              </button>
            ))}
          </div>

          {/* Sort */}
          <div className="relative">
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortBy)}
              className="appearance-none pl-3.5 pr-8 py-2.5 bg-muted/40 border border-border/50 rounded-xl text-xs font-medium text-foreground cursor-pointer hover:bg-muted/70 focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
            >
              <option value="updated">Recent</option>
              <option value="name">Name</option>
              <option value="stars">Stars</option>
            </select>
            <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
          </div>
        </div>
      </div>

      {/* ── Repo list ────────────────────────────────────── */}
      {loadingRepos ? (
        <div className="divide-y divide-border/50">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="px-5 py-4 flex items-center gap-4 animate-pulse">
              <div className="w-10 h-10 bg-muted rounded-xl" />
              <div className="flex-1 space-y-2">
                <div className="h-4 w-32 bg-muted rounded" />
                <div className="h-3 w-48 bg-muted rounded" />
              </div>
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="px-6 py-12 text-center">
          <div className="relative mx-auto w-48 h-32 mb-4">
            <svg className="w-full h-full" viewBox="0 0 200 130" fill="none">
              <rect x="50" y="25" width="100" height="75" rx="12" fill="var(--th-sf-04)" />
              <rect x="40" y="15" width="100" height="75" rx="12" fill="var(--th-sf-03)" stroke="var(--th-bd-subtle)" strokeWidth="1" />
              <rect x="30" y="5" width="100" height="75" rx="12" fill="var(--th-card-bg)" stroke="var(--th-bd-default)" strokeWidth="1" />
              <rect x="30" y="5" width="100" height="22" rx="12" fill="var(--th-sf-05)" />
              <circle cx="44" cy="16" r="3" fill="#ef4444" fillOpacity="0.6" />
              <circle cx="54" cy="16" r="3" fill="#eab308" fillOpacity="0.6" />
              <circle cx="64" cy="16" r="3" fill="#22c55e" fillOpacity="0.6" />
              <rect x="42" y="36" width="40" height="4" rx="2" fill="var(--th-on-12)" />
              <rect x="42" y="45" width="68" height="3" rx="1.5" fill="var(--th-on-08)" />
              <rect x="42" y="53" width="52" height="3" rx="1.5" fill="var(--th-on-08)" />
              <circle cx="170" cy="65" r="18" fill="var(--th-on-05)" />
              <circle cx="170" cy="65" r="13" fill="var(--th-card-bg)" stroke="var(--th-on-20)" strokeWidth="1.5" strokeDasharray="3 2" />
              <path d="M170 58v14M163 65h14" stroke="var(--th-on-40)" strokeWidth="1.5" strokeLinecap="round" />
              <circle cx="15" cy="40" r="3" fill="var(--th-on-10)" />
              <circle cx="185" cy="25" r="2.5" fill="var(--th-on-12)" />
              <path d="M130 60 Q 148 58 155 65" stroke="var(--th-on-12)" strokeWidth="1" strokeDasharray="3 3" fill="none" />
            </svg>
          </div>
          <h3 className="text-lg font-medium text-foreground/80 mb-2">
            {search ? "No matching repositories" : "No repositories found"}
          </h3>
          <p className="text-sm text-muted-foreground max-w-sm mx-auto leading-relaxed">
            {search
              ? "Try a different search term or adjust your filters"
              : "This account doesn\u2019t have any repositories yet"}
          </p>
        </div>
      ) : (
        <>
          <div className="divide-y divide-border/50">
            {filtered.map((repo) => {
              const ownerLogin = getOwnerLogin(repo.owner);
              const stars = repo.stars ?? repo.stargazers_count ?? 0;
              const forks = repo.forks ?? repo.forks_count ?? 0;
              return (
                <div
                  key={repo.id ?? repo.full_name ?? `${ownerLogin}/${repo.name}`}
                  className="px-5 py-3.5 flex items-center gap-4 hover:bg-muted/40 transition-colors cursor-pointer group"
                  onClick={() => onSelect ? onSelect(ownerLogin, repo) : handleDeploy(ownerLogin, repo.name)}
                >
                  <div className="w-10 h-10 rounded-xl bg-muted/60 flex items-center justify-center shrink-0 group-hover:bg-muted transition-colors">
                    {repo.private ? (
                      <Lock className="size-[18px] text-muted-foreground" />
                    ) : (
                      <Globe className="size-[18px] text-muted-foreground" />
                    )}
                  </div>

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
                    <div className="flex items-center gap-2 mt-0.5">
                      {repo.description && (
                        <p className="text-xs text-muted-foreground truncate">{repo.description}</p>
                      )}
                      {repo.description && <span className="text-muted-foreground/40">·</span>}
                      <span className="text-xs text-muted-foreground shrink-0">{timeAgo(repo.updated_at)}</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-3 shrink-0">
                    {repo.language && (
                      <span className="hidden sm:flex items-center gap-1.5 text-xs text-muted-foreground">
                        <span
                          className="w-2.5 h-2.5 rounded-full"
                          style={{ backgroundColor: LANG_COLORS[repo.language] ?? "#888" }}
                        />
                        {repo.language}
                      </span>
                    )}
                    {stars > 0 && (
                      <span className="hidden sm:flex items-center gap-1 text-xs text-muted-foreground">
                        <Star className="size-3" />
                        {stars}
                      </span>
                    )}
                    {forks > 0 && (
                      <span className="hidden sm:flex items-center gap-1 text-xs text-muted-foreground">
                        <GitFork className="size-3" />
                        {forks}
                      </span>
                    )}
                    <ArrowRight className="size-4 text-muted-foreground/40 group-hover:text-muted-foreground transition-colors" />
                  </div>
                </div>
              );
            })}
          </div>
          {filtered.length > 0 && (
            <div className="px-5 py-3 text-center text-xs text-muted-foreground/50 border-t border-border/30">
              {filtered.length} repositor{filtered.length === 1 ? "y" : "ies"}
              {search && ` matching "${search}"`}
            </div>
          )}
        </>
      )}
    </div>
  );
}
