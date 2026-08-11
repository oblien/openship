/**
 * i18n dictionary registry — scalable to many locales.
 *
 * Layout: `locales/<lang>/<namespace>.json`. The BASE locale (English) is
 * statically imported — it's the fallback and the source of the `Dictionary`
 * TYPE, and it renders instantly. Every OTHER locale is LAZY-loaded on demand
 * (`loadDictionary`), so adding languages never bloats the client bundle —
 * only the active locale's JSON chunks ship.
 *
 * Adding a language: add its code to `locales` (+ `rtlLocales` if RTL) and
 * drop a `locales/<code>/<namespace>.json` for each namespace. Nothing else.
 * Adding a namespace: create `locales/en/<ns>.json` (+ each other locale) and
 * import it into `en` below — the type + the lazy loader pick it up.
 */

import brand from "./locales/en/brand.json";
import auth from "./locales/en/auth.json";
import dashboard from "./locales/en/dashboard.json";
import settings from "./locales/en/settings.json";
import servers from "./locales/en/servers.json";
import billing from "./locales/en/billing.json";
import library from "./locales/en/library.json";
import onboarding from "./locales/en/onboarding.json";
import deploy from "./locales/en/deploy.json";
import deployments from "./locales/en/deployments.json";
import importProject from "./locales/en/importProject.json";
import projects from "./locales/en/projects.json";
import projectSettings from "./locales/en/projectSettings.json";
import projectDetail from "./locales/en/projectDetail.json";
import emails from "./locales/en/emails.json";
import emailsAdmin from "./locales/en/emailsAdmin.json";
import chrome from "./locales/en/chrome.json";
import overview from "./locales/en/overview.json";
import widgets from "./locales/en/widgets.json";
import misc from "./locales/en/misc.json";
import migration from "./locales/en/migration.json";
import jobs from "./locales/en/jobs.json";

/** The base (English) dictionary — bundled, used as the type + fallback. */
export const baseDictionary = { brand, auth, dashboard, settings, servers, billing, library, onboarding, deploy, deployments, importProject, projects, projectSettings, projectDetail, emails, emailsAdmin, chrome, overview, widgets, misc, migration, jobs };
export type Dictionary = typeof baseDictionary;

export const locales = ["en", "ar", "es", "fr", "de", "pt", "ja", "zh", "tr"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "en";
export const LOCALE_COOKIE = "openship-locale";

/** RTL languages. */
const rtlLocales = new Set<Locale>(["ar"]);
export function isRtl(locale: Locale): boolean {
  return rtlLocales.has(locale);
}

/** Namespaces derived from the base dictionary — the lazy loader mirrors these. */
const NAMESPACES = Object.keys(baseDictionary) as (keyof Dictionary)[];

/** Deep-merge `src` over `base`; `base` (English) fills any key `src` omits, so
 *  a partial/incomplete locale never renders a blank. */
function deepMerge<T>(base: T, src: unknown): T {
  if (src == null || typeof src !== "object" || Array.isArray(src)) {
    return (src ?? base) as T;
  }
  if (typeof base !== "object" || base == null || Array.isArray(base)) {
    return (src as T) ?? base;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
    out[k] = deepMerge((base as Record<string, unknown>)[k], v);
  }
  return out as T;
}

/**
 * Resolve a locale's dictionary. The base locale returns synchronously-bundled
 * data; other locales dynamically import their namespace JSON (separate lazy
 * chunks) and deep-merge over English so missing keys fall back cleanly.
 */
export async function loadDictionary(locale: Locale): Promise<Dictionary> {
  if (locale === defaultLocale) return baseDictionary;
  const parts = await Promise.all(
    NAMESPACES.map(async (ns) => {
      try {
        const mod = await import(`./locales/${locale}/${ns}.json`);
        return [ns, (mod as { default: unknown }).default] as const;
      } catch {
        return [ns, undefined] as const; // missing namespace file → English fallback
      }
    }),
  );
  const loaded = Object.fromEntries(parts.filter(([, v]) => v !== undefined));
  return deepMerge(baseDictionary, loaded);
}
