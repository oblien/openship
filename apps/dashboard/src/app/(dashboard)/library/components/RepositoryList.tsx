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
  ChevronLeft,
  ChevronRight,
  Github,
  Plus,
  AlertTriangle,
} from "lucide-react";
import type { GitHubRepo } from "@/context/GitHubContext";
import { encodeRepoSlug } from "@/utils/repoSlug";
import type { VisibilityFilter, SortBy } from "../types";
import { LANG_COLORS } from "@/constants/lang-colors";
import { useI18n, interpolate } from "@/components/i18n-provider";

/* ── Helpers ─────────────────────────────────────────────────────── */

interface TimeStrings {
  justNow: string;
  minutesAgo: string;
  hoursAgo: string;
  daysAgo: string;
  monthsAgo: string;
}

function timeAgo(dateStr: string, tr: TimeStrings): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return tr.justNow;
  if (mins < 60) return interpolate(tr.minutesAgo, { n: String(mins) });
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return interpolate(tr.hoursAgo, { n: String(hrs) });
  const days = Math.floor(hrs / 24);
  if (days < 30) return interpolate(tr.daysAgo, { n: String(days) });
  return interpolate(tr.monthsAgo, { n: String(Math.floor(days / 30)) });
}

/* ── Component ────────────────────────────────────────────────────── */

interface Account {
  login: string;
  avatar_url: string;
}

/**
 * Server-pagination controls. When provided, the list stops filtering/sorting/
 * slicing locally — `repos` is already the server-resolved page, the search /
 * visibility / sort inputs become controlled (reported up so the server can
 * refetch), the footer shows the authoritative `count`, and a pager appears.
 * Absent → the list runs entirely client-side over `repos` (its original
 * behavior, used by the repo pickers in GitSettings + the migration wizard).
 */
export interface RepoServerPagination {
  search: string;
  onSearch: (value: string) => void;
  visibility: VisibilityFilter;
  onVisibility: (value: VisibilityFilter) => void;
  sort: SortBy;
  onSort: (value: SortBy) => void;
  page: number;
  totalPages: number;
  onPage: (page: number) => void;
  /** Repos matching the active search + visibility (drives the footer count). */
  count: number;
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
  /** GitHub App install URL - shown when connected but no installations */
  installUrl?: string | null;
  /** Opt into server-side pagination (Library). Omit for client-side lists. */
  server?: RepoServerPagination;
}

