import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, rm, copyFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import sharp from "sharp";
import { APP_LOCALES } from "../../../packages/core/src/locale.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const origin = process.env.SCREENSHOT_ORIGIN ?? "http://localhost:3001";
const routeDir = resolve(root, "apps/dashboard/src/app/landing-capture");
const output = process.env.SCREENSHOT_OUTPUT ?? resolve(root, "apps/web/public/screenshots");
const selected = process.env.SCREENSHOT_LOCALES?.split(",") ?? APP_LOCALES;
for (const locale of selected)
  assert(APP_LOCALES.includes(locale), `Unsupported locale: ${locale}`);
const require = createRequire(import.meta.url);
const { chromium } = await import(
  pathToFileURL(process.env.PLAYWRIGHT_MODULE ?? require.resolve("playwright")).href
);
const user = {
  id: "screenshot-user",
  name: "Alex Morgan",
  email: "alex@example.com",
  emailVerified: true,
};
let browser;
let page;
let ownsRoute = false;
const errors = [];
const writes = [];

try {
  await mkdir(routeDir);
  ownsRoute = true;
  await copyFile(resolve(here, "Preview.tsx"), resolve(routeDir, "Preview.tsx"));
  await copyFile(
    resolve(here, "../deploy-walkthrough/fixture.ts"),
    resolve(routeDir, "fixture.ts"),
  );
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
  browser = await chromium.launch();
  for (const locale of selected) {
    const context = await browser.newContext({
      // The existing Mac capture is 2998 × 1572; retain its exact Retina canvas.
      viewport: { width: 1499, height: 786 },
      deviceScaleFactor: 2,
      colorScheme: "light",
      reducedMotion: "reduce",
      locale,
      timezoneId: "UTC",
      serviceWorkers: "block",
    });
    await context.addCookies([
      { name: "capture.session_token", value: "visual-fixture-only", url: origin },
      { name: "openship-theme", value: "light:light", url: origin },
      { name: "openship-locale", value: locale, url: origin },
    ]);
    await context.addInitScript((language) => {
      localStorage.setItem("theme", "light");
      localStorage.setItem("openship-locale", language);
    }, locale);
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (!url.pathname.includes("/api/") && !url.pathname.startsWith("/health"))
        return route.continue();
      const dnsPreview = url.pathname.endsWith("/domains/preview");
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method()) && !dnsPreview)
        writes.push(`${request.method()} ${url.pathname}`);
      let body = null;
      if (url.pathname.endsWith("/auth/get-session"))
        body = {
          user,
          session: {
            id: "screenshot-session",
            userId: user.id,
            token: "visual-fixture-only",
            activeOrganizationId: "screenshot-workspace",
            expiresAt: "2030-01-01T00:00:00Z",
          },
        };
      else if (/\/system\/servers$/.test(url.pathname)) body = [];
      else if (url.pathname.endsWith("/cloud/status")) body = { connected: false };
      else if (url.pathname.endsWith("/auth/organization/list")) body = [];
      else if (url.pathname.includes("/issues/counts")) body = { total: 0, open: 0 };
      else if (url.pathname.endsWith("/domains")) body = { data: [] };
      else if (url.pathname.endsWith("/github/home"))
        body = {
          state: {
            primary: null,
            mode: "cli",
            sources: {
              openshipApp: { connected: false },
              ghCli: { available: false, authenticated: false },
              byoc: { connected: false },
            },
          },
          accounts: [],
          repos: [],
        };
      else if (dnsPreview)
        body = {
          data: {
            records: [{ type: "A", host: "shop", value: "203.0.113.10" }],
            mode: "selfhosted",
          },
        };
      await route.fulfill({
        status: request.method() === "OPTIONS" ? 204 : 200,
        headers: {
          "content-type": "application/json",
          "access-control-allow-origin": origin,
          "access-control-allow-credentials": "true",
          "access-control-allow-headers":
            request.headers()["access-control-request-headers"] ?? "content-type",
        },
        body: JSON.stringify(body),
      });
    });
    page = await context.newPage();
    page.on("pageerror", (error) => errors.push(`${locale}: ${error.stack}`));
    const deadline = Date.now() + 120_000;
    let response;
    do {
      response = await page.goto(`${origin}/landing-capture`, {
        waitUntil: "domcontentloaded",
        timeout: 120_000,
      });
      if (response?.status() !== 404) break;
      await page.waitForTimeout(500);
    } while (Date.now() < deadline);
    assert(response?.ok(), "The local capture route is unavailable");
    const dictionary = JSON.parse(
      await readFile(
        resolve(root, `apps/dashboard/src/i18n/locales/${locale}/importProject.json`),
        "utf8",
      ),
    );
    await page.locator('[data-capture-ready="true"]').waitFor();
    const configuration = page.locator("[data-capture-configuration]");
    await configuration
      .getByRole("button", { name: dictionary.projectSettings.change, exact: true })
      .click();
    await configuration
      .getByRole("button", { name: dictionary.categories.fullstack, exact: true })
      .waitFor();
    // The marketing composition shows two rows of frameworks. Omit the Webmail
    // card only in this capture; the product's picker remains unchanged.
    const frameworkLayout = await configuration
      .getByRole("button", { name: /Webmail/ })
      .evaluate((button) => {
        const grid = button.parentElement;
        button.remove();
        const cards = Array.from(grid.children);
        return {
          cards: cards.length,
          rows: new Set(cards.map((card) => Math.round(card.getBoundingClientRect().top))).size,
        };
      });
    assert.deepEqual(frameworkLayout, { cards: 12, rows: 2 });
    // End the marketing card after the command fields so the environment card
    // follows it. These rules affect only the temporary capture fixture.
    const outputDirectory = configuration.locator('input[id$="-outputDirectory"]');
    await page.addStyleTag({
      content: `
        [data-capture-framework] > div > div { padding: 16px; }
        [data-capture-framework] .grid > button { padding: 12px; }
        [data-capture-build] [role="group"] {
          grid-auto-flow: column;
          grid-template-columns: none;
          grid-auto-columns: max-content;
        }
        [data-capture-build] div:has(> input[id$="-outputDirectory"]),
        [data-capture-build] > div > button[aria-expanded] + div > :not(:first-child) {
          display: none !important;
        }
        [data-capture-build] > div > button[aria-expanded] + div > :first-child,
        [data-capture-build] div:has(> input[id$="-buildCommand"]) {
          margin-block-end: 0 !important;
        }
      `,
    });
    assert.equal(
      await outputDirectory.evaluate((input) => getComputedStyle(input.parentElement).display),
      "none",
    );
    assert.equal(await page.getByText(".next", { exact: true }).count(), 0);
    await page.evaluate(() => document.fonts.ready);
    await page
      .locator("[data-landing-capture] img")
      .evaluateAll((images) => Promise.all(images.map((image) => image.decode())));
    await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
    await page.mouse.move(1490, 780);
    await page.waitForTimeout(350);
    const buildCard = await page.locator("[data-capture-build]").boundingBox();
    const environmentCard = await page.locator("[data-capture-environment]").boundingBox();
    assert(
      environmentCard.y >= buildCard.y + buildCard.height,
      "Environment follows the deploy card",
    );
    assert(
      environmentCard.y + environmentCard.height <= 786,
      `The environment card fits in the capture: ${JSON.stringify({ buildCard, environmentCard })}`,
    );
    assert.equal(await page.locator("html").getAttribute("lang"), locale);
    assert.equal(await page.locator("html").getAttribute("dir"), locale === "ar" ? "rtl" : "ltr");
    assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
    assert.equal(
      await configuration
        .getByRole("button", { name: dictionary.categories.fullstack, exact: true })
        .getAttribute("aria-pressed"),
      "true",
    );
    assert.equal(
      await configuration.getByRole("button", { name: /Next\.js/ }).getAttribute("aria-pressed"),
      "true",
    );
    assert.equal(await page.getByText("acme/storefront", { exact: true }).count(), 1);
    const destination = resolve(output, locale);
    await mkdir(destination, { recursive: true });
    const png = await page.locator("[data-landing-capture]").screenshot({ animations: "disabled" });
    const size = await sharp(png).metadata();
    assert.equal(size.width, 2998);
    assert.equal(size.height, 1572);
    await sharp(png).webp({ lossless: true }).toFile(resolve(destination, "deploy.webp"));
    if (locale === "en") await writeFile(resolve(destination, "deploy.png"), png);
    console.log(
      `${locale}: 2998 × 1572, ${Math.round((await stat(resolve(destination, "deploy.webp"))).size / 1024)} KB`,
    );
    await context.close();
    page = undefined;
  }
  assert.deepEqual(errors, [], "Browser errors");
  assert.deepEqual(writes, [], "Unexpected API mutation attempts");
  if (!process.env.SCREENSHOT_OUTPUT && selected.includes("en")) {
    await copyFile(resolve(output, "en/deploy.png"), resolve(root, "apps/web/public/screen.png"));
    await copyFile(resolve(output, "en/deploy.png"), resolve(root, "docs/screenshots/screen.png"));
    await rm(resolve(output, "en/deploy.png"));
  }
  console.log("Captured the real Fullstack wizard with sample data; all API traffic intercepted.");
} catch (error) {
  if (page) {
    console.error((await page.locator("body").innerText()).slice(0, 2600), errors);
    const diagnosticOutput =
      process.env.SCREENSHOT_OUTPUT ?? resolve(tmpdir(), "openship-landing-capture");
    await mkdir(diagnosticOutput, { recursive: true });
    await page.screenshot({ path: resolve(diagnosticOutput, "capture-error.png") });
  }
  throw error;
} finally {
  await browser?.close();
  if (ownsRoute) await rm(routeDir, { recursive: true });
}
