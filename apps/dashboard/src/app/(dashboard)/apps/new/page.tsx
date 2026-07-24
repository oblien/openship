"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, ArrowRight, Loader2, Search } from "lucide-react";
import { appsApi, type AppCatalogEntry } from "@/lib/api";
import { AppLogo } from "@/components/AppLogo";
import { useI18n } from "@/components/i18n-provider";
import { PageContainer } from "@/components/ui/PageContainer";

/**
 * Create App — the one-click catalog. Clicking an app opens its clean, business-
 * only install wizard (/apps/new/<id>), which creates the project on confirm and
 * wraps the deploy. Flow apps (mail) hand off to their own wizard.
 */

// Stable display order for the category tab bar; only categories actually
// present in the catalog are shown.
const CATEGORY_ORDER = ["backend", "database", "cms", "analytics", "automation", "mail", "other"] as const;

export default function NewAppPage() {
  const { t } = useI18n();
  const router = useRouter();
  const searchParams = useSearchParams();
  const ap = t.dashboard.pages.apps;

  const [catalog, setCatalog] = useState<AppCatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [installingId] = useState<string | null>(null);
  const autoStarted = useRef(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>("all");

  const categories = useMemo(() => {
    const present = new Set(catalog.map((a) => a.category));
    return ["all", ...CATEGORY_ORDER.filter((c) => present.has(c))];
  }, [catalog]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return catalog
      .filter((a) => {
        if (category !== "all" && a.category !== category) return false;
        if (!q) return true;
        return `${a.name} ${a.description} ${(a.tags ?? []).join(" ")}`.toLowerCase().includes(q);
      })
      // Installable apps lead (grouped up front), coming-soon after — a stable
      // sort keeps catalog order within each group.
      .sort((a, b) => Number(!!a.comingSoon) - Number(!!b.comingSoon));
  }, [catalog, category, query]);

  const catLabel = (c: string) =>
    (ap.categories as Record<string, string> | undefined)?.[c] ?? c;

  useEffect(() => {
    appsApi
      .catalog()
      .then((r) => setCatalog(r.data ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const install = (app: AppCatalogEntry) => {
    if (app.comingSoon) return;
    // Flow apps (mail) own a bespoke wizard.
    if (app.kind === "flow" && app.flowHref) {
      router.push(app.flowHref);
      return;
    }
    // Template apps → the clean, business-only install wizard. It creates the
    // project on confirm and wraps the deploy; the technical /deploy wizard is
    // its "Advanced" path. No install-on-click (avoids orphaned projects).
    router.push(`/apps/new/${app.id}`);
  };

  // Deep-link: /apps/new?app=<id> (from the Apps page "popular" / "you can also
  // deploy" tiles) lands the user straight on that app's flow — install →
  // deploy wizard, or a flow app's own wizard — instead of the generic catalog.
  // Fires once, after the catalog loads; unknown/coming-soon ids just fall
  // through to the catalog.
  useEffect(() => {
    if (autoStarted.current || loading) return;
    const wanted = searchParams.get("app");
    if (!wanted) return;
    const entry = catalog.find((a) => a.id === wanted);
    if (entry && !entry.comingSoon) {
      autoStarted.current = true;
      void install(entry);
    }
    // install is stable enough for this one-shot; the ref guards re-fires.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, catalog, searchParams]);

  return (
    <PageContainer outerClassName="pb-20">
      <button
        type="button"
        onClick={() => router.push("/apps")}
        className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        {ap.cancel}
      </button>

      <h1 className="text-2xl font-medium text-foreground/80" style={{ letterSpacing: "-0.2px" }}>
        {ap.catalogTitle}
      </h1>
      <p className="mt-1 text-sm text-muted-foreground/70">{ap.catalogDescription}</p>

      {/* Search + category tabs — the catalog at a glance. */}
      {!loading && catalog.length > 0 && (
        <div className="mt-6 space-y-4">
          <div className="relative max-w-md">
            <Search className="pointer-events-none absolute start-3.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={ap.catalogSearchPlaceholder}
              className="w-full ps-10 pe-4 py-2.5 bg-card border border-border/50 rounded-xl text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/20 transition-all"
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {categories.map((c) => {
              const on = category === c;
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCategory(c)}
                  className={`rounded-lg border px-3 py-1.5 text-[13px] font-medium capitalize transition-colors ${
                    on
                      ? "border-primary/40 bg-primary/[0.06] text-foreground"
                      : "border-border/60 text-muted-foreground hover:bg-muted/40"
                  }`}
                >
                  {catLabel(c)}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {loading ? (
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-2xl border border-border/50 bg-card" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="mt-4 rounded-2xl border border-border/50 bg-card px-5 py-12 text-center text-sm text-muted-foreground">
          {ap.catalogNoResults}
        </div>
      ) : (
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((app) => {
            const busy = installingId === app.id;
            return (
              <button
                key={app.id}
                type="button"
                disabled={!!installingId || app.comingSoon}
                aria-disabled={app.comingSoon}
                onClick={() => install(app)}
                className={`group flex items-start gap-3 rounded-2xl border border-border/50 bg-card p-5 text-left transition-all ${
                  app.comingSoon
                    ? "cursor-not-allowed opacity-45 saturate-50"
                    : "hover:border-primary/40 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-60"
                }`}
              >
                <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted/60">
                  <AppLogo appId={app.id} className="size-[22px]" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-foreground">{app.name}</span>
                    {app.comingSoon ? (
                      <span className="shrink-0 rounded-full border border-border/60 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        {ap.comingSoon}
                      </span>
                    ) : busy ? (
                      <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
                    ) : (
                      <ArrowRight className="size-4 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-foreground" />
                    )}
                  </div>
                  <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{app.description}</p>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </PageContainer>
  );
}
