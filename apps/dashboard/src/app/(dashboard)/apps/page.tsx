"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Icon } from "@repo/ui/icons";
import { AppLogo } from "@/components/AppLogo";
import { HelpMenu } from "@/components/HelpMenu";
import { useI18n, interpolate } from "@/components/i18n-provider";
import HomeAppsIllustration from "@/components/overview/HomeAppsIllustration";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageContainer } from "@/components/ui/PageContainer";
import { useDashboardHome } from "@/hooks/useDashboardHome";
import { appsApi, type AppCatalogEntry } from "@/lib/api";
import { updatesApi } from "@/lib/api/updates";
import ProjectCard from "../projects/components/ProjectCard";

// Keep the original showcase order; availability and app details come from the catalog.
const FEATURED_APP_IDS = [
  "supabase", "convex", "mongodb", "neon", "mail",
  "ghost", "uptime-kuma", "vaultwarden", "metabase",
];
const SIDEBAR_SUGGESTION_LIMIT = 3;

function CatalogShortcut({ app, compact = false }: { app: AppCatalogEntry; compact?: boolean }) {
  return (
    <Link
      href={`/apps/new?app=${encodeURIComponent(app.id)}`}
      title={compact ? app.description : undefined}
      className={`group flex min-w-0 items-center gap-3 rounded-xl bg-card text-start transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${compact ? "px-3 py-2.5" : "p-4"}`}
    >
      <div className={`flex shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted/60 ${compact ? "size-8" : "size-10"}`}>
        <AppLogo appId={app.id} className={compact ? "size-5" : "size-6"} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{app.name}</p>
        {!compact && <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{app.description}</p>}
      </div>
      <Icon name="arrow-right" className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground rtl:rotate-180" />
    </Link>
  );
}

function CatalogSkeleton({ count = 5, compact = false }: { count?: number; compact?: boolean }) {
  return (
    <>
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className={`flex animate-pulse items-center gap-3 rounded-xl bg-card ${compact ? "px-3 py-2.5" : "p-4"}`} aria-hidden="true">
          <div className={`shrink-0 rounded-lg bg-muted ${compact ? "size-8" : "size-10"}`} />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="h-4 w-24 max-w-full rounded bg-muted" />
            {!compact && <div className="h-3 w-40 max-w-full rounded bg-muted/60" />}
          </div>
        </div>
      ))}
    </>
  );
}