export function RepositoryList({
  repos,
  accounts,
  selectedOwner,
  setSelectedOwner,
  loading,
  loadingRepos,
  onSelect,
  installUrl,
  server,
}: RepositoryListProps) {
  const { t } = useI18n();
  const router = useRouter();
  // Search / visibility / sort live locally for client-side lists; in server
  // mode they're controlled by the parent (which refetches on change).
  const [localSearch, setLocalSearch] = useState("");
  const [localVisibility, setLocalVisibility] = useState<VisibilityFilter>("all");
  const [localSortBy, setLocalSortBy] = useState<SortBy>("updated");

  const search = server ? server.search : localSearch;
  const setSearch = server ? server.onSearch : setLocalSearch;
  const visibility = server ? server.visibility : localVisibility;
  const setVisibility = server ? server.onVisibility : setLocalVisibility;
  const sortBy = server ? server.sort : localSortBy;
  const setSortBy = server ? server.onSort : setLocalSortBy;

  const filtered = useMemo(() => {
    if (!Array.isArray(repos)) return [];
    // Server mode: `repos` is already the searched/sorted/sliced page.
    if (server) return repos;
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
  }, [repos, search, visibility, sortBy, server]);

  // Footer count: authoritative server count (search/visibility-scoped) in
  // server mode, else the locally-filtered length.
  const footerCount = server ? server.count : filtered.length;

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
                {acc.avatar_url ? (
                  <img
                    src={acc.avatar_url}
                    alt=""
                    className="w-5 h-5 rounded-full"
                  />
                ) : (
                  <span className="flex w-5 h-5 items-center justify-center rounded-full bg-muted">
                    <Github className="size-3" />
                  </span>
                )}
                {acc.login}
              </button>
            ))}
            {installUrl ? (
              <a
                href={installUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/50 text-muted-foreground transition-all hover:border-border hover:bg-muted/50 hover:text-foreground"
                aria-label={t.library.repositoryList.addAccount}
                title={t.library.repositoryList.addAccount}
              >
                <Plus className="size-4" />
              </a>
            ) : null}
          </div>
        )}

        {/* ── Search + filter row ───────────────────────── */}
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute start-3.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t.library.repositoryList.searchPlaceholder}
              className="w-full ps-10 pe-4 py-2.5 bg-muted/40 border border-border/50 rounded-xl text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:bg-background transition-all"
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
                {t.library.repositoryList.visibility[v]}
              </button>
            ))}
          </div>

          {/* Sort */}
          <div className="relative">
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortBy)}
              className="appearance-none ps-3.5 pe-8 py-2.5 bg-muted/40 border border-border/50 rounded-xl text-xs font-medium text-foreground cursor-pointer hover:bg-muted/70 focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
            >
              <option value="updated">{t.library.repositoryList.sort.recent}</option>
              <option value="name">{t.library.repositoryList.sort.name}</option>
              <option value="stars">{t.library.repositoryList.sort.stars}</option>
            </select>
            <ChevronDown className="absolute end-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
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
          {!search && accounts.length === 0 && installUrl ? (
            /* Connected but no installations - prompt to install */
            <>
              <div className="mx-auto w-12 h-12 rounded-2xl bg-muted/60 flex items-center justify-center mb-4">
                <Github className="size-6 text-muted-foreground" />
              </div>
              <h3 className="text-lg font-medium text-foreground/80 mb-2">
                {t.library.repositoryList.installTitle}
              </h3>
              <p className="text-sm text-muted-foreground max-w-sm mx-auto leading-relaxed mb-4">
                {t.library.repositoryList.installDesc}
              </p>
              <a
                href={installUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium bg-foreground text-background rounded-xl hover:bg-foreground/90 transition-colors"
              >
                <Github className="size-4" />
                {t.library.repositoryList.installButton}
              </a>
            </>
          ) : (
            /* Generic empty state */
            <>
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
                {search ? t.library.repositoryList.noMatching : t.library.repositoryList.noRepos}
              </h3>
              <p className="text-sm text-muted-foreground max-w-sm mx-auto leading-relaxed">
                {search
                  ? t.library.repositoryList.noMatchingDesc
                  : t.library.repositoryList.noReposDesc}
              </p>
            </>
          )}
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
                          {t.library.repositoryList.privateBadge}
                        </span>
                      )}
                      {/* "Local only" chip — surfaces when the repo is
                          visible via gh CLI but the GitHub App isn't
                          installed on its owner. Remote deploys will be
                          refused at preflight; local builds work. */}
                      {repo.source === "cli" && (
                        <span
                          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-warning-bg text-[10px] font-medium text-warning"
                          title={interpolate(t.library.repositoryList.localOnlyTooltip, { owner: typeof repo.owner === "string" ? repo.owner : repo.owner.login })}
                        >
                          <AlertTriangle className="size-2.5" />
                          {t.library.repositoryList.localOnly}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      {repo.description && (
                        <p className="text-xs text-muted-foreground truncate">{repo.description}</p>
                      )}
                      {repo.description && <span className="text-muted-foreground/40">·</span>}
                      <span className="text-xs text-muted-foreground shrink-0">{timeAgo(repo.updated_at, t.library.repositoryList.time)}</span>
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
                    <ArrowRight className="size-4 text-muted-foreground/40 group-hover:text-muted-foreground transition-colors rtl:rotate-180" />
                  </div>
                </div>
              );
            })}
          </div>
          {filtered.length > 0 && (
            <div
              className={`px-5 py-3 border-t border-border/30 ${
                server ? "flex items-center justify-between gap-3" : "text-center"
              }`}
            >
              <span className="text-xs text-muted-foreground/50">
                {interpolate(footerCount === 1 ? t.library.repositoryList.repoCountSingular : t.library.repositoryList.repoCountPlural, { count: String(footerCount) })}
                {search && ` ${interpolate(t.library.repositoryList.matching, { query: search })}`}
              </span>
              {server && server.totalPages > 1 && (
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => server.onPage(server.page - 1)}
                    disabled={server.page <= 1}
                    aria-label={t.library.repositoryList.pagination.previous}
                    className="inline-flex size-7 items-center justify-center rounded-lg border border-border/50 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                  >
                    <ChevronLeft className="size-4 rtl:rotate-180" />
                  </button>
                  <span className="px-1 text-xs text-muted-foreground tabular-nums">
                    {interpolate(t.library.repositoryList.pagination.pageOf, {
                      page: String(server.page),
                      total: String(server.totalPages),
                    })}
                  </span>
                  <button
                    type="button"
                    onClick={() => server.onPage(server.page + 1)}
                    disabled={server.page >= server.totalPages}
                    aria-label={t.library.repositoryList.pagination.next}
                    className="inline-flex size-7 items-center justify-center rounded-lg border border-border/50 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                  >
                    <ChevronRight className="size-4 rtl:rotate-180" />
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
