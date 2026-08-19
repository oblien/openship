"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowRight, FolderGit2, Loader2, Search, Settings } from "lucide-react";
import type { AzureRepo } from "@/lib/api";
import { encodeProviderRepoSlug } from "@/utils/repoSlug";
import { useI18n } from "@/components/i18n-provider";

interface AzureRepositoryListProps {
  orgs: string[];
  selectedOrg: string;
  setSelectedOrg: (org: string) => void;
  repos: AzureRepo[];
  loading: boolean;
  connected: boolean;
  onConnect?: () => void;
  connecting?: boolean;
  oauthConfigured?: boolean;
}

export function AzureRepositoryList({
  orgs,
  selectedOrg,
  setSelectedOrg,
  repos,
  loading,
  connected,
  onConnect,
  connecting,
  oauthConfigured,
}: AzureRepositoryListProps) {
  const { t } = useI18n();
  const router = useRouter();
  const [search, setSearch] = useState("");
  const copy = t.library.azure;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return repos;
    return repos.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.project.toLowerCase().includes(q) ||
        r.full_name.toLowerCase().includes(q),
    );
  }, [repos, search]);

  if (!connected) {
    return (
      <div className="bg-card rounded-2xl border border-border/50">
        <div className="px-6 py-12 text-center">
          <div className="mx-auto mb-5 flex size-14 items-center justify-center rounded-2xl bg-sky-500/10 ring-4 ring-sky-500/5">
            <FolderGit2 className="size-6 text-sky-600" />
          </div>
          <h3 className="mb-1.5 text-lg font-medium text-foreground/85">{copy.connectTitle}</h3>
          <p className="mx-auto mb-7 max-w-md text-sm leading-relaxed text-muted-foreground">
            {copy.connectDesc}
          </p>
          <div className="flex items-center justify-center gap-3">
            {oauthConfigured && onConnect ? (
              <button
                type="button"
                onClick={onConnect}
                disabled={connecting}
                className="inline-flex items-center gap-2 rounded-xl bg-foreground px-6 py-3 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
              >
                {connecting ? <Loader2 className="size-4 animate-spin" /> : null}
                {copy.connectButton}
              </button>
            ) : null}
            <Link
              href="/settings?tab=git"
              className="inline-flex items-center gap-2 rounded-xl border border-border/60 px-5 py-3 text-sm font-medium text-foreground hover:bg-muted/50"
            >
              <Settings className="size-4" />
              {copy.connectInSettings}
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-card rounded-2xl border border-border/50">
      <div className="px-5 py-4 border-b border-border/50 space-y-4">
        {orgs.length > 0 && (
          <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
            {orgs.map((org) => (
              <button
                key={org}
                type="button"
                onClick={() => setSelectedOrg(org)}
                className={`px-3 py-1.5 rounded-lg text-[13px] font-medium whitespace-nowrap transition-all ${
                  selectedOrg === org
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                }`}
              >
                {org}
              </button>
            ))}
          </div>
        )}
        <div className="relative">
          <Search className="absolute start-3.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={copy.searchPlaceholder}
            className="w-full ps-10 pe-4 py-2.5 bg-muted/40 border border-border/50 rounded-xl text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:bg-background transition-all"
          />
        </div>
      </div>

      {loading ? (
        <div className="px-6 py-12 flex items-center justify-center text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="px-6 py-12 text-center">
          <h3 className="text-lg font-medium text-foreground/80 mb-2">
            {search ? copy.noMatching : orgs.length === 0 ? copy.emptyOrgs : copy.noRepos}
          </h3>
          <p className="text-sm text-muted-foreground max-w-sm mx-auto leading-relaxed">
            {search ? copy.noMatchingDesc : orgs.length === 0 ? copy.emptyOrgsDesc : copy.noReposDesc}
          </p>
        </div>
      ) : (
        <div className="divide-y divide-border/50">
          {filtered.map((repo) => (
            <button
              key={repo.id || repo.full_name}
              type="button"
              className="w-full px-5 py-3.5 flex items-center gap-4 hover:bg-muted/40 transition-colors text-start group"
              onClick={() => {
                const slug = encodeProviderRepoSlug("azure", repo.org, repo.name, repo.project);
                router.push(`/deploy/${slug}`);
              }}
            >
              <div className="w-10 h-10 rounded-xl bg-muted/60 flex items-center justify-center shrink-0">
                <FolderGit2 className="size-[18px] text-muted-foreground" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground truncate">{repo.name}</p>
                <p className="text-xs text-muted-foreground truncate mt-0.5">
                  {repo.org} / {repo.project}
                </p>
              </div>
              <ArrowRight className="size-4 text-muted-foreground/40 group-hover:text-muted-foreground rtl:rotate-180" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
