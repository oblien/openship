"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  Search,
  X,
  Layers,
  Database,
  PenLine,
  Mail,
  ChartNoAxesColumn,
  Workflow,
  Blocks,
  Cpu,
} from "lucide-react";
import {
  APP_CATEGORY_LABELS,
  filterMarketplaceApps,
  type MarketplaceApp,
} from "@/lib/app-marketplace";
import { MarketplaceLogo } from "./marketplace-logo";

const categoryIcons = {
  backend: Layers,
  database: Database,
  cms: PenLine,
  mail: Mail,
  analytics: ChartNoAxesColumn,
  automation: Workflow,
  ai: Cpu,
  other: Blocks,
};
const categories = Object.keys(APP_CATEGORY_LABELS) as Array<keyof typeof APP_CATEGORY_LABELS>;
const categoryValue = (value: string | null) =>
  value && categories.includes(value as (typeof categories)[number]) ? value : "all";

export function AppDirectory({
  apps,
  initialCategory = "all",
  initialQuery = "",
}: {
  apps: MarketplaceApp[];
  initialCategory?: string;
  initialQuery?: string;
}) {
  const [category, setCategory] = useState(categoryValue(initialCategory));
  const [query, setQuery] = useState(initialQuery);
  const directoryRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const restore = () => {
      const params = new URLSearchParams(window.location.search);
      setCategory(categoryValue(params.get("category")));
      setQuery((params.get("q") ?? "").slice(0, 200));
    };
    restore();
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);
  const updateUrl = (nextCategory: string, nextQuery: string) => {
    const url = new URL(window.location.href);
    if (nextCategory === "all") url.searchParams.delete("category");
    else url.searchParams.set("category", nextCategory);
    if (!nextQuery.trim()) url.searchParams.delete("q");
    else url.searchParams.set("q", nextQuery);
    window.history.replaceState(null, "", url);
  };
  const chooseCategory = (value: string) => {
    const directory = directoryRef.current;
    const returnToResults =
      directory &&
      directory.getBoundingClientRect().top <
        parseFloat(getComputedStyle(directory).scrollMarginTop);
    setCategory(value);
    updateUrl(value, query);
    if (returnToResults) {
      requestAnimationFrame(() =>
        directoryRef.current?.scrollIntoView({ block: "start", behavior: "instant" }),
      );
    }
  };
  const search = (value: string) => {
    setQuery(value);
    updateUrl(category, value);
  };
  const reset = () => {
    setQuery("");
    setCategory("all");
    updateUrl("all", "");
  };
  const visible = filterMarketplaceApps(apps, category, query);

  return (
    <div className="marketplace-directory" ref={directoryRef}>
      <aside className="marketplace-categories">
        <p className="marketplace-label">Browse by category</p>
        <div className="marketplace-category-list" role="group" aria-label="App categories">
          <button
            className="marketplace-category"
            type="button"
            aria-pressed={category === "all"}
            onClick={() => chooseCategory("all")}
          >
            <Blocks size={16} aria-hidden="true" />
            <span>All apps</span>
            <span className="marketplace-count">{apps.length}</span>
          </button>
          {categories.map((value) => {
            const count = apps.filter((app) => app.category === value).length;
            if (!count) return null;
            const Icon = categoryIcons[value];
            return (
              <button
                key={value}
                type="button"
                className="marketplace-category"
                aria-pressed={category === value}
                onClick={() => chooseCategory(value)}
              >
                <Icon size={16} aria-hidden="true" />
                <span>{APP_CATEGORY_LABELS[value]}</span>
                <span className="marketplace-count">{count}</span>
              </button>
            );
          })}
        </div>
        <div className="marketplace-contribute">
          <p className="th-text-heading text-sm font-medium">Missing an app?</p>
          <p className="mt-2 text-sm leading-relaxed th-text-muted">
            Bring a template you use. One catalog entry makes it available to everyone.
          </p>
          <Link
            href="/docs/guides/add-an-app"
            className="mt-3 inline-flex items-center gap-1 text-sm th-text-strong"
          >
            Add a template <ArrowUpRight size={15} />
          </Link>
        </div>
      </aside>
      <section className="min-w-0" aria-label="App directory">
        <div className="marketplace-toolbar">
          <p className="text-sm th-text-secondary" role="status" aria-live="polite">
            {visible.length} {visible.length === 1 ? "app" : "apps"}
            {category !== "all"
              ? ` in ${APP_CATEGORY_LABELS[category as keyof typeof APP_CATEGORY_LABELS]}`
              : " to explore"}
          </p>
          <div className="marketplace-search">
            <Search size={17} aria-hidden="true" />
            <input
              aria-label="Search apps"
              type="search"
              maxLength={200}
              value={query}
              onChange={(event) => search(event.target.value)}
              placeholder="Search apps, features, or tools…"
            />
            {query && (
              <button type="button" onClick={() => search("")} aria-label="Clear search">
                <X size={15} />
              </button>
            )}
          </div>
        </div>
        {visible.length ? (
          <div className="marketplace-grid">
            {visible.map((app) => (
              <Link href={`/apps/${app.id}`} key={app.id} className="marketplace-card group">
                <div className="flex items-center justify-between gap-3">
                  <MarketplaceLogo id={app.id} logo={app.logo} name={app.name} />
                  {!app.available && <span className="marketplace-badge">Coming soon</span>}
                  {app.available && app.experimental && (
                    <span className="marketplace-badge">Experimental</span>
                  )}
                  {app.available && !app.experimental && (
                    <ArrowUpRight size={18} className="marketplace-card-arrow" aria-hidden="true" />
                  )}
                </div>
                <h2 className="mt-5 text-lg font-medium tracking-tight th-text-heading">
                  {app.name}
                </h2>
                {(app.gpu || !app.supportsCloud) && <p className="mt-2 text-xs th-text-muted">
                  {[app.gpu === "required" ? "NVIDIA GPU required" : app.gpu === "recommended" ? "GPU recommended" : null, !app.supportsCloud ? "Self-hosted only" : null].filter(Boolean).join(" · ")}
                </p>}
                <p className="mt-2 line-clamp-3 text-sm leading-relaxed th-text-secondary">
                  {app.description}
                </p>
                <div className="marketplace-card-bottom">
                  <span className="truncate text-xs th-text-muted">
                    {APP_CATEGORY_LABELS[app.category]}
                  </span>
                  <span className="shrink-0 text-xs font-medium th-text-strong">Explore app</span>
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <div className="marketplace-empty">
            <Search size={26} className="th-text-muted" aria-hidden="true" />
            <h2 className="mt-4 text-lg font-medium th-text-heading">No apps found</h2>
            <p className="mt-2 text-sm th-text-secondary">Try another name or category.</p>
            <button type="button" className="marketplace-secondary mt-5" onClick={reset}>
              Clear filters
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
