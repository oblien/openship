import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const origin = process.env.SCREENSHOT_ORIGIN ?? "http://localhost:3001";
const routeDir = resolve(root, "apps/dashboard/src/app/migration-capture");
const output = resolve(root, "apps/web/public/migrations");
const require = createRequire(import.meta.url);
const { chromium } = await import(
  pathToFileURL(process.env.PLAYWRIGHT_MODULE ?? require.resolve("playwright")).href
);
let browser;
let ownsRoute = false;
const errors = [];
const writes = [];

try {
  await mkdir(routeDir);
  ownsRoute = true;
  await writeFile(resolve(routeDir, "Preview.tsx"), await readFile(resolve(here, "Preview.tsx")), {
    flag: "wx",
  });
  await writeFile(
    resolve(routeDir, "page.tsx"),
    [
      'import { notFound } from "next/navigation";',
      'import Preview from "./Preview";',
      "export default async function Page({ searchParams }: { searchParams: Promise<{ provider?: string }> }) {",
      '  if (process.env.NODE_ENV !== "development") notFound();',
      "  const { provider } = await searchParams;",
      '  if (provider !== "railway" && provider !== "vercel") notFound();',
      "  return <Preview provider={provider} />;",
      "}",
    ].join("\n"),
    { flag: "wx" },
  );
  await mkdir(output, { recursive: true });
  browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1200, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: "light",
    reducedMotion: "reduce",
    locale: "en-US",
    timezoneId: "UTC",
    serviceWorkers: "block",
  });
  // Presence-only proxy check. This development route is outside the dashboard
  // layout, so this invalid fixture cookie grants no access to real account data.
  await context.addCookies([
    { name: "capture.session_token", value: "visual-fixture-only", url: origin },
    { name: "openship-theme", value: "light:light", url: origin },
  ]);
  await context.addInitScript(() => localStorage.setItem("theme", "light"));
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.includes("/api/") || url.pathname.startsWith("/health")) {
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) writes.push(url.pathname);
      await route.fulfill({
        status: request.method() === "OPTIONS" ? 204 : 200,
        headers: {
          "content-type": "application/json",
          "access-control-allow-origin": origin,
          "access-control-allow-credentials": "true",
          "access-control-allow-headers":
            request.headers()["access-control-request-headers"] ?? "content-type",
        },
        body: "null",
      });
      return;
    }
    await route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  for (const provider of ["railway", "vercel"]) {
    const response = await page.goto(`${origin}/migration-capture?provider=${provider}`, {
      waitUntil: "networkidle",
      timeout: 120_000,
    });
    assert.equal(response?.ok(), true, "The local dashboard capture route is unavailable");
    await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
    const frame = page.locator(`[data-migration-capture="${provider}"]`);
    await frame.waitFor();
    await page.evaluate(() => document.fonts.ready);
    await frame
      .locator("img")
      .evaluateAll((images) => Promise.all(images.map((image) => image.decode())));
    assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
    assert.equal(
      await frame.evaluate((el) => el.scrollHeight > el.clientHeight),
      false,
      "Capture is clipped",
    );
    const image = await frame.screenshot({ animations: "disabled" });
    const filename = `${provider}-review.webp`;
    const result = await sharp(image).webp({ quality: 92 }).toFile(resolve(output, filename));
    console.log(
      `${filename}: ${result.width} × ${result.height}, ${Math.round(result.size / 1024)} KB`,
    );
  }
  assert.deepEqual(errors, [], "Browser errors");
  assert.deepEqual(writes, [], "Unexpected API mutation attempts");
  console.log("Captured the real import review in light theme; sample data only, no API writes.");
} finally {
  await browser?.close();
  if (ownsRoute) await rm(routeDir, { recursive: true });
}
