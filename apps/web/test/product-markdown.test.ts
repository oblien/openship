import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { createTranslator } from "next-intl";
import { APP_LOCALES } from "@repo/core/locale";
import { createCopy, messageKey } from "../src/i18n/copy";
import { FEATURES } from "../src/lib/features";
import { COMPARISONS, comparisonRows, comparisonName } from "../src/lib/comparisons";
import {
  PRODUCT_ADVANTAGES,
  PRODUCT_SUMMARY,
  PRODUCT_QUESTIONS,
  CONTROL_PLANE_MODES,
} from "../src/lib/product";
import { PRODUCT_MARKDOWN_PATHS, productMarkdown } from "../src/lib/product-markdown";
import { GET } from "../src/app/product-raw/[locale]/[...slug]/route";
import robots from "../src/app/robots";

describe("public product content", () => {
  test("capabilities link to real feature pages and documented guides", () => {
    const slugs = new Set(FEATURES.map(({ slug }) => slug));
    expect(slugs.size).toBe(FEATURES.length);
    for (const advantage of Object.values(PRODUCT_ADVANTAGES))
      expect(slugs.has(advantage.feature)).toBe(true);
    for (const feature of FEATURES) {
      if (!feature.guide.startsWith("/docs/")) continue;
      const path = feature.guide.split("#")[0];
      expect(
        existsSync(new URL(`../content${path}.mdx`, import.meta.url)) ||
          existsSync(new URL(`../content${path}/index.mdx`, import.meta.url)),
      ).toBe(true);
    }
    expect(new Set(PRODUCT_MARKDOWN_PATHS).size).toBe(PRODUCT_MARKDOWN_PATHS.length);
  });

  for (const locale of APP_LOCALES) {
    test(`${locale} shares complete translated facts between HTML data and Markdown`, () => {
      const messages = JSON.parse(
        readFileSync(new URL(`../src/i18n/messages/${locale}.json`, import.meta.url), "utf8"),
      );
      const copy = createCopy(createTranslator({ locale, messages, namespace: "Copy" }));
      const sources = [
        PRODUCT_SUMMARY,
        "Platform features",
        "About OpenShip",
        "Move to OpenShip",
        "Customer support",
        ...CONTROL_PLANE_MODES.flatMap((item) => [item.title, item.description]),
        ...Object.values(PRODUCT_ADVANTAGES).flatMap((item) => [item.title, item.description]),
        ...PRODUCT_QUESTIONS.flatMap((item) => [item.question, item.answer]),
        ...FEATURES.flatMap((item) => [
          item.title,
          item.tagline,
          item.summary,
          ...item.body,
          ...(item.availability ? [item.availability] : []),
          ...item.highlights.flatMap((h) => [h.title, h.desc]),
        ]),
        ...COMPARISONS.flatMap((item) => [
          item.summary,
          item.reason,
          ...comparisonRows(item).flatMap((row) => [row.label, row.ours, row.theirs]),
        ]),
      ];
      for (const source of sources) expect(messages.Copy[messageKey(source)]).toBeTruthy();
      for (const path of PRODUCT_MARKDOWN_PATHS) {
        const text = productMarkdown(path, copy, locale)!;
        expect(text.startsWith("# ")).toBe(true);
        expect(text).not.toContain("undefined");
        expect(text).not.toContain("{name}");
      }
      expect(productMarkdown("/features", copy, locale)).toContain(copy(PRODUCT_SUMMARY));
      for (const item of COMPARISONS) {
        const text = productMarkdown(`/compare/${item.slug}`, copy, locale)!;
        expect(text).toContain(copy(item.reason));
        expect(text.indexOf(copy("Why choose OpenShip"))).toBeLessThan(
          text.indexOf(copy("Where {name} fits", { name: comparisonName(item, copy) })),
        );
      }
    });
  }

  test("the Markdown handler rejects unknown locales, paths and traversal", async () => {
    for (const params of [
      { locale: "xx", slug: ["features"] },
      { locale: "en", slug: ["features", "unknown"] },
      { locale: "en", slug: ["..", "..", ".env"] },
    ]) {
      const response = await GET(new Request("https://openship.io/features.md"), {
        params: Promise.resolve(params),
      });
      expect(response.status).toBe(404);
      expect(response.headers.get("x-robots-tag")).toBe("noindex");
    }
    const response = await GET(new Request("https://openship.io/ar/compare/dokploy.md"), {
      params: Promise.resolve({ locale: "ar", slug: ["compare", "dokploy"] }),
    });
    expect(response.headers.get("content-type")).toContain("text/markdown");
    expect(response.headers.get("content-language")).toBe("ar");
    expect(response.headers.get("link")).toContain(
      '<https://openship.io/ar/compare/dokploy>; rel="canonical"',
    );
  });

  test("search and LLM crawlers can fetch public rendering assets under one policy", () => {
    const rules = robots().rules;
    expect(Array.isArray(rules)).toBe(true);
    expect(rules).toHaveLength(1);
    const rule = Array.isArray(rules) ? rules[0] : rules;
    expect(rule.userAgent).toBe("*");
    expect(rule.allow).toBe("/");
    expect(rule.disallow).not.toContain("/_next/");
    expect(rule.disallow).toContain("/api/");
  });
});
