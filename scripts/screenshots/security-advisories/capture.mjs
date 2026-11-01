import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const origin = process.env.SCREENSHOT_ORIGIN ?? "http://localhost:3001";
const routeDir = resolve(root, "apps/dashboard/src/app/security-advisory-capture");
const output =
  process.env.SCREENSHOT_OUTPUT ?? resolve(root, "docs/screenshots/security-advisories");
const require = createRequire(import.meta.url);
const modulePath = process.env.PLAYWRIGHT_MODULE ?? require.resolve("playwright");
const { chromium } = await import(pathToFileURL(modulePath).href);
const source = JSON.parse(await readFile(resolve(root, "security-advisories.json"), "utf8"));
const advisory = source.advisories.find((item) => item.id === "CVE-2026-111497-node");
assert.ok(advisory);
let status = {
  projectId: "security-preview",
  deploymentId: "deployed-preview",
  checkedAt: "2026-10-24T09:00:00.000Z",
  autoRefresh: false,
  feedStale: false,
  feedError: null,
  unknownServices: [],
  findings: [
    {
      id: advisory.id,
      revision: advisory.revision,
      title: advisory.title,
      message: advisory.message,
      severity: advisory.severity,
      url: advisory.url,
      serviceId: "api-preview",
      serviceName: "api",
      evidence: ["node 22.23.3"],
      confidence: "confirmed",
      canRefresh: true,
    },
  ],
};
let browser,
  page,
  ownsRoute = false;
const writes = [],
  errors = [];
