import { FEATURES } from "@/lib/features";
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

export function renderDocsOgImage(slug: string[] = []) {
  const page = docsSource.getPage(slug);
  const path = ["docs", ...slug].join("/");
  if (!page)
    return renderOgImage({ eyebrow: "Docs", title: "Documentation", art: { object: "journal" } });
  const { title, description, toc, structuredData } = page.data;
  const headingText = new Map(structuredData.headings.map(({ id, content }) => [id, content]));
  const feature = FEATURES.find((entry) => entry.guide.split("#")[0] === "/" + path);
  const headings = toc.filter((entry) => entry.depth === 2);
  const outline = (headings.length ? headings : toc).map(
    (entry) =>
      headingText.get(entry.url.slice(1)) ??
      (typeof entry.title === "string" ? entry.title : entry.url.slice(1).replace(/-/g, " ")),
  );
  const commandPrefix = `openship ${title} `;
  const isCommand = slug[0] === "cli" && slug[1] === "reference" && slug.length > 2;
  return renderOgImage({
    eyebrow: sectionLabel(slug),
    title: truncate(title, 70),
    subtitle: description && truncate(description, 150),
    footer: "openship.io/" + path,
    art: isCommand
      ? {
          command: title,
          subcommands: outline
            .filter((heading) => heading.startsWith(commandPrefix))
            .map((heading) => heading.slice(commandPrefix.length)),
        }
      : { outline, feature: feature?.illustration },
  });
}

/** Pre-generate a card for every docs page at build time (no per-request render). */
export function generateDocsOgParams() {
  return docsSource.generateParams();
}
