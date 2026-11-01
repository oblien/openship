import { cache } from "react";
import { APP_CATALOG_URL, APP_TEMPLATES, parseAppTemplate, type AppTemplate } from "@repo/core";
import { marketplaceEntries, type MarketplaceApp } from "./app-marketplace";
import { reportCaughtError } from "@repo/core/diagnostics";

export function mergePublishedCatalog(raw: unknown): AppTemplate[] {
  if (
    !raw ||
    typeof raw !== "object" ||
    !("apps" in raw) ||
    !Array.isArray(raw.apps) ||
    raw.apps.length > 500
  )
    throw new Error("Invalid app catalog envelope");
  const merged = new Map(APP_TEMPLATES.map((app) => [app.id, app]));
  const seen = new Set<string>();
  for (const entry of raw.apps) {
    if (!parseAppTemplate(entry).ok) continue;
    const app = entry as AppTemplate;
    if (seen.has(app.id)) throw new Error("Duplicate app in catalog");
    seen.add(app.id);
    merged.set(app.id, app);
  }
  return [...merged.values()];
}

/** Bundled edits in dev; the same published artifact as the installer in production. */
export const getMarketplaceApps = cache(async (): Promise<MarketplaceApp[]> => {
  if (process.env.NODE_ENV === "development") return marketplaceEntries(APP_TEMPLATES);
  try {
    const response = await fetch(APP_CATALOG_URL, {
      next: { revalidate: 600, tags: ["app-catalog"] },
      signal: AbortSignal.timeout(6_000),
    });
    if (!response.ok) throw new Error(`App catalog returned HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > 2_000_000) throw new Error("App catalog exceeds the supported size");
    return marketplaceEntries(mergePublishedCatalog(JSON.parse(text)));
  } catch (error) {
    reportCaughtError(error, "web/lib/app-catalog");
    return marketplaceEntries(APP_TEMPLATES);
  }
});
