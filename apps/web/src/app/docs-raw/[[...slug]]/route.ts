import { docsSource } from "@/lib/source";
import { pageToMarkdown, type LlmPage } from "@/lib/llms";
import { SITE_URL } from "@/lib/sitemap-builder";

/**
 * Raw-markdown variant of a docs page — no HTML shell, just the source.
 * Public URL is `/docs/<slug>.md` (rewritten to here in next.config.mjs), the
 * standard llms.txt way to fetch a doc for an LLM/agent.
 */
export const dynamic = "force-static";

export function generateStaticParams() {
  return docsSource.generateParams();
}

export async function GET(_req: Request, { params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await params;
  const page = docsSource.getPage(slug);
  if (!page) return new Response("Not found", { status: 404 });

  return new Response(await pageToMarkdown(page as unknown as LlmPage), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      Link: `<${SITE_URL}${page.url}>; rel="canonical", <${SITE_URL}/docs/llms.txt>; rel="describedby"; type="text/plain"`,
    },
  });
}
