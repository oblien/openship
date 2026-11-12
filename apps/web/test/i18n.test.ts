import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { createTranslator } from "next-intl";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import proxy from "../src/proxy";
import { APP_LOCALES } from "@repo/core/locale";
import { createCopy, messageKey, translateCopyData } from "../src/i18n/copy";
import {
  isLocalizedPath,
  languageAlternates,
  localizedHref,
  withoutLocale,
} from "../src/i18n/routing";
import ts from "typescript";
import { translateHtml } from "../src/i18n/html";
import english from "../src/i18n/messages/en.json";

type Catalog = typeof english;
const catalogs = Object.fromEntries(
  APP_LOCALES.map((locale) => [
    locale,
    JSON.parse(
      readFileSync(new URL(`../src/i18n/messages/${locale}.json`, import.meta.url), "utf8"),
    ) as Catalog,
  ]),
);
const tokens = (text: string) =>
  [...text.matchAll(/\{\w+\}|<\/?[a-z]+>/gi)].map(([value]) => value).sort();

describe("marketing locale URLs", () => {
  test("proxy preserves explicit language URLs and normalizes only redundant prefixes", () => {
    for (const host of ["localhost", "127.0.0.1", "openship.io"]) {
      for (const path of ["/", "/pricing", "/ar/pricing", "/ar/opengraph-image-example"]) {
        const response = proxy(new NextRequest(`http://${host}${path}`));
        expect(response.status).toBe(200);
        expect(response.headers.has("location")).toBe(false);
        expect(response.headers.has("x-middleware-rewrite")).toBe(false);
        expect(response.headers.has("set-cookie")).toBe(false);
      }
    }
    for (const path of ["/en/pricing?q=plans", "/ar/docs?q=install"]) {
      const response = proxy(new NextRequest(`https://openship.io${path}`));
      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe(`https://openship.io${withoutLocale(path)}`);
    }
  });
  test("English URLs stay compatible; every supported language keeps the page and filters", () => {
    for (const locale of APP_LOCALES) {
      const prefix = locale === "en" ? "" : `/${locale}`;
      expect(localizedHref("/apps?category=database#catalog", locale)).toBe(
        `${prefix}/apps?category=database#catalog`,
      );
      expect(localizedHref("/?ref=home#start", locale)).toBe(`${prefix || "/"}?ref=home#start`);
      expect(localizedHref("/ar/pricing", locale)).toBe(`${prefix}/pricing`);
    }
    expect(withoutLocale("/fr")).toBe("/");
    expect(withoutLocale("/fr?ref=nav")).toBe("/?ref=nav");
    expect(withoutLocale("/french/pricing")).toBe("/french/pricing");
  });

  test("English-only content, APIs, assets, fragments and external URLs stay intact", () => {
    for (const href of [
      "/docs",
      "/docs/quickstart?q=ssl",
      "/api/search",
      "/favicon.ico",
      "#plans",
      "https://cloud.openship.io",
      "//example.com/pricing",
      "mailto:hello@openship.io",
    ]) {
      expect(localizedHref(href, "ar")).toBe(href);
      expect(isLocalizedPath(href)).toBe(false);
    }
    expect(localizedHref("/ar/docs", "fr")).toBe("/docs");
  });

  test("canonical alternate languages cover all shared locales and English fallback", () => {
    const links = languageAlternates("/pricing");
    expect(Object.keys(links)).toEqual([...APP_LOCALES, "x-default"]);
    expect(links.ar).toBe("https://openship.io/ar/pricing");
    expect(links.en).toBe("https://openship.io/pricing");
    expect(links["x-default"]).toBe(links.en);
  });
});

