"use client";

import React from "react";
import {
  Github,
  Lock,
  Globe,
  Plus,
  Link2,
  BookOpen,
  Zap,
  GitBranch,
  Sparkles,
} from "lucide-react";
import type { GitHubRepo } from "@/context/GitHubContext";

type Tab = "local" | "repositories" | "url" | "template";

interface LibrarySidebarProps {
  connected: boolean;
  selectedOwner: string;
  repos: GitHubRepo[];
  onSwitchTab: (tab: Tab) => void;
}

export function LibrarySidebar({ connected, selectedOwner, repos, onSwitchTab }: LibrarySidebarProps) {
  const publicCount = repos.filter((r) => !r.private).length;
  const privateCount = repos.filter((r) => r.private).length;

  return (
    <div className="space-y-4 lg:sticky lg:top-6 lg:self-start">
      {/* Connection status */}
      <div className="bg-card rounded-2xl border border-border/50 p-5">
        <div className="flex items-center gap-2 mb-4">
          <Github className="size-4 text-muted-foreground" />
          <h3 className="font-semibold text-foreground text-sm">Connection</h3>
        </div>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
              connected ? "bg-emerald-500/10" : "bg-muted/60"
            }`}>
              <Github className={`size-4 ${
                connected ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"
              }`} />
            </div>
            <div>
              <span className="text-sm text-muted-foreground">GitHub</span>
              {connected && selectedOwner && (
                <p className="text-xs text-muted-foreground/60">{selectedOwner}</p>
              )}
            </div>
          </div>
          <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium ${
            connected
              ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              : "bg-amber-500/10 text-amber-600 dark:text-amber-400"
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${connected ? "bg-emerald-500" : "bg-amber-500"}`} />
            {connected ? "Connected" : "Disconnected"}
          </span>
        </div>
      </div>

      {/* Stats (when connected) */}
      {connected && repos.length > 0 && (
        <div className="bg-card rounded-2xl border border-border/50 p-5">
          <div className="flex items-center gap-2 mb-4">
            <BookOpen className="size-4 text-muted-foreground" />
            <h3 className="font-semibold text-foreground text-sm">Overview</h3>
          </div>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                  <GitBranch className="size-4 text-primary" />
                </div>
                <span className="text-sm text-muted-foreground">Total</span>
              </div>
              <span className="text-lg font-semibold text-foreground">{repos.length}</span>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center">
                  <Globe className="size-4 text-blue-500" />
                </div>
                <span className="text-sm text-muted-foreground">Public</span>
              </div>
              <span className="text-lg font-semibold text-foreground">{publicCount}</span>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-orange-500/10 flex items-center justify-center">
                  <Lock className="size-4 text-orange-500" />
                </div>
                <span className="text-sm text-muted-foreground">Private</span>
              </div>
              <span className="text-lg font-semibold text-foreground">{privateCount}</span>
            </div>
          </div>
        </div>
      )}

      {/* Quick Tip */}
      <div className="bg-gradient-to-br from-primary/5 via-primary/3 to-transparent rounded-2xl border border-primary/10 p-5">
        <div className="flex items-center gap-2 mb-3">
          <Zap className="size-4 text-primary" />
          <h3 className="font-semibold text-foreground text-sm">Quick Tip</h3>
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Select any repository to deploy it instantly. Configure automatic deployments on every push.
        </p>
      </div>

      {/* Quick Actions */}
      <div className="bg-card rounded-2xl border border-border/50 p-5">
        <div className="flex items-center gap-2 mb-4">
          <Plus className="size-4 text-muted-foreground" />
          <h3 className="font-semibold text-foreground text-sm">Quick Actions</h3>
        </div>
        <div className="space-y-2">
          <button
            onClick={() => onSwitchTab("repositories")}
            className="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium text-foreground bg-foreground/[0.04] hover:bg-foreground/[0.08] transition-colors"
          >
            <Github className="size-4 text-muted-foreground" />
            Import from GitHub
          </button>
          <button
            onClick={() => onSwitchTab("url")}
            className="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-foreground/[0.04] transition-colors"
          >
            <Link2 className="size-4" />
            Import from URL
          </button>
          <button
            onClick={() => onSwitchTab("template")}
            className="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-foreground/[0.04] transition-colors"
          >
            <Sparkles className="size-4" />
            Start from Template
          </button>
        </div>
      </div>
    </div>
  );
}
