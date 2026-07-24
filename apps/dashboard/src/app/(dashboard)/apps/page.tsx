"use client";

import { useState, useEffect, useRef, useCallback, Fragment } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Project } from "@/constants/mock";
import ProjectCard from "../projects/components/ProjectCard";
import { projectsApi } from "@/lib/api";
import { updatesApi } from "@/lib/api/updates";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { AVAILABLE_APP_IDS } from "@repo/core";
import {
  Plus,
  Mail,
  Database,
  Workflow,
  FileText,
  Activity,
  KeyRound,
  BarChart3,
  ArrowRight,
  type LucideIcon,
} from "lucide-react";
import { PageContainer } from "@/components/ui/PageContainer";
import { AppLogo } from "@/components/AppLogo";

/**
 * Apps tab — catalog-installed managed services. Shares `projects/home` data with
 * the Projects page; keeps only `isApp` projects. When empty it becomes a showcase
 * of the catalog: a chain-of-apps hero (real brand logos) + a tap-to-install tile
 * per featured app. The featured list is static so the showcase never renders
 * empty; install always routes into the real /apps/new flow.
 */

interface FeaturedApp {
  id: string;
  name: string;
  desc: string;
  /** Fallback icon if the brand logo can't load. */
  icon: LucideIcon;
}

// Enabled apps (mail / n8n / convex) lead; the rest render dimmed "coming soon"
// (single source: AVAILABLE_APP_IDS in @repo/core).
const FEATURED_APPS: FeaturedApp[] = [
  { id: "supabase", name: "Supabase", desc: "Postgres backend + Studio", icon: Database },
  { id: "convex", name: "Convex", desc: "Reactive backend & database", icon: Database },
  { id: "mongodb", name: "MongoDB", desc: "Document database + Mongo Express", icon: Database },
  { id: "n8n", name: "n8n", desc: "Workflow automation", icon: Workflow },
  { id: "mail", name: "Openship Mail", desc: "Self-hosted mail server + webmail", icon: Mail },
  { id: "ghost", name: "Ghost", desc: "Publishing & newsletters", icon: FileText },
  { id: "uptime-kuma", name: "Uptime Kuma", desc: "Uptime monitoring", icon: Activity },
  { id: "vaultwarden", name: "Vaultwarden", desc: "Self-hosted password manager", icon: KeyRound },
  { id: "metabase", name: "Metabase", desc: "BI & dashboards", icon: BarChart3 },
];

/** Installable this version? Drives the dimmed "coming soon" treatment. */
const isAppEnabled = (id: string) => AVAILABLE_APP_IDS.has(id);

