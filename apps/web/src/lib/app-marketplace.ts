import type { AppCategory, AppTemplate } from "@repo/core";
import { safeAppContentUrl } from "./app-content-url";

export const APP_CATEGORY_LABELS: Record<AppCategory, string> = {
  backend: "Backends",
  database: "Databases",
  cms: "Content & publishing",
  mail: "Email",
  analytics: "Analytics",
  automation: "Automation",
  ai: "AI & models",
  other: "Developer tools",
};

export interface MarketplaceApp {
  id: string;
  name: string;
  description: string;
  logo: string;
  category: AppCategory;
  tags: readonly string[];
  available: boolean;
  experimental: boolean;
  kind: AppTemplate["kind"];
  repository?: string;
  minEngine?: string;
  minResources?: AppTemplate["minResources"];
  gpu?: AppTemplate["gpu"];
  supportsCloud: boolean;
  features: NonNullable<NonNullable<AppTemplate["marketplace"]>["features"]>;
  article?: string;
  services: { name: string; image?: string; persistent: boolean }[];
}

/** Only public presentation data crosses into the website's client components. */
export function marketplaceEntries(templates: readonly AppTemplate[]): MarketplaceApp[] {
  return templates
    .filter((app) => !app.unlisted && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(app.id))
    .map((app) => ({
      id: app.id,
      name: app.name,
      description: app.description,
      logo: app.logo,
      category: app.category,
      tags: app.tags ?? [],
      available: app.available === true,
      experimental: app.hosting === "experimental",
      kind: app.kind,
      repository: app.repository ? (safeAppContentUrl(app.repository) ?? undefined) : undefined,
      minEngine: app.minEngine,
      minResources: app.minResources,
      gpu: app.gpu,
      supportsCloud: app.supportsCloud !== false,
      features: app.marketplace?.features ?? [],
      article: app.marketplace?.article,
      services: (app.services ?? []).map((service) => ({
        name: service.name,
        image: service.image,
        persistent: Boolean(service.volumes?.length),
      })),
    }));
}

export function filterMarketplaceApps(
  apps: readonly MarketplaceApp[],
  category: string,
  query: string,
) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return apps.filter((app) => {
    if (category !== "all" && app.category !== category) return false;
    const text = [
      app.name,
      app.description,
      APP_CATEGORY_LABELS[app.category],
      ...app.tags,
      ...app.features.map((feature) => `${feature.title} ${feature.description ?? ""}`),
    ]
      .join(" ")
      .toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });
}
