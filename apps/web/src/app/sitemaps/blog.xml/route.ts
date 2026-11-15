import { languageAlternates, localizedHref, withoutLocale } from "@/i18n/routing";
import type { AppLocale } from "@repo/core/locale";
import { blogSource } from "@/lib/source";
import { SITE_URL, buildUrlset, xmlResponse, type SitemapEntry } from "@/lib/sitemap-builder";

export const dynamic = "force-static";
export const revalidate = 3600;

export function GET() {
  const now = new Date();
  const entries: SitemapEntry[] = blogSource.getPages().map((page) => {
    const data = page.data as { date?: string };
    return {
      loc: `${SITE_URL}${localizedHref(page.url, page.locale as AppLocale)}`,
      alternates: languageAlternates(withoutLocale(page.url)),
      lastmod: data.date ? new Date(data.date) : now,
      changefreq: "monthly",
      priority: 0.7,
    };
  });
  return xmlResponse(buildUrlset(entries));
}