export default function AppsPage() {
  const { t } = useI18n();
  const router = useRouter();
  const ap = t.dashboard.pages.apps;
  const [projects, setProjects] = useState<Project[]>([]);
  const [updatesBehind, setUpdatesBehind] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(true);
  const isLoadingRef = useRef(false);

  const load = useCallback(async () => {
    if (isLoadingRef.current) return;
    isLoadingRef.current = true;
    setIsLoading(true);
    try {
      const home = await projectsApi.getHome();
      if (home.success && Array.isArray(home.projects)) setProjects(home.projects);
    } catch (error) {
      console.error("Error fetching apps:", error);
    } finally {
      setIsLoading(false);
      isLoadingRef.current = false;
    }
  }, []);

  useEffect(() => {
    load();
    // Which installed apps have a pending update (fed by the update scan). Best-
    // effort — a failure just hides the badge.
    updatesApi
      .list(true)
      .then((res) => setUpdatesBehind(new Set(res.data.map((u) => u.projectId))))
      .catch(() => {});
    return () => {
      isLoadingRef.current = false;
    };
  }, [load]);

  const apps = projects.filter((p) => p.isApp);

  return (
    <PageContainer outerClassName="pb-20">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6">
        <div>
          <h1
            className="text-2xl font-medium text-foreground/80"
            style={{ letterSpacing: "-0.2px" }}
          >
            {ap.title}
          </h1>
          <p className="text-sm text-muted-foreground/70 mt-1">
            {isLoading
              ? ap.loading
              : interpolate(apps.length === 1 ? ap.countOne : ap.countOther, {
                  count: String(apps.length),
                })}
          </p>
        </div>
        {apps.length > 0 && (
          <Link
            href="/apps/new"
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-medium transition-all hover:bg-primary/90 hover:shadow-lg hover:shadow-primary/25 hover:-translate-y-0.5 w-full sm:w-auto justify-center"
          >
            <Plus className="size-4" />
            <span>{ap.createButton}</span>
          </Link>
        )}
      </div>

      {isLoading ? (
        <div className="bg-card rounded-2xl border border-border/50 divide-y divide-border/50">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="px-5 py-4 flex items-center gap-4 animate-pulse">
              <div className="w-10 h-10 bg-muted rounded-xl" />
              <div className="flex-1 space-y-2">
                <div className="h-4 bg-muted rounded-lg w-32" />
                <div className="h-3 bg-muted/60 rounded-lg w-48" />
              </div>
            </div>
          ))}
        </div>
      ) : apps.length === 0 ? (
        <div className="py-12 sm:py-16">
          {/* Hero — a chain of real app logos ending in an "add" node. */}
          <div className="flex items-center justify-center">
            {FEATURED_APPS.slice(0, 3).map((a, i) => (
              <Fragment key={a.id}>
                {i > 0 && (
                  <span className="mx-1.5 h-0 w-8 border-t-2 border-dashed border-border/60" />
                )}
                <div
                  className={`flex items-center justify-center rounded-2xl border bg-card ${
                    i === 1
                      ? "size-16 border-primary/30 ring-4 ring-primary/5"
                      : "size-14 border-border/60"
                  }`}
                >
                  <AppLogo appId={a.id} icon={a.icon} className={i === 1 ? "size-8" : "size-7"} />
                </div>
              </Fragment>
            ))}
            <span className="mx-1.5 h-0 w-8 border-t-2 border-dashed border-border/60" />
            <div className="flex size-14 items-center justify-center rounded-2xl border border-dashed border-primary/40 bg-primary/5">
              <Plus className="size-6 text-primary" />
            </div>
          </div>

          <div className="mt-8 text-center">
            <h2
              className="text-2xl font-medium text-foreground/80"
              style={{ letterSpacing: "-0.2px" }}
            >
              {ap.emptyTitle}
            </h2>
            <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground/70">
              {ap.emptyDescription}
            </p>
            <Link
              href="/apps/new"
              className="mt-6 inline-flex items-center gap-2 rounded-xl bg-primary px-6 py-3 text-sm font-medium text-primary-foreground transition-all hover:bg-primary/90 hover:shadow-lg hover:shadow-primary/25 hover:-translate-y-0.5"
            >
              <Plus className="size-4" />
              {ap.createButton}
            </Link>
          </div>

          {/* Popular apps — tap to install (routes into the real flow). */}
          <div className="mx-auto mt-10 max-w-2xl">
            <p className="mb-4 text-xs uppercase tracking-wider text-muted-foreground/60">
              {ap.popular}
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {FEATURED_APPS.map((a) => {
                const enabled = isAppEnabled(a.id);
                return (
                  <button
                    key={a.id}
                    type="button"
                    disabled={!enabled}
                    aria-disabled={!enabled}
                    onClick={() => enabled && router.push(`/apps/new/${a.id}`)}
                    className={`group flex items-center gap-3 rounded-xl border border-border/50 bg-card p-4 text-left transition-all ${
                      enabled
                        ? "hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
                        : "cursor-not-allowed opacity-45 saturate-50"
                    }`}
                  >
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted/60">
                      <AppLogo appId={a.id} icon={a.icon} className="size-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-foreground">{a.name}</p>
                      <p className="truncate text-xs text-muted-foreground">{a.desc}</p>
                    </div>
                    {enabled ? (
                      <ArrowRight className="size-4 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-foreground" />
                    ) : (
                      <span className="shrink-0 rounded-full border border-border/60 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        {ap.comingSoon}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_340px]">
          {/* Left: installed apps */}
          <div className="min-w-0">
            <div className="bg-card rounded-2xl border border-border/50 divide-y divide-border/50">
              {apps.map((app) => (
                <ProjectCard
                  key={app.id}
                  project={app}
                  preferAppLogo
                  updateAvailable={updatesBehind.has(app.id)}
                  onChanged={load}
                />
              ))}
            </div>
          </div>

          {/* Right: catalog apps you can also deploy (excludes installed ones) */}
          {(() => {
            const installed = new Set(apps.map((a) => (a.name ?? "").toLowerCase()));
            // Only AVAILABLE apps — a "deploy this now" list shouldn't offer
            // "coming soon" placeholders you can't actually install.
            const suggestions = FEATURED_APPS.filter(
              (a) => isAppEnabled(a.id) && !installed.has(a.name.toLowerCase()),
            );
            return (
              <div className="lg:sticky lg:top-6 lg:self-start">
                <div className="bg-card rounded-2xl border border-border/50 p-5">
                  <p className="mb-4 text-xs uppercase tracking-wider text-muted-foreground/60">
                    {ap.alsoDeploy}
                  </p>
                  <div className="space-y-2">
                    {suggestions.map((a) => (
                      <button
                        key={a.id}
                        type="button"
                        onClick={() => router.push(`/apps/new/${a.id}`)}
                        className="group flex w-full items-center gap-3 rounded-xl border border-border/50 p-3 text-left transition-all hover:border-primary/40 hover:bg-muted/30"
                      >
                        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted/60">
                          <AppLogo appId={a.id} icon={a.icon} className="size-[18px]" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-[13px] font-medium text-foreground">{a.name}</p>
                          <p className="truncate text-[11px] text-muted-foreground">{a.desc}</p>
                        </div>
                        <ArrowRight className="size-4 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-foreground rtl:rotate-180" />
                      </button>
                    ))}
                  </div>
                  <Link
                    href="/apps/new"
                    className="mt-4 inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-muted/50 px-3.5 py-2 text-[13px] font-medium text-foreground transition-colors hover:bg-muted"
                  >
                    <Plus className="size-3.5" />
                    {ap.browseAll}
                  </Link>
                </div>
              </div>
            );
          })()}
        </div>
      )}
    </PageContainer>
  );
}
