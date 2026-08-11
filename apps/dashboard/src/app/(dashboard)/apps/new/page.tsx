"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, ArrowRight, Loader2, Search, BookOpen, Plus, X } from "lucide-react";
import { appsApi, type AppCatalogEntry } from "@/lib/api";
import { getApiErrorMessage } from "@/lib/api/client";
import { AppLogo } from "@/components/AppLogo";
import { VerifiedBadge } from "@/components/apps/VerifiedBadge";
import { AddCustomAppModal } from "@/components/apps/AddCustomAppModal";
import { useI18n } from "@/components/i18n-provider";
import { useToast } from "@/context/ToastContext";
import { PageContainer } from "@/components/ui/PageContainer";
import { HelpMenu } from "@/components/HelpMenu";

/**
 * Create App — the one-click catalog. Clicking an app opens its clean, business-
 * only install wizard (/apps/new/<id>), which creates the project on confirm and
 * wraps the deploy. Flow apps (mail) hand off to their own wizard.
 */

// Stable display order for the category tab bar; only categories actually
// present in the catalog are shown.
const CATEGORY_ORDER = ["backend", "database", "cms", "analytics", "automation", "mail", "other"] as const;

/** Not installable right now: coming-soon OR needs a newer Openship. */
const isLocked = (a: AppCatalogEntry) => !!a.comingSoon || !!a.requiresUpdate;

export default function NewAppPage() {
  const { t } = useI18n();
  const router = useRouter();
  const { showToast } = useToast();
  const searchParams = useSearchParams();
  const ap = t.dashboard.pages.apps;

  const [catalog, setCatalog] = useState<AppCatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [installingId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const autoStarted = useRef(false);

  const loadCatalog = () =>
    appsApi
      .catalog()
      .then((r) => setCatalog(r.data ?? []))
      .catch(() => {});

  const removeCustomApp = async (app: AppCatalogEntry) => {
    try {
      await appsApi.removeCustom(app.id);
      await loadCatalog();
      showToast(`Removed "${app.name}".`, "success");
    } catch (err) {
      showToast(getApiErrorMessage(err, "Couldn't remove the app."), "error");
    }
  };
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
      // Installable apps lead (grouped up front); locked ones (coming-soon or
      // needs-newer-Openship) after — a stable sort keeps order within a group.
      .sort((a, b) => Number(isLocked(a)) - Number(isLocked(b)));
  }, [catalog, category, query]);

  const catLabel = (c: string) =>
    (ap.categories as Record<string, string> | undefined)?.[c] ?? c;

  useEffect(() => {
    loadCatalog().finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const install = (app: AppCatalogEntry) => {
    if (isLocked(app)) return;
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

      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-medium text-foreground/80" style={{ letterSpacing: "-0.2px" }}>
            {ap.catalogTitle}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground/70">{ap.catalogDescription}</p>
        </div>
        {/* Add-custom button + the 3-dots menu (guide / support). */}
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted/50"
          >
            <Plus className="size-4" /> Add custom
          </button>
          {/* The shared help menu, with this page's own guide link on top —
              so Support / Report issue / Docs read identically everywhere. */}
          <HelpMenu
            extraActions={[
              {
                id: "guide",
                label: "How to add an app",
                icon: <BookOpen className="size-4" />,
                onClick: () =>
                  window.open(
                    "https://github.com/oblien/openship/tree/main/packages/core/src/apps",
                    "_blank",
                    "noopener,noreferrer",
                  ),
              },
            ]}
          />
        </div>
      </div>

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
            const locked = isLocked(app);
            const needsUpdate = !!app.requiresUpdate;
            return (
              <div key={app.id} className="group relative">
                <button
                  type="button"
                  disabled={!!installingId || locked}
                  aria-disabled={locked}
                  onClick={() => install(app)}
                  className={`flex w-full items-start gap-3 rounded-2xl border border-border/50 bg-card p-5 text-left transition-all ${
                    locked
                      ? "cursor-not-allowed opacity-45 saturate-50"
                      : "hover:border-primary/40 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-60"
                  }`}
                >
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted/60">
                    <AppLogo appId={app.id} className="size-[22px]" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="inline-flex min-w-0 items-center gap-1.5 font-medium text-foreground">
                        <span className="truncate">{app.name}</span>
                        {app.verified && <VerifiedBadge className="shrink-0" />}
                      </span>
                      {needsUpdate ? (
                        <span className="shrink-0 rounded-full border border-warning/40 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-warning">
                          {app.requiresUpdate?.minVersion ? `Needs v${app.requiresUpdate.minVersion}` : "Needs update"}
                        </span>
                      ) : app.comingSoon ? (
                        <span className="shrink-0 rounded-full border border-border/60 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          {ap.comingSoon}
                        </span>
                      ) : app.custom ? (
                        <span className="shrink-0 rounded-full border border-warning/40 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-warning">
                          Unverified
                        </span>
                      ) : busy ? (
                        <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
                      ) : (
                        <ArrowRight className="size-4 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-foreground" />
                      )}
                    </div>
                    <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                      {needsUpdate
                        ? "Update your Openship instance to install this app."
                        : app.description}
                    </p>
                  </div>
                </button>
                {app.custom && (
                  <button
                    type="button"
                    title="Remove custom app"
                    aria-label="Remove custom app"
                    onClick={() => removeCustomApp(app)}
                    className="absolute end-2 top-2 rounded-md p-1 text-muted-foreground/50 opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus:opacity-100 group-hover:opacity-100"
                  >
                    <X className="size-3.5" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      <AddCustomAppModal open={addOpen} onClose={() => setAddOpen(false)} onAdded={() => void loadCatalog()} />
    </PageContainer>
  );
}
