import { SITE_URL, buildSitemapIndex, xmlResponse } from "@/lib/sitemap-builder";

export const dynamic = "force-static";
export const revalidate = 3600;

export function GET() {
  const now = new Date();
  const xml = buildSitemapIndex([
    { loc: `${SITE_URL}/sitemaps/pages.xml`, lastmod: now },
    { loc: `${SITE_URL}/sitemaps/docs.xml`, lastmod: now },
    { loc: `${SITE_URL}/sitemaps/blog.xml`, lastmod: now },
  ]);
  return xmlResponse(xml);
}
