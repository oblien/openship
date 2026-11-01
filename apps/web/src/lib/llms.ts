import { reportCaughtError } from "@repo/core/diagnostics";
import { docsSource } from "@/lib/source";
import { SITE_URL } from "@/lib/sitemap-builder";

/**
 * Helpers for the llms.txt catalog + per-doc raw-markdown routes.
 *
 * Docs are authored as MDX (`content/docs/*.mdx`) and the fumadocs loader keeps
 * the original source around as `page.data._exports.raw`, so we can serve clean
 * markdown for LLMs/agents without rendering any HTML or pulling in a markdown
 * processor. See the `llms.txt` convention: https://llmstxt.org.
 */

/** Minimal page shape from the fumadocs loader we depend on. */
export type LlmPage = {
  url: string; // e.g. "/docs/mcp"
  data: {
    title: string;
    description?: string;
    // fumadocs-mdx v14: reads the original file content (incl. frontmatter).
    getText: (type: "raw" | "processed") => Promise<string>;
  };
};

/** Drop the leading `---…---` frontmatter block from raw MDX. */
export function stripFrontmatter(raw: string): string {
  return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trimStart();
}

/** Absolute `.md` URL for a doc page — the raw-markdown variant. */
export function mdUrlFor(url: string): string {
  return `${SITE_URL}${url}.md`;
}

/** Render one doc page as clean, self-contained markdown. */
export async function pageToMarkdown(page: LlmPage): Promise<string> {
  const { title, description, getText } = page.data;
  const head = [`# ${title}`, `URL: ${mdUrlFor(page.url)}`];
  if (description) head.push("", description);
  const raw = await getText("raw").catch(error => { reportCaughtError(error, "web/lib/llms"); return ""; });
  const body = stripFrontmatter(raw);
  return `${head.join("\n")}\n\n${body}`.trimEnd() + "\n";
}

export interface DocEntry {
  title: string;
  description: string;
  url: string; // /docs/<slug>
  mdUrl: string; // https://openship.io/docs/<slug>.md
}

/** Every docs page as a catalog entry. */
export function docEntries(): DocEntry[] {
  return (docsSource.getPages() as unknown as LlmPage[]).map((p) => ({
    title: p.data.title,
    description: p.data.description ?? "",
    url: p.url,
    mdUrl: mdUrlFor(p.url),
  }));
}