try {
  // Exclusive creation avoids replacing any route another task owns. Always remove it.
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
      "export default function Page() {",
      '  if (process.env.NODE_ENV !== "development") notFound();',
      "  return <Preview />;",
      "}",
    ].join("\n"),
    { flag: "wx" },
  );
  await mkdir(output, { recursive: true });
  browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  });
  const context = await browser.newContext({
    viewport: { width: 1400, height: 1060 },
    deviceScaleFactor: 1.5,
    reducedMotion: "reduce",
    locale: "en-US",
    timezoneId: "UTC",
    serviceWorkers: "block",
  });
  // Presence only for the development page; this cookie grants no API access.
  await context.addCookies([
    { name: "capture.session_token", value: "visual-fixture-only", url: origin },
  ]);
  await context.addInitScript(() => localStorage.setItem("theme", "dim"));
  await context.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.pathname.includes("/api/") || url.pathname.startsWith("/health")) {
      const headers = {
        "access-control-allow-origin": origin,
        "access-control-allow-credentials": "true",
      };
      if (request.method() === "OPTIONS") {
        return route.fulfill({
          status: 204,
          headers: {
            ...headers,
            "access-control-allow-headers":
              request.headers()["access-control-request-headers"] ?? "content-type",
            "access-control-allow-methods": "GET,PUT,POST,OPTIONS",
          },
        });
      }
      let body = null,
        code = 200;
      if (request.method() !== "GET" && request.method() !== "HEAD") {
        writes.push({
          method: request.method(),
          path: url.pathname,
          body: request.postData() ? request.postDataJSON() : null,
        });
        if (url.pathname.endsWith("/security/check")) {
          body = { data: status };
        } else if (url.pathname.endsWith("/security/policy")) {
          status.autoRefresh = request.postDataJSON().autoRefresh;
          body = { data: { autoRefresh: status.autoRefresh } };
        } else if (url.pathname.endsWith("/security/apply")) {
          code = 409;
          body = { error: "The active deployment changed. Check the advisory again." };
        } else throw new Error(`Unexpected capture write: ${request.method()} ${url.pathname}`);
      } else if (url.pathname.endsWith("/health/env")) {
        body = { selfHosted: true, deployMode: "docker", authMode: "local", version: "0.9.3" };
      } else if (url.pathname.endsWith("/updates/advisories")) {
        body = {
          data: {
            release: { latest: null, manifest: { advisories: [] } },
            security: { ...source, advisories: [advisory] },
            stale: status.feedStale,
            error: status.feedError,
            checkedAt: status.checkedAt,
            nextCheckAt: null,
            overview: {
              projects: [{ ...status, name: "Commerce API", workspaceId: null }],
              pendingProjects: 0,
              unknownProjects: 0,
            },
          },
        };
      } else if (url.pathname.endsWith("/notices")) body = { advisories: [] };
      else if (url.pathname.endsWith("/security")) body = { data: status };
      return route.fulfill({
        status: code,
        contentType: "application/json",
        headers,
        body: JSON.stringify(body),
      });
    }
    if (url.origin === origin || ["cdn.oblien.com", "cdn.simpleicons.org"].includes(url.hostname))
      return route.continue();
    return route.abort();
  });
  page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/security-advisory-capture`, {
    waitUntil: "domcontentloaded",
    timeout: 120_000,
  });
  const refresh = page.getByRole("button", { name: "Refresh images & redeploy", exact: true });
  const review = page.getByRole("button", { name: "Review affected apps (1)", exact: true });
  await review.waitFor({ timeout: 45_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  await page.screenshot({
    path: resolve(output, "advisory-found.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({
    path: resolve(output, "advisory-found-mobile.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 1400, height: 1060 });
  await review.click();
  await refresh.waitFor();
  const consent = page.getByRole("switch", {
    name: "Automatically refresh verified security patches",
    exact: true,
    includeHidden: true,
  });
  assert.equal(await consent.getAttribute("aria-checked"), "false");
  assert.equal(writes.length, 0);
  assert.equal(await page.locator("details").first().getAttribute("open"), "");
  assert.equal(await refresh.isEnabled(), true);
  await page.screenshot({
    path: resolve(output, "advisory-review.png"),
    fullPage: false,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({
    path: resolve(output, "advisory-review-mobile.png"),
    fullPage: false,
    animations: "disabled",
  });

  // Real UI handlers and API client; every write is intercepted in this browser.
  await Promise.all([
    page.waitForResponse((response) => response.url().endsWith("/security/check")),
    page.getByRole("button", { name: "Check again", exact: true }).click(),
  ]);
  await page
    .locator("summary")
    .filter({ hasText: "Automatically refresh verified security patches" })
    .click();
  await consent.click();
  await page.waitForFunction(
    () => document.querySelector('[role="switch"]')?.getAttribute("aria-checked") === "true",
  );
  await consent.click();
  await page.waitForFunction(
    () => document.querySelector('[role="switch"]')?.getAttribute("aria-checked") === "false",
  );
  await refresh.click();
  await page
    .getByText("The active deployment changed. Check the advisory again.", { exact: true })
    .waitFor();
  assert.deepEqual(
    writes.map((item) => item.body),
    [
      null,
      { autoRefresh: true },
      { autoRefresh: false },
      { advisoryId: advisory.id, deploymentId: "deployed-preview", serviceId: "api-preview" },
    ],
  );
  status = { ...status, feedStale: true, feedError: "Advisory feed unavailable" };
  await page.reload({ waitUntil: "domcontentloaded" });
  await review.click();
  await refresh.waitFor();
  assert.equal(await refresh.isDisabled(), true);
  assert.equal(writes.length, 4);
  await page.locator("[data-modal-surface] > button").click();
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  assert.equal(await review.count(), 0);
  await page.getByRole("link", { name: "Preview monitoring", exact: true }).click();
  await page.getByRole("tab", { name: /Security/ }).waitFor();
  await page.locator("summary").filter({ hasText: "Commerce API" }).waitFor();
  assert.equal(await review.count(), 0);
  assert.equal(await refresh.isDisabled(), true);
  await page.setViewportSize({ width: 1400, height: 1060 });
  await page.screenshot({ path: resolve(output, "monitoring-security.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({
    path: resolve(output, "monitoring-security-mobile.png"),
    fullPage: true,
  });
  // A resolved advisory must not make existing automatic-refresh consent unreachable.
  status = { ...status, findings: [], autoRefresh: true, feedStale: false, feedError: null };
  await page.goto(`${origin}/security-advisory-capture?settings=1`, {
    waitUntil: "domcontentloaded",
  });
  await page.getByRole("button", { name: "Security advisories", exact: true }).click();
  assert.equal(await review.count(), 0);
  await page.getByText("Commerce API", { exact: true }).click();
  await page
    .locator("summary")
    .filter({ hasText: "Automatically refresh verified security patches" })
    .click();
  await consent.waitFor();
  assert.equal(await consent.getAttribute("aria-checked"), "true");
  await consent.click();
  await page.getByRole("button", { name: "Other apps (1)", exact: true }).waitFor();
  assert.equal(writes.length, 5);
  assert.deepEqual(writes[4].body, { autoRefresh: false });
  assert.deepEqual(errors, []);
  await writeFile(
    resolve(output, "browser-checks.json"),
    JSON.stringify(
      {
        fixture: true,
        noRealApiWrites: true,
        checks: [
          "root banner appears on Home without opening a project",
          "review opens affected apps from the banner",
          "auto refresh off by default",
          "desktop and mobile",
          "manual evidence check without deployment",
          "explicit consent",
          "exact apply scope",
          "changed deployment error",
          "stale feed blocks refresh",
          "dismissal keeps active findings accessible in Monitoring",
          "Monitoring review fits desktop and mobile",
          "no banner for resolved runtime findings",
          "consent can be revoked globally after resolution",
        ],
        errors,
        writes,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`Captured the real advisory component and verified 13 browser checks in ${output}`);
} catch (error) {
  if (page) {
    console.error((await page.locator("body").innerText()).slice(0, 2500));
    await page.screenshot({ path: resolve(output, "capture-error.png"), fullPage: true });
  }
  throw error;
} finally {
  await browser?.close();
  if (ownsRoute) await rm(routeDir, { recursive: true });
}
