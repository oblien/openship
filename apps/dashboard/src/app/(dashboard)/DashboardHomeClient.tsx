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
  CheckCircle2,
} from "lucide-react";
import { projectsApi } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import UpdatesBlock from "@/components/overview/UpdatesBlock";
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

  // Split catalog apps out of the projects list — they get their own box.
  const userProjects = projects.filter((p) => !p.isApp);
  const appProjects = projects.filter((p) => p.isApp);

  /* ---------- greeting ---------- */
  const hour = new Date().getHours();
  const greeting =
    hour < 12
      ? t.dashboard.home.goodMorning
      : hour < 18
        ? t.dashboard.home.goodAfternoon
        : t.dashboard.home.goodEvening;
  const displayName = user?.name?.split(" ")[0] || "";

  const successRate = numbers.total_deployments 
    ? Math.round(((numbers.total_success_deployments || 0) / numbers.total_deployments) * 100)
    : 0;

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
                            userProjects.length === 1
                              ? t.dashboard.home.projectCountOne
                              : t.dashboard.home.projectCountOther,
                            { count: String(userProjects.length) },
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
              ) : userProjects.length === 0 ? (
                <HomeWelcome />
              ) : (
                <div className="divide-y divide-border/50">
                  {userProjects.slice(0, 6).map((p) => (
                    <ProjectCard key={p.id} project={p} />
                  ))}
                  {userProjects.length > 6 && (
                    <Link
                      href="/projects"
                      className="block px-5 py-3 text-center text-sm text-muted-foreground/70 hover:text-foreground hover:bg-muted/40 transition-colors"
                    >
                      {interpolate(t.dashboard.home.viewAllProjects, { count: String(userProjects.length) })}
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
            
            {/* Activity Overview */}
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
                
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="size-4 text-success" />
                    <span className="text-sm text-muted-foreground">{t.dashboard.home.successRate}</span>
                  </div>
                  <span className={`text-sm font-medium ${successRate >= 80 ? 'text-success' : successRate >= 50 ? 'text-warning' : 'text-danger'}`}>
                    {loading ? "–" : `${successRate}%`}
                  </span>
                </div>
              </div>
            </div>

            <UpdatesBlock projectCount={projects.length} loading={loading} />

            {/* Apps — compact, colorful. Install is the fancy + in the header; the
                empty state is a small colorful vector, no big button. */}
            <div className="bg-card rounded-2xl border border-border/50 p-5">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <Boxes className="size-4 text-primary" />
                  <h3 className="font-semibold text-foreground text-sm">{t.dashboard.pages.apps.title}</h3>
                </div>
                <div className="flex items-center gap-0.5">
                  <Link
                    href="/apps/new"
                    aria-label={t.dashboard.pages.apps.createButton}
                    className="flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                  >
                    <Plus className="size-4" />
                  </Link>
                  <Link
                    href="/apps"
                    aria-label={t.dashboard.home.viewAll}
                    className="flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                  >
                    <ArrowRight className="size-4" />
                  </Link>
                </div>
              </div>

              {loading ? (
                <div className="grid grid-cols-2 gap-2.5">
                  {[...Array(2)].map((_, i) => (
                    <div key={i} className="h-[72px] rounded-xl bg-muted/40 animate-pulse" />
                  ))}
                </div>
              ) : appProjects.length === 0 ? (
                <div className="flex flex-col items-center pt-0 pb-2 text-center">
                  {/* Abstract "chain of app cards" — monochrome/on-theme, single
                      primary accent. Grows UPWARD (negative top margin into the
                      header gap) rather than pushing the copy + 6-logo stack down.
                      Real (colorful) logos live in the bottom stack. */}
                  <svg className="-mt-1 mb-2 h-14" viewBox="0 0 130 64" fill="none">
                    <circle cx="65" cy="32" r="22" fill="hsl(var(--primary))" fillOpacity="0.06" />
                    <path d="M42 32h8" stroke="var(--th-on-12)" strokeWidth="2" strokeDasharray="3 3" strokeLinecap="round" />
                    <path d="M80 32h8" stroke="var(--th-on-12)" strokeWidth="2" strokeDasharray="3 3" strokeLinecap="round" />
                    <rect x="16" y="20" width="26" height="26" rx="8" fill="var(--th-sf-04)" stroke="var(--th-bd-default)" strokeWidth="1" />
                    <rect x="24" y="28" width="10" height="10" rx="3" fill="var(--th-on-16)" />
                    <rect x="50" y="13" width="30" height="38" rx="9" fill="var(--th-card-bg)" stroke="var(--th-bd-default)" strokeWidth="1" />
                    <rect x="57" y="20" width="9" height="9" rx="3" fill="hsl(var(--primary))" />
                    <rect x="57" y="33" width="16" height="3.5" rx="1.75" fill="var(--th-on-12)" />
                    <rect x="57" y="40" width="11" height="3.5" rx="1.75" fill="var(--th-on-08)" />
                    <rect x="88" y="20" width="26" height="26" rx="8" fill="var(--th-sf-04)" stroke="var(--th-bd-default)" strokeWidth="1" />
                    <path d="M101 29v8M97 33h8" stroke="hsl(var(--primary))" strokeWidth="2" strokeLinecap="round" />
                    <circle cx="9" cy="13" r="3" fill="var(--th-on-10)" />
                    <circle cx="121" cy="51" r="4" fill="var(--th-on-08)" />
                  </svg>
                  <p className="text-sm font-medium text-foreground">{t.dashboard.home.appsEmptyTitle}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground/70">{t.dashboard.home.appsEmptyDesc}</p>
                  {/* Overlapping logo stack — the full catalog at a glance, on-theme. */}
                  <div className="mt-3.5 flex items-center justify-center">
                    {["supabase", "convex", "n8n", "ghost", "vaultwarden", "metabase"].map((id, i) => (
                      <div
                        key={id}
                        className={`flex size-7 items-center justify-center rounded-full border border-border/60 bg-card ${
                          i > 0 ? "-ml-2" : ""
                        }`}
                      >
                        <AppLogo appId={id} className="size-3.5" />
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="overflow-hidden rounded-xl border border-border/50 bg-muted/10">
                  {appProjects.slice(0, 3).map((p, i) => {
                    const status = getProjectStatus(p);
                    const statusMeta = PROJECT_STATUS_META[status];
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => router.push(`/projects/${p.id}`)}
                        className={`group flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/40 ${
                          i > 0 ? "border-t border-border/50" : ""
                        }`}
                      >
                        <div className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border/50 bg-background">
                          <AppLogo appId={p.appTemplateId ?? undefined} className="size-5" />
                        </div>
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground transition-colors group-hover:text-primary">
                          {p.name}
                        </span>
                        <span
                          className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium ${statusMeta.badge}`}
                        >
                          {projectStatusLabel(status, t)}
                        </span>
                      </button>
                    );
                  })}
                  {appProjects.length > 3 && (
                    <Link
                      href="/apps"
                      className="block border-t border-border/50 px-3 py-2.5 text-center text-xs text-muted-foreground/70 hover:text-foreground hover:bg-muted/40 transition-colors"
                    >
                      {interpolate(t.dashboard.home.viewAllApps, { count: String(appProjects.length) })}
                    </Link>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
    </PageContainer>
  );
}
