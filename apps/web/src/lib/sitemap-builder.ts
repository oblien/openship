/**
 * Sitemap XML builders - shared by the index and every sub-sitemap.
 * Output is raw XML with a stylesheet directive so it renders as a
 * human-readable table in the browser while remaining valid for crawlers.
 */

export const SITE_URL = "https://openship.io";
export const STYLESHEET_PATH = "/sitemap.xsl";

export type SitemapEntry = {
  loc: string;
  alternates?: Record<string, string>;
  lastmod?: string | Date;
  changefreq?: "always" | "hourly" | "daily" | "weekly" | "monthly" | "yearly" | "never";
  priority?: number;
};

function isoDate(value: string | Date | undefined): string {
  if (!value) return new Date().toISOString();
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function buildUrlset(entries: SitemapEntry[]): string {
  const urls = entries
    .map((entry) => {
      const lines = [`  <url>`, `    <loc>${xmlEscape(entry.loc)}</loc>`];
      for (const [language, href] of Object.entries(entry.alternates ?? {})) {
        lines.push(
          `    <xhtml:link rel="alternate" hreflang="${xmlEscape(language)}" href="${xmlEscape(href)}" />`,
        );
      }
      if (entry.lastmod !== undefined) {
        lines.push(`    <lastmod>${isoDate(entry.lastmod)}</lastmod>`);
      }
      if (entry.changefreq) {
        lines.push(`    <changefreq>${entry.changefreq}</changefreq>`);
      }
      if (entry.priority !== undefined) {
        lines.push(`    <priority>${entry.priority.toFixed(2)}</priority>`);
      }
      lines.push(`  </url>`);
      return lines.join("\n");
    })
    .join("\n");

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<?xml-stylesheet type="text/xsl" href="${STYLESHEET_PATH}"?>`,
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"`,
    `        xmlns:xhtml="http://www.w3.org/1999/xhtml">`,
    urls,
    `</urlset>`,
  ].join("\n");
}

export type IndexEntry = {
  loc: string;
  lastmod?: string | Date;
};

export function buildSitemapIndex(entries: IndexEntry[]): string {
  const sitemaps = entries
    .map((entry) => {
      return [
        `  <sitemap>`,
        `    <loc>${xmlEscape(entry.loc)}</loc>`,
        `    <lastmod>${isoDate(entry.lastmod)}</lastmod>`,
        `  </sitemap>`,
      ].join("\n");
    })
    .join("\n");

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<?xml-stylesheet type="text/xsl" href="${STYLESHEET_PATH}"?>`,
    `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`,
    sitemaps,
    `</sitemapindex>`,
  ].join("\n");
}

export function xmlResponse(body: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
