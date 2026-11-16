import { SITE_URL, buildUrlset, xmlResponse, type SitemapEntry } from "@/lib/sitemap-builder";
import { getMarketplaceApps } from "@/lib/app-catalog";
import { getChangelog } from "@/lib/changelog";
import { FEATURES } from "@/lib/features";
import { COMPARISONS, COMPARISONS_REVIEWED_AT } from "@/lib/comparisons";
import { MIGRATION_SOURCES } from "@/lib/migration-sources";
import { APP_LOCALES } from "@repo/core";
import { isLocalizedPath, languageAlternates, localizedHref } from "@/i18n/routing";

export const dynamic = "force-static";
export const revalidate = 3600;

export async function GET() {
  const entries: SitemapEntry[] = [
    { loc: `${SITE_URL}/`, changefreq: "daily", priority: 1.0 },
    { loc: `${SITE_URL}/pricing`, changefreq: "weekly", priority: 0.95 },
    {
      loc: `${SITE_URL}/compare`,
      lastmod: COMPARISONS_REVIEWED_AT,
      changefreq: "monthly",
      priority: 0.85,
    },
    { loc: `${SITE_URL}/sla`, lastmod: "2026-11-16", changefreq: "yearly", priority: 0.5 },
    { loc: `${SITE_URL}/migrate/from-git`, changefreq: "monthly", priority: 0.8 },
    { loc: `${SITE_URL}/migrate`, changefreq: "monthly", priority: 0.85 },
    { loc: `${SITE_URL}/referrals`, changefreq: "monthly", priority: 0.8 },
    { loc: `${SITE_URL}/mail`, changefreq: "weekly", priority: 0.9 },
    { loc: `${SITE_URL}/apps`, changefreq: "weekly", priority: 0.9 },
    { loc: `${SITE_URL}/download`, changefreq: "weekly", priority: 0.9 },
    { loc: `${SITE_URL}/blog`, changefreq: "daily", priority: 0.85 },
    { loc: `${SITE_URL}/features`, changefreq: "weekly", priority: 0.9 },
    { loc: `${SITE_URL}/changelog`, changefreq: "weekly", priority: 0.85 },
    { loc: `${SITE_URL}/privacy`, changefreq: "yearly", priority: 0.3 },
    { loc: `${SITE_URL}/terms`, changefreq: "yearly", priority: 0.3 },
    { loc: `${SITE_URL}/support`, changefreq: "monthly", priority: 0.6 },
    { loc: `${SITE_URL}/about`, changefreq: "monthly", priority: 0.6 },
    { loc: `${SITE_URL}/trust`, changefreq: "monthly", priority: 0.6 },
    { loc: `${SITE_URL}/contact`, changefreq: "monthly", priority: 0.4 },
  ];
  entries.push(
    ...["ios", "android", "desktop", "nodemailer"].map((client) => ({
      loc: `${SITE_URL}/mail/setup-guide/${client}`,
      changefreq: "monthly" as const,
      priority: 0.6,
    })),
    ...(await getChangelog()).map((release) => ({
      loc: `${SITE_URL}/changelog/${release.slug}`,
      lastmod: release.date,
      changefreq: "monthly" as const,
      priority: 0.7,
    })),
    ...COMPARISONS.map(({ slug }) => ({
      loc: `${SITE_URL}/compare/${slug}`,
      lastmod: COMPARISONS_REVIEWED_AT,
      changefreq: "monthly" as const,
      priority: 0.8,
    })),
    ...MIGRATION_SOURCES.map((source) => ({
      loc: `${SITE_URL}/migrate/${source.slug}`,
      changefreq: "monthly" as const,
      priority: 0.85,
    })),
    ...FEATURES.map((feature) => ({
      loc: `${SITE_URL}/features/${feature.slug}`,
      changefreq: "weekly" as const,
      priority: 0.75,
    })),
  );
  entries.push(
    ...(await getMarketplaceApps()).map((app) => ({
      loc: `${SITE_URL}/apps/${app.id}`,
      changefreq: "weekly" as const,
      priority: 0.75,
    })),
  );
  const localized = entries.flatMap((entry) => {
    const pathname = new URL(entry.loc).pathname;
    if (!isLocalizedPath(pathname)) return [entry];
    return APP_LOCALES.map((locale) => ({
      ...entry,
      loc: SITE_URL + localizedHref(pathname, locale),
      alternates: languageAlternates(pathname),
    }));
  });
  return xmlResponse(buildUrlset(localized));
}
