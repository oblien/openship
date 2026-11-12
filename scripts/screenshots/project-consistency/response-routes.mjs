import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = await import(
  pathToFileURL(process.env.PLAYWRIGHT_MODULE || require.resolve("playwright")).href
);
const origin = process.env.PREVIEW_ORIGIN || "http://127.0.0.1:3012";
const api = process.env.PREVIEW_API_ORIGIN || "http://127.0.0.1:3013";
const output = "artifacts/project-consistency";
await mkdir(output, { recursive: true });
// Refuse to run mutations against anything except the sample fixture.
const fixture = await fetch(`${api}/api/preview/scenario`).then((response) => response.json());
assert.equal(fixture.project?.id, "environment-preview");
await fetch(`${api}/api/preview/scenario`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ reset: true, services: false }),
});

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
});
const errors = [];
const checks = [];
let activePage;
const route = `${origin}/projects/environment-preview/services/application/domains`;
const shot = async (page, name) => {
  const editor = name.includes("editor");
  if (editor) {
    await page.getByRole("dialog").waitFor();
    await page.waitForFunction(() =>
      [...document.querySelectorAll("[data-modal-surface]")].every(
        (element) => getComputedStyle(element).opacity === "1",
      ),
    );
  }
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await page.screenshot({ path: `${output}/${name}.png`, fullPage: !editor });
};
const overflow = async (page) =>
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1),
    false,
  );

const visibleSave = async (page, label = "Save response") => {
  const box = await page.getByRole("button", { name: label, exact: true }).boundingBox();
  assert.ok(
    box && box.y >= 0 && box.y + box.height <= page.viewportSize().height,
    "Save must stay visible without scrolling the form",
  );
};

