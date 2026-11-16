import { expect, test } from "bun:test";
import { buildSitemapIndex, buildUrlset } from "../src/lib/sitemap-builder";

for (const render of [buildSitemapIndex, buildUrlset]) {
  test(`${render.name} uses known content dates and omits unknown or invalid dates`, () => {
    const xml = render([
      { loc: "https://openship.io/known", lastmod: "2026-11-16" },
      { loc: "https://openship.io/unknown" },
      { loc: "https://openship.io/invalid", lastmod: "not a date" },
      { loc: "https://openship.io/invalid-object", lastmod: new Date(NaN) },
    ]);
    expect(xml.match(/<lastmod>/g)).toHaveLength(1);
    expect(xml).toContain("<lastmod>2026-11-16T00:00:00.000Z</lastmod>");
    expect(xml).not.toContain("undefined");
  });
}
