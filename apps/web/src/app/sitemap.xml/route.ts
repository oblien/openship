import { SITE_URL, buildSitemapIndex, xmlResponse } from "@/lib/sitemap-builder";

export const dynamic = "force-static";
export const revalidate = 3600;

export function GET() {
  const xml = buildSitemapIndex([
    { loc: `${SITE_URL}/sitemaps/pages.xml` },
    { loc: `${SITE_URL}/sitemaps/docs.xml` },
    { loc: `${SITE_URL}/sitemaps/blog.xml` },
  ]);
  return xmlResponse(xml);
}
