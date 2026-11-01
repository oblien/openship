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

export function GET() {
  const posts = (blogSource.getPages() as unknown as { url: string; data: BlogFrontmatter }[])
    .slice()
    .sort((a, b) => (b.data.date ?? "").localeCompare(a.data.date ?? ""));
  const items = posts
    .map((post) => {
      const date = post.data.date ? new Date(post.data.date) : null;
      const url = escapeXml(`${SITE_URL}${post.url}`);
      return `<item><title>${escapeXml(post.data.title)}</title><link>${url}</link><guid isPermaLink="true">${url}</guid><description>${escapeXml(post.data.description ?? "")}</description>${date && Number.isFinite(date.getTime()) ? `<pubDate>${date.toUTCString()}</pubDate>` : ""}</item>`;
    })
    .join("\n");
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>Openship Blog</title><link>${SITE_URL}/blog</link><description>Engineering, product updates, and guides from Openship.</description><language>en</language><atom:link href="${SITE_URL}/blog/rss.xml" rel="self" type="application/rss+xml"/>${items}</channel></rss>`,
    {
      headers: {
        "Content-Type": "application/rss+xml; charset=utf-8",
        "Cache-Control": "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400",
      },
    },
  );
}
