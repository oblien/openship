"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  FolderKanban,
  Rocket,
  ArrowRight,
  Plus,
  ExternalLink,
  Clock,
  BookOpen,
  Terminal,
  GitBranch,
  Settings,
  Activity,
  TrendingUp,
  CheckCircle2,
} from "lucide-react";
import { projectsApi } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import HomeTipCard from "@/components/overview/HomeTipCard";
import { useI18n } from "@/components/i18n-provider";
import { getProjectStatus, PROJECT_STATUS_META } from "@/utils/project-status";
import { PageContainer } from "@/components/ui/PageContainer";
import ProjectCard from "./projects/components/ProjectCard";
import { type Project } from "@/constants/mock";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

interface DashboardNumbers {
  total_active_projects?: number;
  total_deployments?: number;
  total_success_deployments?: number;
  total_failed_deployments?: number;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/*  Component                                                         */
/* ------------------------------------------------------------------ */

export default function DashboardHome() {
  const { user } = useAuth();
  const { t } = useI18n();
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [numbers, setNumbers] = useState<DashboardNumbers>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await projectsApi.getHome();
        setNumbers(res.numbers ?? {});
        if (res.success && Array.isArray(res.projects)) {
          setProjects(res.projects);
        }
      } catch {
        /* silent */
      } finally {
        setLoading(false);
      }
    })();
  }, []);

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
            {displayName ? `${greeting}, ${displayName}` : greeting}
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
                    <h2 className="font-semibold text-foreground text-[15px]">Your Projects</h2>
                    <p className="text-xs text-muted-foreground">
                      {loading ? "Loading..." : `${projects.length} project${projects.length !== 1 ? 's' : ''}`}
                    </p>
                  </div>
                </div>
                <Link
                  href="/projects"
                  className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
                >
                  View all
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
                <div className="px-6 pb-10 text-center">
                  {/* Enhanced SVG Illustration */}
                  <div className="relative mx-auto w-64 h-44">
                    <svg className="absolute inset-0 w-full h-full" viewBox="0 0 260 180" fill="none">
                      {/* Background card stack effect */}
                      <rect x="75" y="45" width="130" height="95" rx="14" fill="var(--th-sf-04)" />
                      <rect x="65" y="35" width="130" height="95" rx="14" fill="var(--th-sf-03)" stroke="var(--th-bd-subtle)" strokeWidth="1" />
                      <rect x="55" y="25" width="130" height="95" rx="14" fill="var(--th-card-bg)" stroke="var(--th-bd-default)" strokeWidth="1" />
                      
                      {/* Card content - header bar */}
                      <rect x="55" y="25" width="130" height="28" rx="14" fill="var(--th-sf-05)" />
                      <circle cx="72" cy="39" r="4" fill="#ef4444" fillOpacity="0.6" />
                      <circle cx="84" cy="39" r="4" fill="#eab308" fillOpacity="0.6" />
                      <circle cx="96" cy="39" r="4" fill="#22c55e" fillOpacity="0.6" />
                      
                      {/* Content placeholder lines */}
                      <rect x="70" y="65" width="50" height="5" rx="2.5" fill="var(--th-on-12)" />
                      <rect x="70" y="76" width="85" height="4" rx="2" fill="var(--th-on-08)" />
                      <rect x="70" y="85" width="65" height="4" rx="2" fill="var(--th-on-08)" />
                      
                      {/* Folder/Project icon */}
                      <rect x="70" y="100" width="28" height="22" rx="5" fill="var(--th-on-05)" stroke="var(--th-on-10)" strokeWidth="1" />
                      <path d="M74 105h8l2.5 2.5h9.5v11H74V105z" fill="var(--th-on-10)" />
                      
                      {/* Animated plus button */}
                      <circle cx="210" cy="90" r="22" fill="var(--th-on-05)" />
                      <circle cx="210" cy="90" r="16" fill="var(--th-card-bg)" stroke="var(--th-on-20)" strokeWidth="2" strokeDasharray="4 3" />
                      <path d="M210 82v16M202 90h16" stroke="var(--th-on-40)" strokeWidth="2" strokeLinecap="round" />
                      
                      {/* Decorative elements */}
                      <circle cx="30" cy="60" r="4" fill="var(--th-on-10)" />
                      <circle cx="40" cy="140" r="6" fill="var(--th-on-08)" />
                      <circle cx="230" cy="40" r="3" fill="var(--th-on-12)" />
                      <circle cx="245" cy="130" r="5" fill="var(--th-on-06)" />
                      
                      {/* Sparkle/star accents */}
                      <path d="M25 100l2-4 2 4-4-2 4 0-4 2z" fill="var(--th-on-16)" />
                      <path d="M220 150l1.5-3 1.5 3-3-1.5 3 0-3 1.5z" fill="var(--th-on-12)" />
                      
                      {/* Connecting line */}
                      <path d="M185 95 Q 192 92 195 90" stroke="var(--th-on-12)" strokeWidth="1.5" strokeDasharray="3 3" fill="none" />
                    </svg>
                  </div>
                  
                  <h3 className="text-lg font-medium text-foreground/80 mb-2">
                    Start your first project
                  </h3>
                  <p className="text-sm text-muted-foreground max-w-sm mx-auto mb-8 leading-relaxed">
                    Import a Git repository, use a template, or deploy from CLI. 
                    Your projects will appear here.
                  </p>
                  
                  <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
                    <Link
                      href="/library"
                      className="inline-flex items-center gap-2 px-6 py-3 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-all hover:shadow-lg hover:shadow-primary/25 hover:-translate-y-0.5"
                    >
                      <Plus className="size-4" />
                      Create Project
                    </Link>
                    <Link
                      href="/library"
                      className="inline-flex items-center gap-2 px-6 py-3 bg-muted/50 text-foreground text-sm font-medium rounded-xl hover:bg-muted transition-colors"
                    >
                      <GitBranch className="size-4" />
                      Browse Templates
                    </Link>
                  </div>
                  
                  <p className="text-xs text-muted-foreground/60 mt-6">
                    Or press <kbd className="px-1.5 py-0.5 bg-muted rounded text-[10px] font-mono">⌘ K</kbd> to open command palette
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-border/50">
                  {projects.slice(0, 6).map((p) => (
                    <ProjectCard key={p.id} project={p} />
                  ))}
                  {projects.length > 6 && (
                    <Link
                      href="/projects"
                      className="block px-5 py-3 text-center text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
                    >
                      View all {projects.length} projects →
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
                <p className="text-sm font-medium text-foreground">Import Git</p>
                <p className="text-xs text-muted-foreground mt-0.5">From repository</p>
              </Link>
              <Link
                href="/library"
                className="bg-card border border-border/50 rounded-xl p-4 hover:bg-muted/40 hover:border-border transition-all group"
              >
                <div className="w-9 h-9 rounded-lg bg-muted flex items-center justify-center mb-3 group-hover:scale-105 transition-transform">
                  <Terminal className="size-[18px] text-muted-foreground" />
                </div>
                <p className="text-sm font-medium text-foreground">CLI Deploy</p>
                <p className="text-xs text-muted-foreground mt-0.5">Via terminal</p>
              </Link>
              <Link
                href="/settings"
                className="bg-card border border-border/50 rounded-xl p-4 hover:bg-muted/40 hover:border-border transition-all group"
              >
                <div className="w-9 h-9 rounded-lg bg-muted flex items-center justify-center mb-3 group-hover:scale-105 transition-transform">
                  <Settings className="size-[18px] text-muted-foreground" />
                </div>
                <p className="text-sm font-medium text-foreground">Settings</p>
                <p className="text-xs text-muted-foreground mt-0.5">Account & team</p>
              </Link>
              <a
                href="https://docs.openship.dev"
                target="_blank"
                rel="noopener noreferrer"
                className="bg-card border border-border/50 rounded-xl p-4 hover:bg-muted/40 hover:border-border transition-all group"
              >
                <div className="w-9 h-9 rounded-lg bg-muted flex items-center justify-center mb-3 group-hover:scale-105 transition-transform">
                  <BookOpen className="size-[18px] text-muted-foreground" />
                </div>
                <p className="text-sm font-medium text-foreground flex items-center gap-1">
                  Docs
                  <ExternalLink className="size-3 text-muted-foreground" />
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">Learn more</p>
              </a>
            </div>
          </div>

          {/* ── RIGHT COLUMN (Sticky) ──────────────────────────────── */}
          <div className="space-y-4 lg:sticky lg:top-6 lg:self-start">
            
            {/* Activity Overview */}
            <div className="bg-card rounded-2xl border border-border/50 p-5">
              <div className="flex items-center gap-2 mb-4">
                <Activity className="size-4 text-muted-foreground" />
                <h3 className="font-semibold text-foreground text-sm">Activity</h3>
              </div>
              
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                      <FolderKanban className="size-4 text-primary" />
                    </div>
                    <span className="text-sm text-muted-foreground">Projects</span>
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
                    <span className="text-sm text-muted-foreground">Deployments</span>
                  </div>
                  <span className="text-lg font-semibold text-foreground">
                    {loading ? "–" : numbers.total_deployments ?? 0}
                  </span>
                </div>
                
                <div className="h-px bg-border/60 my-2" />
                
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="size-4 text-emerald-500" />
                    <span className="text-sm text-muted-foreground">Success rate</span>
                  </div>
                  <span className={`text-sm font-medium ${successRate >= 80 ? 'text-emerald-500' : successRate >= 50 ? 'text-amber-500' : 'text-red-500'}`}>
                    {loading ? "–" : `${successRate}%`}
                  </span>
                </div>
              </div>
            </div>

            <HomeTipCard projectCount={projects.length} loading={loading} />

            {/* Recent Activity */}
            <div className="bg-card rounded-2xl border border-border/50 p-5">
              <div className="flex items-center gap-2 mb-4">
                <Clock className="size-4 text-muted-foreground" />
                <h3 className="font-semibold text-foreground text-sm">Recent</h3>
              </div>
              
              {loading ? (
                <div className="space-y-3">
                  {[...Array(3)].map((_, i) => (
                    <div key={i} className="flex items-center gap-3 animate-pulse">
                      <div className="w-2 h-2 rounded-full bg-muted" />
                      <div className="flex-1 h-4 bg-muted rounded" />
                    </div>
                  ))}
                </div>
              ) : projects.length === 0 ? (
                <div className="text-center py-4">
                  <div className="w-10 h-10 rounded-xl bg-muted/50 flex items-center justify-center mx-auto mb-3">
                    <Clock className="size-4 text-muted-foreground/50" />
                  </div>
                  <p className="text-xs text-muted-foreground/70">
                    Your activity will appear here
                  </p>
                </div>
              ) : (
                <div className="space-y-2.5">
                  {projects.slice(0, 4).map((p) => {
                    const status = getProjectStatus(p);
                    const statusMeta = PROJECT_STATUS_META[status];

                    return (
                      <div
                        key={p.id}
                        onClick={() => router.push(`/projects/${p.id}`)}
                        className="flex items-center gap-3 cursor-pointer group"
                      >
                        <span className={`w-2 h-2 rounded-full shrink-0 ${statusMeta.dot}`} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-foreground truncate group-hover:text-primary transition-colors">
                            {p.name}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {statusMeta.label} • {timeAgo(p.updatedAt || p.createdAt)}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Usage Notice */}
            {!loading && (numbers.total_active_projects ?? 0) > 0 && (
              <div className="bg-card rounded-2xl border border-border/50 p-5">
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center shrink-0">
                    <TrendingUp className="size-4 text-blue-500" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-foreground">All systems operational</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Your projects are running smoothly
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
    </PageContainer>
  );
}
