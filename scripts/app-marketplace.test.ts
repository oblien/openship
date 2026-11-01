import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { APP_TEMPLATES, getAppTemplate } from "../packages/core/src/app-templates";
import { APP_LOGO } from "../packages/ui/src/AppLogo";
import { marketplaceEntries, filterMarketplaceApps } from "../apps/web/src/lib/app-marketplace";
import { safeAppContentUrl } from "../apps/web/src/lib/app-content-url";
import { renderAppArticle } from "../apps/web/src/lib/app-markdown";
import { getMarketplaceApps, mergePublishedCatalog } from "../apps/web/src/lib/app-catalog";

describe("public app directory", () => {
  const apps = marketplaceEntries(APP_TEMPLATES);

  it("honors catalog visibility, availability, branding, and article content", () => {
    expect(apps.map((app) => app.id)).not.toContain("webmail");
    expect(apps.find((app) => app.id === "buzz")?.available).toBe(false);
    expect(apps.find((app) => app.id === "redis")?.logo).toBe("valkey");
    expect(apps.find((app) => app.id === "convex")?.article).toContain("## After deployment");
    expect(apps.find((app) => app.id === "mail")?.kind).toBe("flow");
  });

  it("projects public data without installation settings or secrets", () => {
    const source = {
      ...getAppTemplate("convex")!,
      id: "test-app",
      configFields: [{ key: "PASSWORD", value: "do-not-publish" }],
      services: [
        {
          name: "db",
          image: "db:1",
          environment: { PASSWORD: "do-not-publish" },
          secretEnv: ["PASSWORD"],
          volumes: ["data:/data"],
        },
      ],
    };
    const result = marketplaceEntries([source]);
    expect(result[0]?.services).toEqual([{ name: "db", image: "db:1", persistent: true }]);
    expect(JSON.stringify(result)).not.toContain("do-not-publish");
    expect(result[0]).not.toHaveProperty("configFields");
    expect(result[0]).not.toHaveProperty("settings");
  });

  it("searches feature summaries and combines search terms with category", () => {
    const sample = {
      ...apps[0]!,
      id: "sample",
      name: "Example",
      category: "backend" as const,
      description: "A backend",
      tags: ["collaboration"],
      features: [{ title: "Reactive queries" }],
    };
    expect(filterMarketplaceApps([sample], "backend", " reactive   COLLABORATION ")).toHaveLength(
      1,
    );
    expect(filterMarketplaceApps([sample], "database", "reactive")).toHaveLength(0);
    expect(filterMarketplaceApps([sample], "all", "reactive unknown")).toHaveLength(0);
  });

  it("never puts executable or credential-bearing source URLs into app links", () => {
    for (const repository of [
      "javascript:alert(1)",
      "data:text/html,evil",
      "https://user:secret@example.com/repo",
      "//evil.test",
    ]) {
      expect(
        marketplaceEntries([{ ...getAppTemplate("convex")!, repository }])[0]?.repository,
      ).toBeUndefined();
    }
    expect(
      marketplaceEntries([
        { ...getAppTemplate("convex")!, repository: "https://github.com/example/app" },
      ])[0]?.repository,
    ).toBe("https://github.com/example/app");
  });

  it("ships the same bundled brand assets on the dashboard and website", () => {
    for (const config of Object.values(APP_LOGO)) {
      if (!config.src?.startsWith("/app-logos/")) continue;
      const dashboard = readFileSync(
        new URL(`../apps/dashboard/public${config.src}`, import.meta.url),
      );
      const website = readFileSync(new URL(`../apps/web/public${config.src}`, import.meta.url));
      expect(website.equals(dashboard)).toBe(true);
    }
  });

  it("compiles shared logo styling when each app builds from its own workspace", async () => {
    for (const app of ["dashboard", "web"]) {
      const requireApp = createRequire(new URL(`../apps/${app}/package.json`, import.meta.url));
      const { default: postcss } = await import(requireApp.resolve("postcss"));
      const { default: tailwind } = await import(requireApp.resolve("@tailwindcss/postcss"));
      const base = fileURLToPath(new URL(`../apps/${app}/`, import.meta.url));
      const file = fileURLToPath(new URL(`../apps/${app}/src/app/globals.css`, import.meta.url));
      const output = await postcss([tailwind({ base, optimize: false })]).process(
        readFileSync(file, "utf8"),
        { from: file },
      );
      expect(output.css).toContain(".dark\\:invert");
      if (app === "dashboard") expect(output.css).toContain(".dim\\:invert");
    }
  });
});

describe("published catalog and fallback", () => {
  const originalMode = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = originalMode;
  });

  it("overlays valid published entries and keeps bundled fallback entries", () => {
    const convex = { ...getAppTemplate("convex")!, description: "Published update" };
    const result = mergePublishedCatalog({ apps: [convex, { id: "invalid" }] });
    expect(result.find((app) => app.id === "convex")?.description).toBe("Published update");
    expect(result.find((app) => app.id === "minio")).toEqual(getAppTemplate("minio"));
    expect(result.find((app) => app.id === "invalid")).toBeUndefined();
    expect(() => mergePublishedCatalog({ apps: [convex, convex] })).toThrow("Duplicate");
    expect(() => mergePublishedCatalog({ apps: "bad" })).toThrow("envelope");
  });

  it("uses bundled unpublished content in development without a remote request", async () => {
    process.env.NODE_ENV = "development";
    const fetch = spyOn(globalThis, "fetch");
    try {
      expect(await getMarketplaceApps()).toEqual(marketplaceEntries(APP_TEMPLATES));
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  it("keeps the directory usable when the published catalog cannot be read", async () => {
    process.env.NODE_ENV = "production";
    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Unavailable", { status: 503 }),
    );
    try {
      expect(await getMarketplaceApps()).toEqual(marketplaceEntries(APP_TEMPLATES));
    } finally {
      fetch.mockRestore();
    }
  });
});

describe("catalog Markdown security", () => {
  it("renders headings and links while escaping raw HTML", () => {
    const html = renderAppArticle(
      "# Title\n\n**Useful** [docs](https://example.com/docs)\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>",
    );
    expect(html).toContain("<h2>Title</h2>");
    expect(html).toContain("<strong>Useful</strong>");
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
  });

  it("blocks unsafe schemes, network-path URLs, controls, and credentials", () => {
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,evil",
      "//evil.test",
      "/\\evil.test",
      "https://user:secret@example.com",
      "java\nscript:alert(1)",
    ]) {
      expect(safeAppContentUrl(url, true)).toBeNull();
    }
    const html = renderAppArticle(
      "[run](javascript:alert%281%29) ![image](data:text/html,evil) [external](//evil.test) [entity](javascript&#58;alert%281%29)",
    );
    expect(html).not.toContain("href=");
    expect(html).not.toContain("<img");
    expect(safeAppContentUrl("/docs/reference/app-catalog", true)).toBe(
      "/docs/reference/app-catalog",
    );
    expect(safeAppContentUrl("#features", true)).toBe("#features");
  });

  it("escapes attributes in image labels and URLs", () => {
    const html = renderAppArticle('![quote" onerror="alert(1)](https://example.com/image.png)');
    expect(html).toContain('alt="quote&quot; onerror=&quot;alert(1)"');
    expect(html).not.toContain(' onerror="');
    expect(html).toContain('loading="lazy"');
  });
});