describe("translation catalogs", () => {
  test("published branding aliases resolve to the same translations", () => {
    expect(messageKey("Openship Cloud")).toBe(messageKey("OpenShip Cloud"));
    for (const locale of APP_LOCALES) {
      const messages: Record<string, Record<string, string>> = catalogs[locale];
      const copy = createCopy(createTranslator({ locale, messages, namespace: "Copy" }));
      expect(copy("Openship Cloud")).toBe(copy("OpenShip Cloud"));
      expect(copy("OpenShip Cloud")).toContain("OpenShip");
      expect(copy("Openship-arm64.dmg")).toBe("Openship-arm64.dmg");
      for (const name of ["Python", "Go", "Rust", "Bun", "Rails", "Laravel", "Django"])
        expect(copy(name)).toBe(name);
    }
  });

  test("Arabic prices isolate the amount from the surrounding text", () => {
    const messages: Record<string, Record<string, string>> = catalogs.ar;
    const copy = createCopy(createTranslator({ locale: "ar", messages, namespace: "Copy" }));
    const price = copy.rich("From <price>{amount}</price>/month", {
      amount: "$12",
      price: (amount) => createElement("bdi", { dir: "ltr" }, amount),
    });
    const html = renderToStaticMarkup(createElement(Fragment, null, price));
    expect(html).toContain('<bdi dir="ltr">$12</bdi>');
    expect(html).toContain("شهريًا");
  });

  test("stable keys have no source collisions or normalization drift", () => {
    for (const namespace of ["Copy", "ReleaseNotes"] as const) {
      for (const [key, source] of Object.entries(english[namespace]))
        expect(messageKey(source)).toBe(key);
    }
    expect(messageKey("  Deploy   anything. ")).toBe(messageKey("Deploy anything."));
  });

  for (const locale of APP_LOCALES) {
    test(`${locale} has complete copy, preserved placeholders and no authoring markers`, () => {
      const catalog = catalogs[locale];
      for (const namespace of ["Copy", "ReleaseNotes"] as const) {
        expect(Object.keys(catalog[namespace]).sort()).toEqual(
          Object.keys(english[namespace]).sort(),
        );
      }
      expect(catalog.Metadata.title).toBeTruthy();
      expect(catalog.Metadata.description).toBeTruthy();
      const translations: Record<string, string> = { ...catalog.Copy, ...catalog.ReleaseNotes };
      for (const [key, source] of Object.entries({ ...english.Copy, ...english.ReleaseNotes })) {
        const value = translations[key];
        expect(typeof value).toBe("string");
        expect(value.trim().length).toBeGreaterThan(0);
        expect(value).not.toMatch(/ZX(?:PH|Q)\d|\[VALUE_\d+\]/);
        expect(tokens(value)).toEqual(tokens(source));
      }
    });
  }

  test("renders user-facing strings while preserving values, commands and markup safety", () => {
    const arMessages: Record<string, Record<string, string>> = catalogs.ar;
    const enMessages: Record<string, Record<string, string>> = english;
    const ar = createCopy(
      createTranslator({ locale: "ar", messages: arMessages, namespace: "Copy" }),
    );
    const en = createCopy(
      createTranslator({ locale: "en", messages: enMessages, namespace: "Copy" }),
    );
    expect(ar("Deploy anything.")).not.toBe(en("Deploy anything."));
    expect(en("Deploy anything.")).toBe("Deploy anything.");
    expect(ar("Dockerfile")).toBe("Dockerfile");
    expect(ar("docker compose up -d")).toBe("docker compose up -d");
    expect(ar(2000)).toBe(2000);
    const element = {
      $$typeof: Symbol.for("react.transitional.element"),
      props: { children: "Pricing" },
    };
    expect(ar(element)).toBe(element);
    expect(ar("Choose {name}", { name: "<img onerror=alert(1)>" })).toContain(
      "<img onerror=alert(1)>",
    );
    const source = {
      title: "Pricing",
      href: "/pricing",
      type: "website",
      name: "Openship",
      code: "Pricing",
      price: 2000,
    };
    const result = translateCopyData(source, ar);
    expect(result.title).not.toBe(source.title);
    expect(result.href).toBe(source.href);
    expect(result.type).toBe("website");
    expect(result.code).toBe("Pricing");
    expect(result.price).toBe(2000);
    expect(source.title).toBe("Pricing");
  });
});

describe("article and release translations", () => {
  test("translated HTML preserves code and escapes translated text", () => {
    const messages: Record<string, Record<string, string>> = {
      Copy: { [messageKey("Pricing")]: '<img src=x onerror="alert(1)">' },
    };
    const copy = createCopy(createTranslator({ locale: "en", messages, namespace: "Copy" }));
    const html = translateHtml(
      '<p><a href="/docs">Pricing</a><code>Pricing</code></p><pre>Pricing</pre>',
      copy,
    );
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img");
    expect(html).toContain('<a href="/docs">');
    expect(html).toContain("<code>Pricing</code>");
    expect(html).toContain("<pre>Pricing</pre>");
  });

  test("all blog languages preserve source commands, links and publication metadata", () => {
    const directory = new URL("../content/resources/", import.meta.url);
    const sources = readdirSync(directory).filter(
      (file) => !/\.(ar|es|fr|de|pt|ja|zh|tr|ru)\.mdx$/.test(file) && file.endsWith(".mdx"),
    );
    const code = (text: string) => [...text.matchAll(/```[\s\S]*?```/g)].map(([value]) => value);
    const links = (text: string) =>
      [...text.matchAll(/\]\(([^)]+)\)/g)].map(([, value]) => value).sort();
    for (const file of sources) {
      const source = readFileSync(new URL(file, directory), "utf8");
      for (const locale of APP_LOCALES.filter((value) => value !== "en")) {
        const text = readFileSync(
          new URL(file.replace(".mdx", `.${locale}.mdx`), directory),
          "utf8",
        );
        expect(code(text)).toEqual(code(source));
        expect(links(text)).toEqual(links(source));
        for (const field of ["date", "category", "author"])
          expect(text.match(new RegExp(`^${field}:.*$`, "m"))?.[0]).toBe(
            source.match(new RegExp(`^${field}:.*$`, "m"))?.[0],
          );
        expect(text).not.toMatch(/\[VALUE_\d+\]|<script/i);
      }
    }
  });

  test("translation calls never change technical JSX attributes", () => {
    const root = new URL("../src/", import.meta.url);
    function walk(directory: URL): URL[] {
      return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? walk(new URL(`${entry.name}/`, directory))
          : entry.name.endsWith(".tsx")
            ? [new URL(entry.name, directory)]
            : [],
      );
    }
    const violations: string[] = [];
    for (const file of walk(root)) {
      const source = ts.createSourceFile(
        file.pathname,
        readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      function visit(node: ts.Node) {
        if (
          ts.isJsxAttribute(node) &&
          ["href", "src", "id", "key", "className", "type", "role", "value"].includes(
            node.name.getText(source),
          ) &&
          /\bcopy\(/.test(node.initializer?.getText(source) ?? "")
        )
          violations.push(`${file.pathname}: ${node.getText(source)}`);
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
    expect(violations).toEqual([]);
  });
});
