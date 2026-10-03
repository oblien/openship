"use client";

import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import { Icon } from "@repo/ui/icons";
import ProjectCard from "./components/ProjectCard";
import ProjectGridCard from "./components/ProjectGridCard";
import { ViewToggle, type ProjectView } from "./components/ViewToggle";
import { ProjectFilters, buildProjectFilterOptions, projectMatchesFilter, type ProjectFilter } from "./components/ProjectFilters";
import EmptyState from "@/components/overview/EmptyState";
import { ProjectIllustration } from "@/components/overview/ProjectIllustration";
import { useDashboardHome } from "@/hooks/useDashboardHome";
import { updatesApi } from "@/lib/api/updates";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { PageContainer } from "@/components/ui/PageContainer";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { HelpMenu } from "@/components/HelpMenu";
import { usePlatform } from "@/context/PlatformContext";

export default function ProjectsPage() {
  const { t } = useI18n();
  const { selfHosted } = usePlatform();
  const { projects: allProjects, loading, removeProject } = useDashboardHome();
  const projects = useMemo(
    () => allProjects.filter(project => !project.isApp),
    [allProjects],
  );
  const copy = t.dashboard.pages.projects;
  const countCopy = t.projects.list;
  const searchLabel = copy.searchPlaceholder;
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ProjectFilter>({ kind: "all" });
  const [view, setView] = useState<ProjectView>("grid");
  const [updatesBehind, setUpdatesBehind] = useState<Set<string>>(new Set());
  const viewKey = "openship-projects-view";

  // Read after hydration so the server and initial client render agree.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(viewKey);
      if (saved === "grid" || saved === "list") setView(saved);
    } catch { /* Preferences are optional. */ }
  }, [viewKey]);
  const changeView = (next: ProjectView) => {
    setView(next);
    try { localStorage.setItem(viewKey, next); } catch { /* Preferences are optional. */ }
  };

  useEffect(() => {
    let cancelled = false;
    updatesApi.list(true)
      .then(response => {
        if (!cancelled) setUpdatesBehind(new Set(response.data.map(update => update.projectId)));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const filters = useMemo(
    () => buildProjectFilterOptions(projects, t),
    [projects, t],
  );
  const showFilters = filters.length > 1;
  const showServerCta = selfHosted && !projects.some(project => project.deployTarget === "server");
  const showSidebar = showFilters || showServerCta;
  const filtered = projects.filter(project =>
    projectMatchesFilter(project, filter) &&
    [project.name, project.slug, project.framework].some(value => value?.toLowerCase().includes(search.toLowerCase())),
  );

  return (
    <PageContainer outerClassName="pb-20" className="@container/project-collection">
      <header className="mb-6 flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-2xl font-medium tracking-tight text-foreground">{copy.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {loading ? countCopy.loading : interpolate(projects.length === 1 ? countCopy.countOne : countCopy.countOther, { count: String(projects.length) })}
          </p>
        </div>
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <Button asChild className="flex-1 sm:flex-none">
            <Link href="/library"><Icon name="plus" className="size-4" />{copy.createButton}</Link>
          </Button>
          <HelpMenu />
        </div>
      </header>

      {loading ? (
        <div className="divide-y divide-border/50 rounded-2xl bg-card" aria-busy="true">
          {Array.from({ length: 5 }, (_, index) => (
            <div key={index} className="flex animate-pulse items-center gap-4 px-5 py-4">
              <div className="size-10 rounded-xl bg-muted" />
              <div className="flex-1 space-y-2"><div className="h-4 w-32 rounded-lg bg-muted" /><div className="h-3 w-48 max-w-full rounded-lg bg-muted/60" /></div>
              <div className="h-6 w-16 rounded-full bg-muted/60" />
            </div>
          ))}
        </div>
      ) : projects.length === 0 ? (
        <EmptyState />
      ) : (
        <div className={`grid grid-cols-1 gap-x-6 gap-y-4 ${showSidebar ? "@min-[60rem]/project-collection:grid-cols-[minmax(0,1fr)_340px]" : ""}`}>
          <div className="flex min-w-0 items-center gap-3 @min-[60rem]/project-collection:col-start-1 @min-[60rem]/project-collection:row-start-1">
            <div className="relative min-w-0 flex-1">
              <Icon name="search" className="pointer-events-none absolute start-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input variant="filled" type="search" placeholder={searchLabel} aria-label={searchLabel} value={search} onChange={event => setSearch(event.target.value)} className="h-10 bg-muted/60 ps-10 pe-4" />
            </div>
            <ViewToggle value={view} onChange={changeView} />
          </div>

          <div className="min-w-0 @min-[60rem]/project-collection:col-start-1 @min-[60rem]/project-collection:row-start-2">
            {filtered.length > 0 ? (
              view === "grid" ? (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,20rem),1fr))] gap-3">
                  {filtered.map(project => <ProjectGridCard key={project.id} project={project} preferAppLogo updateAvailable={updatesBehind.has(project.id)} />)}
                </div>
              ) : (
                <div className="divide-y divide-border/50 rounded-2xl bg-card">
                  {filtered.map(project => <ProjectCard key={project.id} project={project} preferAppLogo updateAvailable={updatesBehind.has(project.id)} onChanged={() => removeProject(project.id)} />)}
                </div>
              )
            ) : (
              <div className="flex min-h-80 flex-col items-center justify-center px-6 py-12 text-center">
                <ProjectIllustration className="relative mx-auto mb-6 h-40 w-56" />
                {search ? (
                  <p className="max-w-sm text-sm text-muted-foreground">{interpolate(copy.noResultsFound, { query: search })}</p>
                ) : (
                  <>
                    <h2 className="mb-2 text-xl font-medium text-foreground">{t.projects.list.noTargetProjects}</h2>
                    <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">{t.projects.list.noTargetDesc}</p>
                  </>
                )}
              </div>
            )}
          </div>

          {showSidebar && (
            <aside className="space-y-4 @min-[60rem]/project-collection:col-start-2 @min-[60rem]/project-collection:row-span-2 @min-[60rem]/project-collection:row-start-1 @min-[60rem]/project-collection:sticky @min-[60rem]/project-collection:top-6 @min-[60rem]/project-collection:self-start">
              {showFilters && <ProjectFilters options={filters} active={filter} onChange={setFilter} />}
              {showServerCta && (
                <div className="rounded-2xl bg-card p-5">
                  <Icon name="server" className="mb-3 size-5 text-muted-foreground" />
                  <h2 className="text-sm font-medium text-foreground">{t.projects.serverCta.title}</h2>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{t.projects.serverCta.description}</p>
                  <Button asChild variant="secondary" size="sm" className="mt-3">
                    <Link href="/servers/new"><Icon name="plus" className="size-4" />{t.projects.serverCta.button}</Link>
                  </Button>
                </div>
              )}
            </aside>
          )}
        </div>
      )}
    </PageContainer>
  );
}
