import { docsSource } from "@/lib/source";
import { renderOgImage } from "@/lib/og-image";

/** Section labels for the eyebrow. Only the ones whose casing we can't derive
 *  from the slug (acronyms) need an entry; everything else is de-kebabed. */
const SECTION_LABELS: Record<string, string> = {
  api: "API",
  cli: "CLI",
  mcp: "MCP",
};

function sectionLabel(slug: string[]): string {
  const top = slug[0];
  if (!top) return "Docs";
  const label = SECTION_LABELS[top] ?? top.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
  return `Docs · ${label}`;
}

/** Prefer a whole-word excerpt when a document supplies a long description. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * Per-page OG/Twitter card for any docs route. Shared by the two image files so
 * both produce the identical card from one definition.
 *
 * An unresolvable slug falls back to the generic OpenShip card rather than
 * throwing: a missing image degrades a social preview, but a throw here would
 * fail the page's whole metadata render.
 */
export function renderDocsOgImage(slug: string[] = []) {
  const page = docsSource.getPage(slug);
  if (!page)
    return renderOgImage({
      accent: "#bfd1e6",
      symbol: "book",
      eyebrow: "Docs",
      title: "Documentation",
    });

  const data = page.data as { title: string; description?: string };
  return renderOgImage({
    accent: "#bfd1e6",
    symbol: "book",
    eyebrow: sectionLabel(slug),
    title: truncate(data.title, 70),
    subtitle: data.description
      ? truncate(data.description, 150)
      : "Open source, self-hostable deployment platform.",
  });
}

/** Pre-generate a card for every docs page at build time (no per-request render). */
export function generateDocsOgParams() {
  return docsSource.generateParams();
}
