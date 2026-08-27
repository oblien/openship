"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  FolderKanban,
  Rocket,
  ArrowRight,
  ExternalLink,
  Clock,
  BookOpen,
  Boxes,
  Plus,
  GitBranch,
  Settings,
  Activity,
} from "lucide-react";
import { projectsApi } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import UpdatesBlock from "@/components/overview/UpdatesBlock";
import SystemStatusRow from "@/components/overview/SystemStatusRow";
import HomeWelcome from "@/components/overview/HomeWelcome";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { getProjectStatus, PROJECT_STATUS_META, projectStatusLabel } from "@/utils/project-status";
import type { Dictionary } from "@/i18n";
import { PageContainer } from "@/components/ui/PageContainer";
import ProjectCard from "./projects/components/ProjectCard";
import { type Project } from "@/constants/mock";
import { AppLogo } from "@/components/AppLogo";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function timeAgo(dateStr: string, labels: Dictionary["dashboard"]["home"]["time"]): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return labels.justNow;
  if (mins < 60) return interpolate(labels.minutes, { n: String(mins) });
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return interpolate(labels.hours, { n: String(hrs) });
  const days = Math.floor(hrs / 24);
  if (days < 30) return interpolate(labels.days, { n: String(days) });
  return interpolate(labels.months, { n: String(Math.floor(days / 30)) });
}

import { useDashboardHome } from "@/hooks/useDashboardHome";
import { useAttentionFeed } from "@/hooks/useAttentionFeed";

/* ------------------------------------------------------------------ */
/*  Component                                                         */
/* ------------------------------------------------------------------ */

interface DashboardHomeClientProps {
  initialData?: any;
}