export default function AppsPage() {
  const { t } = useI18n();
  const copy = t.dashboard.pages.apps;
  const { projects, loading, removeProject } = useDashboardHome();
  const apps = useMemo(() => projects.filter(project => project.isApp), [projects]);
  const [catalog, setCatalog] = useState<AppCatalogEntry[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [updatesBehind, setUpdatesBehind] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");

  useEffect(() => {
    let cancelled = false;
    appsApi.catalog()
      .then(response => { if (!cancelled) setCatalog(response.data ?? []); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setCatalogLoading(false); });
    updatesApi.list(true)
      .then(response => {
        if (!cancelled) setUpdatesBehind(new Set(response.data.map(update => update.projectId)));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const availableCatalog = useMemo(() => {
    const priority = new Map(FEATURED_APP_IDS.map((id, index) => [id, index]));
    return catalog
      .filter(app => !app.custom && !app.comingSoon && !app.requiresUpdate)
      .sort((a, b) => (priority.get(a.id) ?? priority.size) - (priority.get(b.id) ?? priority.size));
  }, [catalog]);
  const installed = new Set(apps.map(app => app.appTemplateId));
  const suggestions = availableCatalog.filter(app => !installed.has(app.id)).slice(0, 5);
  const query = search.trim().toLowerCase();
  const filteredApps = apps.filter(app =>
    [app.name, app.slug, app.appTemplateId].some(value => value?.toLowerCase().includes(query)),
  );
  const remainingApps = availableCatalog.length - suggestions.length;

  return (
    <PageContainer outerClassName="pb-20" className="@container/apps-page">
      <header className="mb-6 flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-2xl font-medium tracking-tight text-foreground">{copy.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {loading ? copy.loading : interpolate(apps.length === 1 ? copy.countOne : copy.countOther, { count: String(apps.length) })}
          </p>
        </div>
        <div className="flex w-full items-center gap-2 sm:w-auto">
          {apps.length > 0 && (
            <Button asChild className="flex-1 sm:flex-none">
              <Link href="/apps/new"><Icon name="plus" className="size-4" />{copy.createButton}</Link>
            </Button>
          )}
          <HelpMenu className="ms-auto sm:ms-0" />
        </div>
      </header>

      {loading ? (
        <div className="divide-y divide-border/50 rounded-2xl bg-card" aria-busy="true" aria-label={copy.loading}>
          {Array.from({ length: 3 }, (_, index) => (
            <div key={index} className="flex animate-pulse items-center gap-4 px-5 py-4" aria-hidden="true">
              <div className="size-10 shrink-0 rounded-xl bg-muted" />
              <div className="min-w-0 flex-1 space-y-2">
                <div className="h-4 w-32 max-w-full rounded-lg bg-muted" />
                <div className="h-3 w-48 max-w-full rounded-lg bg-muted/60" />
              </div>
            </div>
          ))}
        </div>
      ) : apps.length === 0 ? (
        <div className="py-8 sm:py-12">
          <div className="flex items-center justify-center" aria-hidden="true">
            {FEATURED_APP_IDS.slice(0, 3).map((id, index) => (
              <Fragment key={id}>
                {index > 0 && <span className="mx-1.5 w-4 border-t-2 border-dashed border-border sm:w-8" />}
                <div className={`flex shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-card ${index === 1 ? "size-16 ring-4 ring-primary/10" : "size-14"}`}>
                  <AppLogo appId={id} className={index === 1 ? "size-8" : "size-7"} />
                </div>
              </Fragment>
            ))}
            <span className="mx-1.5 w-4 border-t-2 border-dashed border-border sm:w-8" />
            <div className="flex size-14 shrink-0 items-center justify-center rounded-2xl border border-dashed border-primary/40 bg-primary/5">
              <Icon name="plus" className="size-6 text-primary" />
            </div>
          </div>
          <div className="mt-8 text-center">
            <h2 className="text-2xl font-medium tracking-tight text-foreground">{copy.emptyTitle}</h2>
            <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">{copy.emptyDescription}</p>
            <Button asChild className="mt-6">
              <Link href="/apps/new"><Icon name="plus" className="size-4" />{copy.createButton}</Link>
            </Button>
          </div>

          {(catalogLoading || suggestions.length > 0) && (
            <section className="mx-auto mt-10 max-w-2xl" aria-labelledby="popular-apps">
              <h2 id="popular-apps" className="mb-4 text-sm font-medium text-muted-foreground">{copy.popular}</h2>
              <div className="grid grid-cols-1 gap-3 @xl/apps-page:grid-cols-2" aria-busy={catalogLoading}>
                {catalogLoading ? <CatalogSkeleton /> : suggestions.map(app => <CatalogShortcut key={app.id} app={app} />)}
                <Link href="/apps/new" className="group flex items-center gap-3 rounded-xl bg-muted/40 p-4 transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted/60">
                    <Icon name="plus" className="size-5 text-muted-foreground" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground">{copy.browseAll}</p>
                    {!catalogLoading && remainingApps > 0 && (
                      <p className="mt-0.5 text-xs text-muted-foreground">{interpolate(copy.moreApps, { count: String(remainingApps) })}</p>
                    )}
                  </div>
                  <Icon name="arrow-right" className="size-4 shrink-0 text-muted-foreground rtl:rotate-180" />
                </Link>
              </div>
            </section>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 items-start gap-6 @min-[60rem]/apps-page:grid-cols-[minmax(0,1fr)_340px]">
          <section className="min-w-0 space-y-4" aria-label={copy.title}>
            <div className="relative">
              <Icon name="search" className="pointer-events-none absolute start-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input variant="filled" type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder={copy.catalogSearchPlaceholder} aria-label={copy.catalogSearchPlaceholder} className="h-10 bg-muted/60 ps-10 pe-4" />
            </div>
            <div className="divide-y divide-border/50 rounded-2xl bg-card">
              {filteredApps.length > 0 ? filteredApps.map(app => (
                <ProjectCard key={app.id} project={app} preferAppLogo updateAvailable={updatesBehind.has(app.id)} onChanged={() => removeProject(app.id)} />
              )) : (
                <p className="px-5 py-12 text-center text-sm text-muted-foreground">{copy.catalogNoResults}</p>
              )}
            </div>
          </section>

          <aside className="rounded-2xl bg-card p-5 @min-[60rem]/apps-page:sticky @min-[60rem]/apps-page:top-6" aria-labelledby="suggested-apps">
            <h2 id="suggested-apps" className="mb-4 text-sm font-medium text-foreground">{copy.alsoDeploy}</h2>
            <div className="mb-4"><HomeAppsIllustration /></div>
            <div className="space-y-2" aria-busy={catalogLoading}>
              {catalogLoading ? <CatalogSkeleton count={SIDEBAR_SUGGESTION_LIMIT} compact /> : suggestions.slice(0, SIDEBAR_SUGGESTION_LIMIT).map(app => <CatalogShortcut key={app.id} app={app} compact />)}
              {!catalogLoading && suggestions.length === 0 && <p className="text-center text-sm text-muted-foreground">{copy.emptyDescription}</p>}
            </div>
            <Button asChild variant="secondary" className="mt-4 w-full">
              <Link href="/apps/new">{copy.browseAll}<Icon name="arrow-right" className="size-4 rtl:rotate-180" /></Link>
            </Button>
          </aside>
        </div>
      )}
    </PageContainer>
  );
}
