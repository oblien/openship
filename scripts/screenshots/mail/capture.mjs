import assert from "node:assert/strict";
import { mkdir, copyFile, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import sharp from "sharp";
import { APP_LOCALES } from "../../../packages/core/src/locale.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const origin = process.env.SCREENSHOT_ORIGIN ?? "http://localhost:3012";
const routeDir = resolve(root, "apps/dashboard/src/app/mail-capture");
const output = process.env.SCREENSHOT_OUTPUT ?? resolve(root, "apps/web/public/screenshots");
const locales = process.env.SCREENSHOT_LOCALES?.split(",") ?? APP_LOCALES;
const require = createRequire(import.meta.url);
const { chromium } = await import(pathToFileURL(
  process.env.PLAYWRIGHT_MODULE ?? require.resolve("playwright"),
).href);
const domains = ["example.com", "studio.example.com", "shop.example.com"].map((domain, i) => ({
  domain, description: "", mailboxes: [4, 2, 3][i], aliases: [3, 1, 2][i],
  maxMailboxes: 0, maxAliases: 0, defaultQuotaMB: 2048, active: true,
  createdAt: "2026-01-10T10:00:00Z",
}));
const mailboxes = ["alex", "hello", "support", "billing"].map((localPart) => ({
  username: `${localPart}@example.com`, name: "", domain: "example.com",
  quotaMB: 2048, storagebasedirectory: "/var/vmail", storagenode: "vmail1",
  maildir: `example.com/${localPart}/`, active: true, isAdmin: false,
  isGlobalAdmin: false, isPlatform: false, createdAt: "2026-01-10T10:00:00Z",
  passwordLastChange: "2026-01-10T10:00:00Z",
}));
let browser;
let ownsRoute = false;

try {
  await mkdir(routeDir);
  ownsRoute = true;
  await copyFile(resolve(here, "Preview.tsx"), resolve(routeDir, "Preview.tsx"));
  await writeFile(resolve(routeDir, "page.tsx"), `
    import { notFound } from "next/navigation";
    import Preview from "./Preview";
    export default function Page() {
      if (process.env.NODE_ENV !== "development") notFound();
      return <Preview />;
    }
  `, { flag: "wx" });
  browser = await chromium.launch();
  for (const locale of locales) {
    assert(APP_LOCALES.includes(locale), `Unsupported locale: ${locale}`);
    const context = await browser.newContext({
      viewport: { width: 1200, height: 820 }, deviceScaleFactor: 2,
      colorScheme: "light", reducedMotion: "reduce", locale,
      timezoneId: "UTC", serviceWorkers: "block",
    });
    await context.addCookies([
      { name: "capture.session_token", value: "visual-fixture-only", url: origin },
      { name: "openship-theme", value: "light:light", url: origin },
      { name: "openship-locale", value: locale, url: origin },
    ]);
    await context.addInitScript((language) => {
      localStorage.setItem("theme", "light");
      localStorage.setItem("openship-locale", language);
      localStorage.setItem("openship:mail:welcome-seen:mail-preview", "1");
      for (const domain of ["example.com", "studio.example.com", "shop.example.com"]) {
        localStorage.setItem(`openship:mail:reputation:mail-preview:${domain}`,
          JSON.stringify({ installedAt: 0, dismissed: true }));
      }
    }, locale);
    const unexpected = [];
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (!url.pathname.includes("/api/") && !url.pathname.startsWith("/health"))
        return route.continue();
      // No API request, including locale synchronization, reaches a real server.
      let body = null;
      if (url.pathname.endsWith("/domains")) body = { domains };
      else if (url.pathname.endsWith("/mailboxes")) body = { mailboxes };
      else if (url.pathname.endsWith("/domains-dns/pending")) body = { pending: [] };
      else if (url.pathname.endsWith("/auth/get-session")) body = { user: null, session: null };
      else if (url.pathname.endsWith("/settings/locale")) body = { locale };
      else if (url.pathname.endsWith("/containers/mail/apply/session")) body = null;
      else if (request.method() !== "OPTIONS") unexpected.push(`${request.method()} ${url.pathname}`);
      await route.fulfill({
        status: request.method() === "OPTIONS" ? 204 : 200,
        headers: {
          "content-type": "application/json", "access-control-allow-origin": origin,
          "access-control-allow-credentials": "true",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": request.headers()["access-control-request-headers"] ?? "content-type",
        },
        body: request.method() === "OPTIONS" ? "" : JSON.stringify(body),
      });
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/mail-capture?tab=mailboxes`, { waitUntil: "networkidle" });
    await page.getByText("hello@example.com", { exact: true }).waitFor().catch(async (error) => {
      console.error({ url: page.url(), errors, unexpected, text: (await page.locator("body").innerText()).slice(0, 4000) });
      throw error;
    });
    await page.evaluate(() => document.fonts.ready);
    await page.addStyleTag({ content: "nextjs-portal { display:none !important; }" });
    const frame = page.locator("[data-mail-capture]");
    const bounds = await frame.boundingBox();
    assert(bounds && bounds.width === 1200 && bounds.height === 760, "Mail panel fits its frame");
    assert.equal(await page.locator("html").getAttribute("lang"), locale);
    assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    await mkdir(resolve(output, locale), { recursive: true });
    await sharp(await frame.screenshot()).webp({ quality: 90 }).toFile(resolve(output, locale, "mail-control-panel.webp"));
    console.log(`${locale}: ${bounds.width} × ${bounds.height}`);
    await context.close();
  }
} finally {
  await browser?.close();
  if (ownsRoute) await rm(routeDir, { recursive: true, force: true });
}
