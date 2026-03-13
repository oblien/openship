"use client";

import React, { useState } from "react";
import { Github, Link2, Upload, Sparkles, Search, Lock, Globe, ArrowRight } from "lucide-react";
import { useGitHub, type GitHubRepo } from "@/context/GitHubContext";
import { ConnectPrompt } from "@/app/(dashboard)/library/components/ConnectPrompt";
import { frameworks } from "@/components/import-project/Frameworks";
import type { ProjectSource } from "../types";

type Tab = "github" | "url" | "template";

const TABS: { id: Tab; label: string; icon: React.ElementType }[] = [
  { id: "github", label: "GitHub", icon: Github },
  { id: "url", label: "Git URL", icon: Link2 },
  { id: "template", label: "Template", icon: Sparkles },
];

interface SourceSelectorProps {
  onSelect: (source: ProjectSource) => void;
}

export default function SourceSelector({ onSelect }: SourceSelectorProps) {
  const [tab, setTab] = useState<Tab>("github");

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-foreground" style={{ letterSpacing: "-0.3px" }}>
          Import Project
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          Choose how you want to import your project
        </p>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 bg-muted/50 rounded-xl p-1">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium rounded-lg transition-all ${
                active
                  ? "bg-background text-foreground shadow-sm border border-border/50"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Icon className="size-4" />
              {t.label}
            </button>
          );
        })}
      </div>

      {/* Content */}
      {tab === "github" && <GitHubTab onSelect={onSelect} />}
      {tab === "url" && <UrlTab onSelect={onSelect} />}
      {tab === "template" && <TemplateTab onSelect={onSelect} />}
    </div>
  );
}

/* ── GitHub tab ────────────────────────────────────────────────────── */

function GitHubTab({ onSelect }: { onSelect: (s: ProjectSource) => void }) {
  const { connected, connecting, connect, repos, accounts, selectedOwner, setSelectedOwner, loading, loadingRepos, cliAction, refresh } = useGitHub();
  const [search, setSearch] = useState("");

  if (!connected) {
    return <ConnectPrompt connecting={connecting} onConnect={connect} cliAction={cliAction} onRefresh={refresh} />;
  }

  const filtered = (repos || []).filter((r) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return r.name?.toLowerCase().includes(q) || r.description?.toLowerCase().includes(q);
  });

  const handleSelect = (repo: GitHubRepo) => {
    const owner = typeof repo.owner === "string" ? repo.owner : repo.owner.login;
    onSelect({
      kind: "github",
      owner,
      repo: repo.name,
      branch: repo.default_branch || "main",
    });
  };

  return (
    <div className="bg-card rounded-2xl border border-border/50">
      <div className="px-5 py-4 border-b border-border/50">
        {/* Account pills */}
        {accounts.length > 1 && (
          <div className="flex items-center gap-2 mb-3 overflow-x-auto">
            {accounts.map((acc) => (
              <button
                key={acc.login}
                onClick={() => setSelectedOwner(acc.login)}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-all shrink-0 ${
                  selectedOwner === acc.login
                    ? "bg-foreground text-background"
                    : "bg-muted/50 text-muted-foreground hover:text-foreground"
                }`}
              >
                <img src={acc.avatar_url} alt="" className="w-5 h-5 rounded-full" />
                {acc.login}
              </button>
            ))}
          </div>
        )}

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search repositories…"
            className="w-full pl-10 pr-4 py-2.5 bg-background border border-border/50 rounded-xl text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
          />
        </div>
      </div>

      <div className="max-h-[420px] overflow-y-auto">
        {(loading || loadingRepos) ? (
          <div className="p-8 text-center">
            <p className="text-sm text-muted-foreground">Loading repositories…</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-8 text-center">
            <p className="text-sm text-muted-foreground">No repositories found</p>
          </div>
        ) : (
          <div className="divide-y divide-border/30">
            {filtered.map((repo) => {
              const owner = typeof repo.owner === "string" ? repo.owner : repo.owner.login;
              return (
                <button
                  key={`${owner}/${repo.name}`}
                  onClick={() => handleSelect(repo)}
                  className="w-full flex items-center gap-4 px-5 py-3.5 hover:bg-muted/30 transition-colors text-left group"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-foreground truncate">
                        {repo.name}
                      </span>
                      {repo.private ? (
                        <Lock className="size-3 text-muted-foreground/60 shrink-0" />
                      ) : (
                        <Globe className="size-3 text-muted-foreground/40 shrink-0" />
                      )}
                    </div>
                    {repo.description && (
                      <p className="text-xs text-muted-foreground truncate mt-0.5">
                        {repo.description}
                      </p>
                    )}
                  </div>
                  <ArrowRight className="size-4 text-muted-foreground/30 group-hover:text-foreground transition-colors shrink-0" />
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── URL tab ───────────────────────────────────────────────────────── */

function UrlTab({ onSelect }: { onSelect: (s: ProjectSource) => void }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    const match = url.match(
      /(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/.]+)/
    );
    if (!match) {
      setError("Enter a valid GitHub repository URL");
      return;
    }

    onSelect({ kind: "url", owner: match[1]!, repo: match[2]! });
  };

  return (
    <div className="bg-card rounded-2xl border border-border/50 p-8">
      <div className="max-w-lg mx-auto">
        <div className="w-14 h-14 rounded-2xl bg-foreground/[0.06] flex items-center justify-center mx-auto mb-4">
          <Link2 className="size-7 text-muted-foreground" />
        </div>
        <h3 className="text-base font-semibold text-foreground text-center mb-1.5">
          Import from Git URL
        </h3>
        <p className="text-sm text-muted-foreground text-center mb-6 leading-relaxed">
          Paste a public repository URL to import
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
            {error && <p className="text-xs text-red-500 mt-1.5">{error}</p>}
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

/* ── Template tab ──────────────────────────────────────────────────── */

function TemplateTab({ onSelect }: { onSelect: (s: ProjectSource) => void }) {
  return (
    <div className="bg-card rounded-2xl border border-border/50 p-6">
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
        {frameworks
          .filter((fw) => fw.id !== "static")
          .map((fw) => (
            <button
              key={fw.id}
              onClick={() => onSelect({ kind: "template", templateName: fw.name, framework: fw.id })}
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
