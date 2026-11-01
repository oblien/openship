import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const origin = process.env.SCREENSHOT_ORIGIN ?? "http://localhost:3001";
const routeDir = resolve(root, "apps/dashboard/src/app/scaling-capture");
const output = resolve(root, "docs/screenshots/scaling");
const zoomed = process.argv.includes("--zoomed");
const uiZoomed = process.argv.includes("--ui-zoomed");
if (zoomed && uiZoomed) throw new Error("Choose either canvas zoom or interface zoom.");
const require = createRequire(import.meta.url);
const playwrightPath = process.env.PLAYWRIGHT_MODULE ?? require.resolve("playwright");
const { chromium } = await import(pathToFileURL(playwrightPath).href);
let browser;
let page;
let ownsRoute = false;

try {
  // Never overwrite an existing application route. This directory is ours only
  // if its exclusive creation succeeds, and is removed even when capture fails.
  await mkdir(routeDir);
  ownsRoute = true;
  await writeFile(resolve(routeDir, "Preview.tsx"), await readFile(resolve(here, "Preview.tsx")), { flag: "wx" });
  await writeFile(resolve(routeDir, "page.tsx"), [
    'import { notFound } from "next/navigation";',
    'import Preview from "./Preview";',
    'export default function Page() {',
    '  if (process.env.NODE_ENV !== "development") notFound();',
    `  return <Preview zoomed={${zoomed}} />;`,
    '}',
  ].join("\n"), { flag: "wx" });
  await mkdir(output, { recursive: true });
  browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  });
  const context = await browser.newContext({
    // The whole interface is 25% larger at the same 3200px output width. A little
    // extra height keeps the fitted topology readable. Canvas zoom is untouched.
    viewport: uiZoomed ? { width: 1280, height: 960 } : { width: 1600, height: 1080 },
    deviceScaleFactor: uiZoomed ? 2.5 : 2,
    reducedMotion: "reduce",
    locale: "en-US",
    serviceWorkers: "block",
  });
  // The temporary page lives outside the authenticated dashboard layout. This
  // synthetic, invalid cookie only satisfies the proxy's presence check; it
  // grants no access to the API and never touches the user's browser profile.
  await context.addCookies([{ name: "capture.session_token", value: "visual-fixture-only", url: origin }]);
  await context.addInitScript(() => localStorage.setItem("theme", "dim"));
  let apiRequests = 0;
  const unexpectedWrites = [];
  await context.route("**/api/**", async (route) => {
    apiRequests += 1;
    const request = route.request();
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) unexpectedWrites.push(request.url());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": origin, "access-control-allow-credentials": "true" },
      body: "null",
    });
  });
  page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.error(error.message);
  });
  await page.goto(`${origin}/scaling-capture`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  if (errors.length) throw new Error(errors.join("\n"));
  console.log("Capture page loaded.");
  await page.locator(".scale-resource-node").first().waitFor({ timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
  // The Next development badge is chrome, not part of the product screenshot.
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });

  async function capture(filename, expectedNodes) {
    await page.waitForFunction((expected) => document.querySelectorAll(".scale-resource-node").length === expected, expectedNodes);
    await page.getByRole("button", { name: "Fit topology to view", exact: true }).click();
    if (zoomed) {
      await page.waitForTimeout(400);
      await page.getByRole("button", { name: "Zoom in", exact: true }).click();
    }
    await page.mouse.move(12, 12);
    // Fit is animated by React Flow; wait for node geometry to settle.
    await page.waitForTimeout(600);
    const bounds = await page.evaluate(() => {
      const canvas = document.querySelector(".scale-workspace").getBoundingClientRect();
      const controls = [...document.querySelectorAll(".scale-toolbar, .scale-canvas-controls")]
        .map((element) => element.getBoundingClientRect());
      return {
        overflow: document.documentElement.scrollHeight > innerHeight,
        clipped: [...document.querySelectorAll(".scale-resource-node")].some((node) => {
          const rect = node.getBoundingClientRect();
          return rect.left < canvas.left || rect.right > canvas.right || rect.top < canvas.top || rect.bottom > canvas.bottom;
        }),
        covered: [...document.querySelectorAll(".scale-resource-node")].some((node) => {
          const rect = node.getBoundingClientRect();
          return controls.some((control) => rect.left < control.right && rect.right > control.left && rect.top < control.bottom && rect.bottom > control.top);
        }),
      };
    });
    if (bounds.overflow || bounds.clipped || bounds.covered) throw new Error(`Screenshot content is obscured: ${JSON.stringify(bounds)}`);
    const suffix = uiZoomed ? "-ui-zoomed" : zoomed ? "-zoomed" : "";
    const outputFilename = filename.replace(/\.png$/, `${suffix}.png`);
    await page.screenshot({ path: resolve(output, outputFilename), fullPage: false, animations: "disabled" });
    console.log(`Saved docs/screenshots/scaling/${outputFilename}`);
  }

  await capture("scaling-topology.png", 6);
  await page.getByRole("button", { name: "Open Orders cluster", exact: true }).click();
  await capture("postgres-replicas.png", 3);
  await page.getByRole("button", { name: "Back to overview", exact: true }).click();
  await page.getByRole("button", { name: "Open Sessions cluster", exact: true }).click();
  await capture("redis-cluster.png", 6);
  if (errors.length) throw new Error(`Browser errors: ${errors.join("\n")}`);
  if (unexpectedWrites.length) throw new Error(`Unexpected API mutation attempts: ${unexpectedWrites.join(", ")}`);
  await rm(resolve(output, "capture-error.png"), { force: true });
  console.log(`Verified three views, no clipped nodes, no browser errors. ${apiRequests} API reads intercepted; no API mutations.`);
} catch (error) {
  if (page) {
    console.error((await page.locator("body").innerText()).slice(0, 2500));
    await page.screenshot({ path: resolve(output, "capture-error.png"), fullPage: false });
  }
  throw error;
} finally {
  await browser?.close();
  if (ownsRoute) await rm(routeDir, { recursive: true });
}
