import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { APP_LOCALES } from "@repo/core/locale";
import { createTranslator } from "next-intl";
import {
  COMPARISONS,
  COMPARISON_GROUPS,
  comparisonName,
  getComparison,
} from "../src/lib/comparisons";
import { MIGRATION_SOURCES } from "../src/lib/migration-sources";
import { createCopy, messageKey } from "../src/i18n/copy";
import { isLocalizedPath, languageAlternates, localizedHref } from "../src/i18n/routing";
import { CLOUD_SLA } from "../src/lib/cloud-service";

describe("comparison and policy publishing", () => {
  test("comparison URLs are unique, explicit and reject unknown providers", () => {
    const slugs = COMPARISONS.map((item) => item.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs).toContain("vercel");
    expect(slugs).toContain("railway");
    expect(slugs).toContain("coolify");
    expect(slugs).toContain("self-managed-vps");
    for (const item of COMPARISONS) {
      expect(item.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(getComparison(item.slug)).toBe(item);
      expect(COMPARISON_GROUPS.some((group) => group.id === item.group)).toBe(true);
      expect(item.sources.length).toBeGreaterThan(0);
      for (const source of item.sources) expect(new URL(source.href).protocol).toBe("https:");
    }
    expect(getComparison("unknown-provider")).toBeUndefined();
    expect(getComparison("../coolify")).toBeUndefined();
  });

  test("every migration action has an existing guide, including manual migrations", () => {
    for (const { migration } of COMPARISONS) {
      if (migration.href.startsWith("/docs/")) {
        expect(existsSync(new URL(`../content${migration.href}.mdx`, import.meta.url))).toBe(true);
      } else if (migration.href === "/migrate/from-git") {
        expect(
          existsSync(
            new URL(
              "../src/app/(site)/[locale]/(marketing)/migrate/from-git/page.tsx",
              import.meta.url,
            ),
          ),
        ).toBe(true);
      } else {
        expect(
          MIGRATION_SOURCES.some((source) => `/migrate/${source.slug}` === migration.href),
        ).toBe(true);
      }
    }
    for (const slug of [
      "render",
      "heroku",
      "netlify",
      "fly-io",
      "digitalocean-app-platform",
      "caprover",
    ]) {
      expect(getComparison(slug)?.migration.href).toBe("/migrate/from-git");
    }
  });

  for (const locale of APP_LOCALES) {
    test(`${locale} has translated provider guidance and working language alternates`, () => {
      const messages = JSON.parse(
        readFileSync(new URL(`../src/i18n/messages/${locale}.json`, import.meta.url), "utf8"),
      );
      const copy = createCopy(createTranslator({ locale, messages, namespace: "Copy" }));
      const paths = ["/compare", "/sla", "/migrate/from-git"];
      for (const item of COMPARISONS) {
        paths.push(`/compare/${item.slug}`);
        const texts = [
          item.summary,
          item.strength,
          item.reason,
          item.runtime,
          item.migration.method,
          item.migration.preparation,
        ];
        for (const source of texts) {
          expect(messages.Copy[messageKey(source)]).toBeTruthy();
          if (locale !== "en") expect(copy(source)).not.toBe(source);
        }
        const title = copy("OpenShip vs {name}", { name: comparisonName(item, copy) });
        expect(title).not.toContain("{name}");
        expect(title).toContain("OpenShip");
      }
      for (const path of paths) {
        expect(isLocalizedPath(path)).toBe(true);
        const alternates = languageAlternates(path);
        expect(alternates[locale]).toBe(`https://openship.io${localizedHref(path, locale)}`);
        expect(alternates["x-default"]).toBe(`https://openship.io${path}`);
        expect(Object.keys(alternates)).toHaveLength(APP_LOCALES.length + 1);
      }
    });
  }

  test("the public SLA entry keeps the existing guarantee and credit schedule", () => {
    expect(CLOUD_SLA.termsHref).toBe("/sla");
    expect(CLOUD_SLA.monthlyUptimePercent).toBe(99);
    expect(CLOUD_SLA.creditTiers).toEqual([
      { minimumUptimePercent: 95, creditPercent: 10 },
      { minimumUptimePercent: 90, creditPercent: 25 },
      { minimumUptimePercent: 0, creditPercent: 100 },
    ]);
    expect(CLOUD_SLA.claimWindowDays).toBe(30);
  });
});
