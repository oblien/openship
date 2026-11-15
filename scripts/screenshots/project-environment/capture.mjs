import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const origin = process.env.SCREENSHOT_ORIGIN ?? "http://localhost:3001";
const phase = process.env.SCREENSHOT_PHASE ?? "after";
const output = process.env.SCREENSHOT_OUTPUT ?? resolve(root, "artifacts/project-environment");
const temporary = resolve(root, "apps/dashboard/src/app/project-environment-capture");
const require = createRequire(import.meta.url);
const { chromium } = await import(
  pathToFileURL(process.env.PLAYWRIGHT_MODULE ?? require.resolve("playwright")).href
);
let browser,
  page,
  ownsRoute = false;
const errors = [],
  writes = [];
let env = [
  {
    id: "site",
    key: "SITE_URL",
    value: "https://website.example.com",
    environment: "production",
    isSecret: false,
  },
  { id: "log", key: "LOG_LEVEL", value: "info", environment: "production", isSecret: false },
  { id: "token", key: "API_SECRET", value: "••••••••", environment: "production", isSecret: true },
];
const initialEnv = structuredClone(env);
const project = {
  id: "environment-preview",
  name: "website",
  slug: "website",
  description: "",
  framework: "nextjs",
  activeDeploymentId: "live-preview",
  status: "ready",
  runtimeMode: "bare",
  deployTarget: "server",
  options: { workloadType: "web", hasServer: true },
};
let currentProject = project;
try {
  await mkdir(temporary);
  ownsRoute = true;
  await writeFile(resolve(temporary, "Preview.tsx"), await readFile(resolve(here, "Preview.tsx")), {
    flag: "wx",
  });
  await writeFile(
    resolve(temporary, "page.tsx"),
    'import { notFound } from "next/navigation"; import Preview from "./Preview"; export default function Page() { if (process.env.NODE_ENV !== "development") notFound(); return <Preview />; }',
    { flag: "wx" },
  );
  await mkdir(output, { recursive: true });
  browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
    locale: "en-US",
    serviceWorkers: "block",
  });
  await context.addCookies([
    { name: "capture.session_token", value: "visual-fixture-only", url: origin },
    { name: "openship-theme", value: "dark:dark", url: origin },
    { name: "openship-locale", value: "en", url: origin },
  ]);
  await context.addInitScript(() => {
    if (!localStorage.getItem("theme")) localStorage.setItem("theme", "dark");
  });
  await context.route("**/*", async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    if (url.pathname.includes("/api/") || url.pathname.startsWith("/health")) {
      const headers = {
        "access-control-allow-origin": origin,
        "access-control-allow-credentials": "true",
        "access-control-allow-headers":
          req.headers()["access-control-request-headers"] ?? "content-type",
        "access-control-allow-methods": "GET,POST,PATCH,OPTIONS",
      };
      if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
      let body = { success: true, data: [] };
      if (!["GET", "HEAD"].includes(req.method())) {
        const input = req.postDataJSON();
        writes.push({ path: url.pathname, input });
        if (req.method() === "PATCH" && url.pathname.endsWith("/env")) {
          assert.ok(input.upserts.every((row) => row.key !== "API_SECRET"));
          env = env.filter((row) => !input.deletes.includes(row.key));
          for (const row of input.upserts) {
            env = env.filter((saved) => saved.key !== row.key);
            env.push({ id: row.key, environment: "production", ...row });
          }
          body = { upserted: input.upserts.length, deleted: input.deletes.length };
        } else if (url.pathname.endsWith("/deployments")) {
          body = { data: { deployment: { id: "preview-apply" } } };
        } else throw new Error(`Unexpected fixture write: ${url.pathname}`);
      } else if (url.pathname.endsWith("/get-session")) body = null;
      else if (url.pathname.endsWith("/info"))
        body = { success: true, data: { project: currentProject, environments: [] } };
      else if (url.pathname.endsWith("/env")) body = { data: env };
      else if (url.pathname.endsWith("/services")) body = { success: true, services: [] };
      else if (url.pathname.endsWith("/containers")) body = { success: true, containers: [] };
      else if (url.pathname.endsWith("/roles"))
        body = {
          data: {
            projectId: project.id,
            deploymentId: project.activeDeploymentId,
            roles: [],
            error: null,
          },
        };
      else if (url.pathname.endsWith("/health/env"))
        body = { selfHosted: true, deployMode: "server", authMode: "none", version: "0.9.11" };
      return route.fulfill({
        status: 200,
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
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.error(error.stack);
  });
  const visit = async (view) => {
    currentProject = {
      ...project,
      ...(view.includes("kind=static")
        ? { options: { workloadType: "static", hasServer: false } }
        : {}),
      ...(view.includes("kind=cloud") ? { deployTarget: "cloud" } : {}),
      ...(view.includes("kind=docker") ? { runtimeMode: "docker" } : {}),
    };
    // Next's dev watcher can briefly serve a cached 404 when a temporary route
    // is recreated. Wait for the actual fixture before testing its controls.
    for (let attempt = 0; attempt < 4; attempt++) {
      await page.goto(`${origin}/project-environment-capture?view=${view}`, {
        waitUntil: "networkidle", timeout: 120_000,
      });
      const ready = await page.locator("[data-environment-capture]").waitFor({ timeout: 5_000 })
        .then(() => true, () => false);
      if (ready) break;
      if (attempt === 3) throw new Error("The temporary capture route did not become available");
    }
    await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  };
  const shot = async (name) => {
    await page.screenshot({
      path: resolve(output, `${phase}-${name}.png`),
      fullPage: true,
      animations: "disabled",
    });
  };
  await visit("services");
  await page.getByRole("link", { name: "Deployments", exact: true }).waitFor();
  await shot("apps-services");
  if (phase === "after") {
    const environment = page.getByRole("link", { name: "Environment", exact: true });
    assert.equal(
      await environment.getAttribute("href"),
      `/projects/${project.id}/services/application/env`,
    );
  }
  await visit("settings");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator('input[value="LOG_LEVEL"]').waitFor();
  await shot("settings-editor");
  if (phase === "after") {
    assert.equal(writes.length, 0, "Opening either view must not mutate the project");
    await visit("application");
    await page.locator('input[value="LOG_LEVEL"]').waitFor();
    await shot("application-environment");
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await shot("application-mobile");
    await page.setViewportSize({ width: 1280, height: 900 });
    const row = page
      .locator("[data-env-index]")
      .filter({ has: page.locator('input[value="LOG_LEVEL"]') });
    await row.locator("input").nth(1).fill("debug");
    const apply = page.getByRole("button", { name: "Apply & restart", exact: true });
    assert.equal(await apply.isDisabled(), true);
    await page.getByRole("button", { name: "Save environment", exact: true }).click();
    await page.waitForFunction(() =>
      [...document.querySelectorAll("button")].some(
        (button) => button.textContent.trim() === "Apply & restart" && !button.disabled,
      ),
    );
    assert.equal(writes.length, 1, "Saving must not deploy");
    assert.deepEqual(writes[0].input, {
      environment: "production",
      upserts: [{ key: "LOG_LEVEL", value: "debug", isSecret: false }],
      deletes: [],
    });
    await apply.click();
    await page.locator('a[href="/build/preview-apply"]').waitFor();
    assert.deepEqual(writes[1].input, { projectId: project.id, refresh: true });
    await shot("application-apply");
    await visit("settings");
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page.locator('input[value="debug"]').waitFor();
    assert.equal(
      await page.getByRole("button", { name: "Apply & restart", exact: true }).isDisabled(),
      false,
    );
    assert.equal(writes.length, 2, "Reopening must not save or deploy");
    for (const kind of ["static", "cloud"]) {
      await visit(`application&kind=${kind}`);
      await page.locator('input[value="LOG_LEVEL"]').waitFor();
      assert.equal(
        await page.getByRole("button", { name: "Apply & restart", exact: true }).count(),
        0,
      );
      assert.equal(
        await page.getByRole("button", { name: "Rebuild and redeploy", exact: true }).isEnabled(),
        true,
      );
    }
    // Return to identical sample values for theme and RTL visual comparisons.
    env = structuredClone(initialEnv);
    await visit("services&kind=docker");
    await page.getByRole("button", { name: "Configure roles", exact: true }).waitFor();
    await shot("apps-services-docker");
    for (const theme of ["light", "dim"]) {
      await context.addCookies([
        { name: "openship-theme", value: `${theme}:${theme}`, url: origin },
      ]);
      await page.evaluate((value) => localStorage.setItem("theme", value), theme);
      await visit("application");
      await page.locator('input[value="LOG_LEVEL"]').waitFor();
      assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
      await shot(`application-${theme}`);
    }
    await context.addCookies([{ name: "openship-locale", value: "ar", url: origin }]);
    await page.evaluate(() => localStorage.setItem("openship-locale", "ar"));
    await page.setViewportSize({ width: 390, height: 844 });
    await visit("application");
    await page.locator('input[value="LOG_LEVEL"]').waitFor();
    assert.equal(await page.locator("html").getAttribute("dir"), "rtl");
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await shot("application-arabic-mobile");
  }
  assert.deepEqual(errors, []);
  await writeFile(
    resolve(output, `${phase}-browser-checks.json`),
    JSON.stringify(
      {
        source: "Actual dashboard components with intercepted sample API responses",
        errors,
        writes,
        checks:
          phase === "after"
            ? [
                "Read-only page load",
                "Save preserves masked secret",
                "Apply disabled with unsaved edits",
                "Save does not deploy",
                "Apply uses refresh without build",
                "Update progress link",
                "Reopen Settings shows the same saved values and Apply",
                "Static and Cloud require rebuilding",
                "No mobile overflow",
                "Light, dim and dark",
                "Arabic RTL mobile",
              ]
            : ["Read-only page load"],
      },
      null,
      2,
    ),
  );
  console.log(`Captured ${phase} screenshots in ${output}`);
} catch (error) {
  if (page) {
    await page.screenshot({ path: resolve(output, "capture-error.png"), fullPage: true });
    console.error(page.url(), await page.locator("body").innerText(), errors);
  }
  throw error;
} finally {
  await browser?.close();
  if (ownsRoute) await rm(temporary, { recursive: true, force: true });
}
