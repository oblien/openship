import { localizedHref } from "@/i18n/routing";
import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import { createCopy } from "@/i18n/copy";
import { routing } from "@/i18n/routing";
import { blogSource, type BlogFrontmatter } from "@/lib/source";

export const dynamic = "force-static";
export const revalidate = 3600;
const SITE_URL = "https://openship.io";

function escapeXml(value: string): string {
  return value.replace(
    /[<>&"']/g,
    (character) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
      })[character]!,
  );
}

export async function GET(_request: Request, { params }: { params: Promise<{ locale: string }> }) {
  const { locale: requested } = await params;
  const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale;
  const copy = createCopy(await getTranslations({ locale, namespace: "Copy" }));
  const blogUrl = SITE_URL + localizedHref("/blog", locale);
  const feedUrl = SITE_URL + localizedHref("/blog/rss.xml", locale);
  const posts = (blogSource.getPages(locale) as unknown as { url: string; data: BlogFrontmatter }[])
    .slice()
    .sort((a, b) => (b.data.date ?? "").localeCompare(a.data.date ?? ""));
  const items = posts
    .map((post) => {
      const date = post.data.date ? new Date(post.data.date) : null;
      const url = escapeXml(`${SITE_URL}${localizedHref(post.url, locale)}`);
      return `<item><title>${escapeXml(post.data.title)}</title><link>${url}</link><guid isPermaLink="true">${url}</guid><description>${escapeXml(post.data.description ?? "")}</description>${date && Number.isFinite(date.getTime()) ? `<pubDate>${date.toUTCString()}</pubDate>` : ""}</item>`;
    })
    .join("\n");
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>${escapeXml(copy("OpenShip Blog"))}</title><link>${blogUrl}</link><description>${escapeXml(copy("Engineering, product updates, and guides from OpenShip."))}</description><language>${locale}</language><atom:link href="${feedUrl}" rel="self" type="application/rss+xml"/>${items}</channel></rss>`,
    {
      headers: {
        "Content-Type": "application/rss+xml; charset=utf-8",
        "Cache-Control": "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400",
      },
    },
  );
}