export default function DashboardHomeClient({ initialData }: DashboardHomeClientProps) {
  const { user } = useAuth();
  const { t } = useI18n();
  const router = useRouter();
  
  const { projects, numbers, loading } = useDashboardHome(initialData);
  /** Read once here, not inside the card: the count decides the column's layout below. */
  const attention = useAttentionFeed();

  /* ---------- greeting ---------- */
  const hour = new Date().getHours();
  const greeting =
    hour < 12
      ? t.dashboard.home.goodMorning
      : hour < 18
        ? t.dashboard.home.goodAfternoon
        : t.dashboard.home.goodEvening;
  const displayName = user?.name?.split(" ")[0] || "";


  return (
    <PageContainer>
        
        {/* ── Header ─────────────────────────────────────────────── */}
        <div className="mb-6">
          <h1 className="text-2xl font-medium text-foreground/80" style={{ letterSpacing: "-0.2px" }}>
            {displayName ? interpolate(t.dashboard.home.greetingName, { greeting, name: displayName }) : greeting}
          </h1>
          <p className="text-sm text-muted-foreground/70 mt-1">
            {t.dashboard.home.subtitle}
          </p>
        </div>

        {/* ── Main Grid ──────────────────────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-6">
          
          {/* ── LEFT COLUMN ────────────────────────────────────────── */}
          <div className="space-y-6 min-w-0">
            
            {/* Projects Section */}
            <div className="bg-card rounded-2xl border border-border/50">
              <div className="flex items-center justify-between px-5 py-4 border-b border-border/50">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 bg-primary/10 rounded-xl flex items-center justify-center">
                    <FolderKanban className="size-[18px] text-primary" />
                  </div>
                  <div>
                    <h2 className="font-semibold text-foreground text-[15px]">{t.dashboard.home.yourProjects}</h2>
                    <p className="text-xs text-muted-foreground">
                      {loading
                        ? t.dashboard.home.loading
                        : interpolate(
                            projects.length === 1
                              ? t.dashboard.home.projectCountOne
                              : t.dashboard.home.projectCountOther,
                            { count: String(projects.length) },
                          )}
                    </p>
                  </div>
                </div>
                <Link
                  href="/projects"
                  className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
                >
                  {t.dashboard.home.viewAll}
                  <ArrowRight className="size-3.5" />
                </Link>
              </div>

              {loading ? (
                <div className="divide-y divide-border/50">
                  {[...Array(4)].map((_, i) => (
                    <div key={i} className="px-5 py-4 flex items-center gap-4 animate-pulse">
                      <div className="w-10 h-10 bg-muted rounded-xl" />
                      <div className="flex-1 space-y-2">
                        <div className="h-4 w-32 bg-muted rounded" />
                        <div className="h-3 w-48 bg-muted rounded" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : projects.length === 0 ? (
                <HomeWelcome />
              ) : (
                <div className="divide-y divide-border/50">
                  {projects.slice(0, 6).map((p) => (
                    <ProjectCard key={p.id} project={p} />
                  ))}
                  {projects.length > 6 && (
                    <Link
                      href="/projects"
                      className="block px-5 py-3 text-center text-sm text-muted-foreground/70 hover:text-foreground hover:bg-muted/40 transition-colors"
                    >
                      {interpolate(t.dashboard.home.viewAllProjects, { count: String(projects.length) })}
                    </Link>
                  )}
                </div>
              )}
            </div>

            {/* Shortcuts Grid */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Link
                href="/library"
                className="bg-card border border-border/50 rounded-xl p-4 hover:bg-muted/40 hover:border-border transition-all group"
              >
                <div className="w-9 h-9 rounded-lg bg-muted flex items-center justify-center mb-3 group-hover:scale-105 transition-transform">
                  <GitBranch className="size-[18px] text-muted-foreground" />
                </div>
                <p className="text-sm font-medium text-foreground">{t.dashboard.home.importGit}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{t.dashboard.home.importGitDesc}</p>
              </Link>
              <Link
                href="/settings?tab=mcp"
                className="bg-card border border-border/50 rounded-xl p-4 hover:bg-muted/40 hover:border-border transition-all group"
              >
                <div className="w-9 h-9 rounded-lg bg-muted flex items-center justify-center mb-3 group-hover:scale-105 transition-transform">
                  <Boxes className="size-[18px] text-muted-foreground" />
                </div>
                <p className="text-sm font-medium text-foreground">{t.dashboard.home.mcpDeploy}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{t.dashboard.home.mcpDeployDesc}</p>
              </Link>
              <Link
                href="/settings"
                className="bg-card border border-border/50 rounded-xl p-4 hover:bg-muted/40 hover:border-border transition-all group"
              >
                <div className="w-9 h-9 rounded-lg bg-muted flex items-center justify-center mb-3 group-hover:scale-105 transition-transform">
                  <Settings className="size-[18px] text-muted-foreground" />
                </div>
                <p className="text-sm font-medium text-foreground">{t.dashboard.home.settingsCard}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{t.dashboard.home.settingsCardDesc}</p>
              </Link>
              <a
                href="https://openship.io/docs"
                target="_blank"
                rel="noopener noreferrer"
                className="bg-card border border-border/50 rounded-xl p-4 hover:bg-muted/40 hover:border-border transition-all group"
              >
                <div className="w-9 h-9 rounded-lg bg-muted flex items-center justify-center mb-3 group-hover:scale-105 transition-transform">
                  <BookOpen className="size-[18px] text-muted-foreground" />
                </div>
                <p className="text-sm font-medium text-foreground flex items-center gap-1">
                  {t.dashboard.home.docs}
                  <ExternalLink className="size-3 text-muted-foreground" />
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">{t.dashboard.home.docsDesc}</p>
              </a>
            </div>
          </div>

          {/* ── RIGHT COLUMN (Sticky) ──────────────────────────────── */}
          <div className="space-y-4 lg:sticky lg:top-6 lg:self-start">
            
            {/* The column yields to attention one card at a time, least urgent first:
                one alert panel takes the Activity overview's space, a second takes the
                Apps card's. Nothing is lost — lifetime deploy counts live under
                Deployments and the catalog has its own sidebar entry — and it keeps the
                fold from becoming an alert panel chased by two pieces of furniture.

                `attention.cards` counts what will actually RENDER, hides included, so
                dismissing a panel hands the space straight back. */}
            {attention.cards === 0 && (
              <div className="bg-card rounded-2xl border border-border/50 p-5">
                <div className="flex items-center gap-2 mb-4">
                  <Activity className="size-4 text-muted-foreground" />
                  <h3 className="font-semibold text-foreground text-sm">{t.dashboard.home.activityTitle}</h3>
                </div>
              
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                        <FolderKanban className="size-4 text-primary" />
                      </div>
                      <span className="text-sm text-muted-foreground">{t.dashboard.home.statsProjects}</span>
                    </div>
                    <span className="text-lg font-semibold text-foreground">
                      {loading ? "–" : numbers.total_active_projects ?? 0}
                    </span>
                  </div>
                
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-lg bg-orange-500/10 flex items-center justify-center">
                        <Rocket className="size-4 text-orange-500" />
                      </div>
                      <span className="text-sm text-muted-foreground">{t.dashboard.home.statsDeployments}</span>
                    </div>
                    <span className="text-lg font-semibold text-foreground">
                      {loading ? "–" : numbers.total_deployments ?? 0}
                    </span>
                  </div>
                
                  <div className="h-px bg-border/60 my-2" />

                  <SystemStatusRow broken={attention.broken} loaded={attention.loaded} />
                </div>
              </div>
            )}

            <UpdatesBlock feed={attention} projectCount={projects.length} loading={loading} />
          </div>
        </div>
      </PageContainer>
    );
  }
