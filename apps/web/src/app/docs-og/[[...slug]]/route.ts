import { docsSource } from "@/lib/source";
import { renderDocsOgImage } from "@/lib/docs-og";

/**
 * Per-page social card for a docs page — `/docs-og/<slug>`.
 *
 * A route handler rather than the `opengraph-image` file convention because the
 * docs route is an OPTIONAL catch-all (`[[...slug]]`), and Next refuses an image
 * segment nested under one ("optional catch-all must be the last part of the
 * URL"). Same shape as the sibling `docs-raw` handler, and referenced explicitly
 * from the docs page's `generateMetadata`.
 *
 * force-static + generateStaticParams → every card is a PNG written at build
 * time, so a crawler never triggers a render.
 */
export const dynamic = "force-static";

export function generateStaticParams() {
  return docsSource.generateParams();
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug?: string[] }> },
) {
  const { slug } = await params;
  if (!docsSource.getPage(slug)) return new Response("Not found", { status: 404 });

  return renderDocsOgImage(slug);
}
