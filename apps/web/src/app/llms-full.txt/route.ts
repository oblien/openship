import { docsSource } from "@/lib/source";
import { pageToMarkdown, type LlmPage } from "@/lib/llms";
import { createTranslator } from "next-intl";
import { createCopy } from "@/i18n/copy";
import { loadCatalog } from "@/i18n/catalogs";
import { PRODUCT_MARKDOWN_PATHS, productMarkdown } from "@/lib/product-markdown";

/**
 * `/llms-full.txt` — product pages and docs as markdown, for agents that
 * want the whole set in one fetch instead of walking `/llms.txt`.
 */
export const dynamic = "force-static";

export async function GET() {
  const pages = docsSource.getPages() as unknown as LlmPage[];
  const docs = await Promise.all(pages.map((page) => pageToMarkdown(page)));
  const messages = await loadCatalog("en");
  const copy = createCopy(createTranslator({ locale: "en", messages, namespace: "Copy" }));
  const product = PRODUCT_MARKDOWN_PATHS.map((path) => productMarkdown(path, copy, "en"));

  return new Response([...product, ...docs].join("\n\n---\n\n") + "\n", {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