try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1080 },
    reducedMotion: "reduce",
  });
  await context.addCookies([
    { name: "openship-theme", value: "dark:dark", url: origin },
    { name: "openship-locale", value: "en", url: origin },
  ]);
  const page = await context.newPage();
  activePage = page;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(route, { waitUntil: "domcontentloaded", timeout: 180000 });
  const add = page.getByRole("button", { name: "Add route", exact: true });
  await add.waitFor({ timeout: 60000 });
  await shot(page, "virtual-routes-empty");

  await add.click();
  await page.getByLabel("Path", { exact: true }).fill("/health");
  await page.getByRole("button", { name: "Content type", exact: true }).click();
  await page.getByRole("option", { name: "JSON", exact: true }).click();
  await page
    .getByLabel("Response body", { exact: true })
    .fill('{\n  "status": "ok",\n  "service": "website"\n}');
  await page.getByRole("button", { name: "Add header", exact: true }).click();
  await page.getByLabel("Header name 1", { exact: true }).fill("Cache-Control");
  await page.getByLabel("Header value 1", { exact: true }).fill("no-store");
  await shot(page, "virtual-routes-editor-dark");
  await page.getByText("Response preview", { exact: true }).click();
  assert.match(await page.locator("pre").innerText(), /HTTP\/1.1 200/);
  await page.getByRole("button", { name: "Save response", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByText("Saved and applied to the edge.", { exact: true }).waitFor();
  checks.push("Create a domain response with content type, body, and custom headers");

  await page.getByRole("button", { name: "Disable /health", exact: true }).click();
  await page.getByRole("button", { name: "Enable /health", exact: true }).waitFor();
  await page.getByRole("button", { name: "Enable /health", exact: true }).click();
  await page.getByRole("button", { name: "Disable /health", exact: true }).waitFor();
  checks.push("Pause and re-enable the saved response");

  await page.getByRole("button", { name: "Edit route /health", exact: true }).click();
  await page.getByLabel("Response body", { exact: true }).fill('{"status":"ready"}');
  const failSave = (handler) =>
    handler.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Preview connection interrupted" }),
    });
  await page.route("**/route-rules/*", failSave);
  await page.getByRole("button", { name: "Save response", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Preview connection interrupted" }).waitFor();
  assert.equal(
    await page.getByLabel("Response body", { exact: true }).inputValue(),
    '{"status":"ready"}',
  );
  await page.unroute("**/route-rules/*", failSave);
  await page.getByRole("button", { name: "Save response", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  checks.push("Retain edited content after a failed save, then retry successfully");

  await add.click();
  await page.getByLabel("Path", { exact: true }).fill("/robots.txt");
  await page.getByLabel("Response body", { exact: true }).fill("User-agent: *\nDisallow: /admin\n");
  await page.getByRole("button", { name: "Save response", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Remove /robots.txt", exact: true }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Edit route /robots.txt", exact: true }).waitFor();
  await page.getByRole("button", { name: "Remove /robots.txt", exact: true }).click();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await page
    .getByRole("button", { name: "Edit route /robots.txt", exact: true })
    .waitFor({ state: "hidden" });
  checks.push("Require confirmation before removal");
  await shot(page, "virtual-routes-domain-dark");

  await page.getByRole("button", { name: "Add PostgreSQL", exact: true }).click();
  await page.waitForURL("**/services");
  await page.goto(route, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Edit route /health", exact: true }).waitFor();
  assert.equal(await page.getByText("Virtual routes", { exact: true }).count(), 1);
  checks.push("Keep the same domain editor and response after adding a service");
  await shot(page, "virtual-routes-with-service");
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await page.getByRole("button", { name: "Edit route /health", exact: true }).click();
  await visibleSave(page);
  await shot(page, "virtual-routes-editor-light");
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole("button", { name: "Content type", exact: true }).click();
  await page.getByRole("option", { name: "Custom", exact: true }).click();
  await page.getByLabel("Custom content type", { exact: true }).fill("image/svg+xml");
  await visibleSave(page);
  await shot(page, "virtual-routes-editor-custom-light");
  await page.locator("[data-response-editor-scroll]").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await visibleSave(page);
  await overflow(page);
  await page.setViewportSize({ width: 1440, height: 1080 });
  await overflow(page);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.evaluate(() => {
    localStorage.setItem("theme", "dim");
    document.cookie = "openship-theme=dim:dim;path=/";
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Edit route /health", exact: true }).click();
  await shot(page, "virtual-routes-editor-dim");
  await overflow(page);

  for (const locale of ["en", "ar"]) {
    const words = JSON.parse(
      await readFile(`apps/dashboard/src/i18n/locales/${locale}/projectSettings.json`, "utf8"),
    ).responseRoutes;
    const mobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
      reducedMotion: "reduce",
    });
    await mobile.addCookies([
      { name: "openship-theme", value: "dark:dark", url: origin },
      { name: "openship-locale", value: locale, url: origin },
    ]);
    const phone = await mobile.newPage();
    activePage = phone;
    phone.on("pageerror", (error) => errors.push(error.message));
    await phone.goto(route, { waitUntil: "domcontentloaded" });
    await phone.getByRole("button", { name: `${words.edit} /health`, exact: true }).click();
    await overflow(phone);
    await shot(phone, `virtual-routes-editor-${locale}-mobile`);
    const save = phone.getByRole("button", { name: words.save, exact: true });
    await visibleSave(phone, words.save);
    await phone.locator("[data-response-editor-scroll]").evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await visibleSave(phone, words.save);
    await shot(phone, `virtual-routes-editor-${locale}-mobile-headers`);
    assert.equal(await save.isEnabled(), true);
    assert.ok((await save.boundingBox()).y < 844);
    await mobile.close();
  }
  checks.push(
    "Desktop light/dark/dim and English/Arabic mobile layouts without horizontal overflow; save remains visible at 720px desktop height and while scrolling mobile headers",
  );
  assert.deepEqual(errors, []);
  const saved = await fetch(`${api}/api/preview/scenario`).then((response) => response.json());
  assert.equal(saved.routeRules.length, 1);
  assert.equal(saved.routeRules[0].spec.response.body, '{"status":"ready"}');
  await writeFile(
    `${output}/virtual-routes-checks.json`,
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ checks, errors }, null, 2));
} catch (error) {
  if (activePage) {
    await activePage.screenshot({ path: `${output}/virtual-routes-failure.png`, fullPage: true });
    console.error((await activePage.locator("body").innerText()).slice(-5000));
  }
  console.error({ checks, errors });
  throw error;
} finally {
  await browser.close();
}
