import assert from "node:assert/strict";
import { writeFile, mkdir, cp } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const require = createRequire(import.meta.url);
const { chromium } = await import(
  pathToFileURL(process.env.PLAYWRIGHT_MODULE || require.resolve("playwright")).href
);
const origin = process.env.PREVIEW_ORIGIN || "http://127.0.0.1:3012";
const api = "http://127.0.0.1:3013";
const output = "artifacts/project-consistency";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
});
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  reducedMotion: "reduce",
});
await context.addCookies([
  { name: "openship-theme", value: "dark:dark", url: origin },
  { name: "openship-locale", value: "en", url: origin },
]);
const page = await context.newPage(),
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const shot = async (name) => {
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
  await page
    .getByRole("alert")
    .last()
    .waitFor({ state: "hidden", timeout: 6000 })
    .catch(() => {});
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await page.screenshot({ path: `${output}/${name}.png`, fullPage: true });
};
const scenario = async (services, reset = false) => {
  await fetch(api + "/api/preview/scenario", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ services, reset }),
  });
};
try {
  await scenario(false, true);
  await page.goto(origin + "/projects/environment-preview/services", {
    waitUntil: "networkidle",
    timeout: 120000,
  });
  await page.locator('a[href="/projects/environment-preview/services/application"]').waitFor();
  assert.equal(await page.locator("ul > li").count(), 1);
  assert.equal(
    await page.getByText("The active deployment changed. Refresh the project.").count(),
    0,
  );
  await shot("after-single-app");
  await page.locator('a[href="/projects/environment-preview/services/application"]').click();
  await page.getByRole("heading", { name: "website", exact: true }).waitFor();
  await shot("after-app-overview");
  await page.locator('a[href$="/application/env"]').click();
  await page.locator('input[value="SITE_URL"]').waitFor();
  await shot("after-app-environment");
  await page.locator('input[value="info"]').fill("debug");
  await page.getByRole("button", { name: "Save environment", exact: true }).click();
  await page
    .getByRole("button", { name: "Apply & restart", exact: true })
    .waitFor({ state: "visible" });
  const state = await (await fetch(api + "/api/preview/scenario")).json();
  assert.equal(state.writes.filter((w) => w.path === "/api/deployments").length, 0);
  assert.ok(!state.writes[0].input.upserts.some((row) => row.key === "API_SECRET"));
  await page.locator('a[href$="/application/overview"]').click();
  await page.locator('a[href$="/application/env"]').click();
  assert.equal(await page.locator('input[value="debug"]').count(), 1);
  await page.getByRole("button", { name: "Apply & restart", exact: true }).click();
  await page.locator('a[href="/build/preview-apply"]').waitFor();
  await shot("after-app-apply");
  await page.getByRole("button", { name: "All services", exact: true }).click();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.locator("[data-modal-surface]").waitFor();
  await shot("after-add-service");
  console.log(
    "ADD DIALOG",
    (await page.locator("[data-modal-surface]").innerText()).slice(0, 2500),
  );
  await page
    .locator("[data-modal-surface]")
    .getByRole("button", { name: /PostgreSQL/ })
    .click();
  console.log("ADD FORM", (await page.locator("[data-modal-surface]").innerText()).slice(0, 2500));
  await shot("after-add-postgres-form");
  // The actual Add form creates and starts only its own service in the fixture.
  const dialog = page.locator("[data-modal-surface]");
  await dialog.getByRole("button", { name: /^Add/ }).last().click();
  await dialog.waitFor({ state: "hidden" });
  await page.waitForURL(/\/services\/[^/]+$/);
  await page.getByRole("button", { name: "All services", exact: true }).click();
  await page.locator('a[href="/projects/environment-preview/services/application"]').waitFor();
  assert.equal(await page.locator("ul > li").count(), 2);
  await shot("after-with-postgres");
  // Return to exactly the same primary route and saved project-owned environment.
  await page.locator('a[href="/projects/environment-preview/services/application"]').click();
  await page.locator('a[href$="/application/env"]').click();
  await page.locator('input[value="debug"]').waitFor();
  await shot("after-app-with-postgres");
  await page.getByRole("button", { name: "All services", exact: true }).click();
  const databaseLink = page.locator("ul > li a").filter({ hasText: /postgres/i });
  await databaseLink.click();
  await page.locator('a[href$="/env"]').click();
  await page.locator('input[value="POSTGRES_DB"]').waitFor();
  await shot("after-postgres-environment");
  await page.locator('a[href="/projects/environment-preview/advanced"]').click();
  await page.getByText("Shared project environment", { exact: true }).waitFor();
  await shot("after-project-settings");
  await page.goto(origin + "/projects/environment-preview/services/application/env", {
    waitUntil: "networkidle",
  });
  await page.locator('input[value="SITE_URL"]').waitFor();
  for (const theme of ["light", "dim", "dark"]) {
    await page.evaluate((theme) => {
      localStorage.setItem("theme", theme);
      document.cookie = `openship-theme=${theme}:${theme};path=/`;
    }, theme);
    await page.reload({ waitUntil: "networkidle" });
    await page.locator('input[value="SITE_URL"]').waitFor();
    await shot(`after-app-${theme}`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await shot("after-mobile");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await context.addCookies([{ name: "openship-locale", value: "ar", url: origin }]);
  await page.reload({ waitUntil: "networkidle" });
  await page.locator('input[value="SITE_URL"]').waitFor();
  assert.equal(await page.locator("html").getAttribute("dir"), "rtl");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await shot("after-arabic-mobile");
  assert.deepEqual(errors, []);
  await writeFile(
    `${output}/browser-checks.json`,
    JSON.stringify(
      {
        errors,
        checks: [
          "single list entry",
          "same app route after adding PostgreSQL through the real Add form",
          "saved app env retained",
          "untouched secret preserved",
          "save separate from apply",
          "draft retained across tabs",
          "shared settings scope",
          "service editor",
          "light/dim/dark",
          "mobile/Arabic overflow",
        ],
        writes: (await (await fetch(api + "/api/preview/scenario")).json()).writes,
      },
      null,
      2,
    ),
  );
  // Leave the preview at the simple starting point for the reviewer.
  await scenario(false, true);
  console.log("All preview checks passed");
} catch (error) {
  await shot("diagnostic");
  console.error("PAGE", (await page.locator("body").innerText()).slice(0, 3500));
  console.error("ERRORS", errors);
  throw error;
} finally {
  await browser.close();
}
