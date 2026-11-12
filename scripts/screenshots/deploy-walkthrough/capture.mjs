import assert from "node:assert/strict";
import sharp from "sharp";
import { APP_LOCALES } from "../../../packages/core/src/locale.ts";
import { mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const origin = process.env.SCREENSHOT_ORIGIN ?? "http://localhost:3001";
const routeDir = resolve(root, "apps/dashboard/src/app/walkthrough-capture");
const output = resolve(root, "apps/web/public/walkthrough");
const localizedOutput =
  process.env.SCREENSHOT_OUTPUT ?? resolve(root, "apps/web/public/screenshots");
const selected = process.env.SCREENSHOT_LOCALES?.split(",") ?? APP_LOCALES;
for (const locale of selected)
  assert(APP_LOCALES.includes(locale), `Unsupported locale: ${locale}`);
const require = createRequire(import.meta.url);
const { chromium } = await import(
  pathToFileURL(process.env.PLAYWRIGHT_MODULE ?? require.resolve("playwright")).href
);
let browser;
let page;
let ownsRoute = false;
const errors = [];
const writes = [];

try {
  await mkdir(routeDir);
  ownsRoute = true;
  await writeFile(resolve(routeDir, "Preview.tsx"), await readFile(resolve(here, "Preview.tsx")), {
    flag: "wx",
  });
  await writeFile(resolve(routeDir, "fixture.ts"), await readFile(resolve(here, "fixture.ts")), {
    flag: "wx",
  });
  await writeFile(
    resolve(routeDir, "page.tsx"),
    [
      'import { notFound } from "next/navigation";',
      'import Preview from "./Preview";',
      "export default function Page() {",
      '  if (process.env.NODE_ENV !== "development") notFound();',
      "  return <Preview />;",
      "}",
    ].join("\n"),
    { flag: "wx" },
  );
  await mkdir(output, { recursive: true });
  browser = await chromium.launch();
  for (const locale of selected) {
    for (const theme of ["light", "dim"]) {
      const context = await browser.newContext({
        viewport: { width: 900, height: 675 },
        deviceScaleFactor: 2,
        colorScheme: theme === "light" ? "light" : "dark",
        reducedMotion: "reduce",
        locale,
        timezoneId: "UTC",
        serviceWorkers: "block",
      });
      // This invalid cookie only passes the local proxy's presence check. The
      // temporary route sits outside the authenticated dashboard and has no data access.
      await context.addCookies([
        { name: "capture.session_token", value: "visual-fixture-only", url: origin },
        { name: "openship-theme", value: `${theme}:${theme}`, url: origin },
        { name: "openship-locale", value: locale, url: origin },
      ]);
      await context.addInitScript(
        ({ mode, language }) => {
          localStorage.setItem("theme", mode);
          localStorage.setItem("openship-locale", language);
        },
        { mode: theme, language: locale },
      );
      await context.route("**/*", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.pathname.includes("/api/") || url.pathname.startsWith("/health")) {
          const dnsPreview = url.pathname.endsWith("/domains/preview");
          if (!["GET", "HEAD", "OPTIONS"].includes(request.method()) && !dnsPreview)
            writes.push(url.pathname);
          await route.fulfill({
            status: request.method() === "OPTIONS" ? 204 : 200,
            headers: {
              "content-type": "application/json",
              "access-control-allow-origin": origin,
              "access-control-allow-credentials": "true",
              "access-control-allow-headers":
                request.headers()["access-control-request-headers"] ?? "content-type",
            },
            body: JSON.stringify(
              dnsPreview
                ? {
                    data: {
                      records: [{ type: "A", host: "shop", value: "203.0.113.10" }],
                      mode: "selfhosted",
                    },
                  }
                : null,
            ),
          });
          return;
        }
        await route.continue();
      });
      page = await context.newPage();
      page.on("pageerror", (error) => errors.push(error.message));
      await page.clock.setFixedTime(new Date("2026-11-09T10:05:00Z"));
      // A running Next dev server can briefly return 404 while it discovers the route.
      const deadline = Date.now() + 120_000;
      let response;
      do {
        response = await page.goto(`${origin}/walkthrough-capture`, {
          waitUntil: "networkidle",
          timeout: 120_000,
        });
        if (response?.status() !== 404) break;
        await page.waitForTimeout(500);
      } while (Date.now() < deadline);
      assert.equal(response?.ok(), true, "The local dashboard capture route is unavailable");
      await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
      for (const view of ["connect", "build", "ship", "route", "operate"]) {
        await page.evaluate((id) => {
          location.hash = id;
        }, view);
        const frame = page.locator(`[data-walkthrough-capture="${view}"]`);
        await frame.waitFor();
        await page.evaluate(() => document.fonts.ready);
        await frame
          .locator("img")
          .evaluateAll((images) => Promise.all(images.map((image) => image.decode())));
        if (view === "build") await page.locator(".xterm-screen").first().waitFor();
        // Let xterm's fit and the existing chart finish painting before capture.
        await page.waitForTimeout(650);
        assert.equal(
          await page.locator("html").getAttribute("data-theme"),
          theme,
          "The screenshot must use the requested dashboard theme",
        );
        assert.equal(
          await frame.evaluate((el) => el.scrollHeight > el.clientHeight),
          false,
          `${view} is clipped`,
        );
        assert.equal(await page.locator("html").getAttribute("lang"), locale);
        assert.equal(
          await page.locator("html").getAttribute("dir"),
          locale === "ar" ? "rtl" : "ltr",
        );
        const filename = `${view}${theme === "light" ? "-light" : ""}`;
        const directory = resolve(localizedOutput, locale, "walkthrough");
        await mkdir(directory, { recursive: true });
        const png = await frame.screenshot({ animations: "disabled" });
        const size = await sharp(png).metadata();
        assert.equal(size.width, 1800);
        assert.equal(size.height, 1350);
        await sharp(png)
          .webp({ lossless: true })
          .toFile(resolve(directory, `${filename}.webp`));
        if (locale === "en" && !process.env.SCREENSHOT_OUTPUT)
          await sharp(png)
            .jpeg({ quality: 88 })
            .toFile(resolve(output, `${filename}.jpg`));
        const file = await stat(resolve(directory, `${filename}.webp`));
        console.log(`${locale}/${filename}.webp: ${Math.round(file.size / 1024)} KB`);
      }
      await context.close();
      page = undefined;
    }
  }
  assert.deepEqual(errors, [], "Browser errors");
  assert.deepEqual(writes, [], "Unexpected API mutation attempts");
  console.log("Captured localized real component views in light and dim themes; no API writes.");
} catch (error) {
  if (page)
    console.error(page.url(), (await page.locator("body").innerText()).slice(0, 3000), errors);
  throw error;
} finally {
  await browser?.close();
  if (ownsRoute) await rm(routeDir, { recursive: true });
}
