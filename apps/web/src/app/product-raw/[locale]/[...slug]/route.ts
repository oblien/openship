import { APP_LOCALES, type AppLocale } from "@repo/core/locale";
import { createTranslator } from "next-intl";
import { createCopy } from "@/i18n/copy";
import { loadCatalog } from "@/i18n/catalogs";
import { localizedHref } from "@/i18n/routing";
import { PRODUCT_MARKDOWN_PATHS, productMarkdown } from "@/lib/product-markdown";
import { SITE_URL } from "@/lib/sitemap-builder";

export const dynamic = "force-static";

export function generateStaticParams() {
  return APP_LOCALES.flatMap((locale) =>
    PRODUCT_MARKDOWN_PATHS.map((path) => ({ locale, slug: path.slice(1).split("/") })),
  );
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ locale: string; slug: string[] }> },
) {
  const { locale, slug } = await params;
  const path = `/${slug.join("/")}`;
  if (!APP_LOCALES.includes(locale as AppLocale) || !PRODUCT_MARKDOWN_PATHS.includes(path)) {
    return new Response("Not found", { status: 404, headers: { "X-Robots-Tag": "noindex" } });
  }
  const language = locale as AppLocale;
  const messages = await loadCatalog(language);
  const copy = createCopy(createTranslator({ locale: language, messages, namespace: "Copy" }));
  return new Response(productMarkdown(path, copy, language), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Language": locale,
      Link: `<${SITE_URL}${localizedHref(path, language)}>; rel="canonical", <${SITE_URL}/llms.txt>; rel="describedby"; type="text/plain"`,
    },
  });
}
