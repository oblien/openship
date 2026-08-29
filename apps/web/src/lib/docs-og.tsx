import { docsSource } from "@/lib/source";
import { renderOgImage, type OgAccent } from "@/lib/og-image";

/** Blue accent for docs — distinct from home (green), download (seafoam) and
 *  roadmap (violet), so a docs link is recognizable in a feed at a glance. */
const BLUE: OgAccent = { glow: "59,130,246", solid: "#3B82F6", soft: "#93C5FD" };

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
  const label =
    SECTION_LABELS[top] ??
    top.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
  return `Docs · ${label}`;
}

/** The OG renderer clamps neither title nor subtitle, and a docs `description`
 *  is often a full sentence or three — long enough to run off the 630px card.
 *  Cut on a word boundary so the card never shows a mid-word break. */
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
 * An unresolvable slug falls back to the generic Openship card rather than
 * throwing: a missing image degrades a social preview, but a throw here would
 * fail the page's whole metadata render.
 */
export function renderDocsOgImage(slug: string[] = []) {
  const page = docsSource.getPage(slug);
  if (!page) return renderOgImage({ accent: BLUE, eyebrow: "Docs" });

  const data = page.data as { title: string; description?: string };
  return renderOgImage({
    accent: BLUE,
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
