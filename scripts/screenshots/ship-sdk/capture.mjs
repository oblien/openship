import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkDocExamples } from "../../check-docs-examples.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const output = resolve(root, "docs/screenshots/ship-sdk");
const require = createRequire(import.meta.url);
const webRequire = createRequire(resolve(root, "apps/web/package.json"));
const { codeToHtml } = await import(pathToFileURL(webRequire.resolve("shiki")).href);
const playwrightPath = process.env.PLAYWRIGHT_MODULE ?? require.resolve("playwright");
const { chromium } = await import(pathToFileURL(playwrightPath).href);

// One canonical example: the image and downloadable source use the exact code
// from the SDK landing page, already covered by the documentation type checks.
const guide = await readFile(resolve(root, "apps/web/content/docs/api/sdk/index.mdx"), "utf8");
const source = guide.match(/^```ts title="deploy-app\.mts"\n([\s\S]*?)^```/m)?.[1];
if (!source) throw new Error("The documented deploy-app.mts example was not found.");
console.log(`${checkDocExamples()} documentation examples type-check, including the image source.`);
const highlighted = await codeToHtml(source.trimEnd(), { lang: "typescript", theme: "github-dark" });

// Embed the same brand font used by the site, keeping the saved HTML portable.
const fonts = await Promise.all([
  [400, "Regular"], [500, "Medium"], [600, "SemiBold"],
].map(async ([weight, name]) => {
  const response = await fetch(`https://cdn.oblien.com/fonts/Gellix-${name}.woff2`, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Cannot load the ${name} brand font: ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer()).toString("base64");
  return `@font-face { font-family: Gellix; font-weight: ${weight}; src: url(data:font/woff2;base64,${data}) format('woff2'); }`;
}));

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Ship SDK — Deploy from your code</title>
<style>
${fonts.join("\n")}
* { box-sizing: border-box; }
body { margin: 0; background: #121212; color: #f4f4f4; font-family: Gellix, sans-serif; }
.poster { width: 1280px; padding: 48px 56px 36px; }
.brand { display: flex; align-items: center; gap: 15px; font-size: 27px; font-weight: 500; }
.logo { width: 31px; height: 31px; border: 3px solid #f3f3f3; border-radius: 50%; }
.install { margin-left: auto; padding: 12px 18px; background: #1c1c1c; border-radius: 12px; color: #c2c2c2; font: 18px Menlo, monospace; }
.install span { color: #7e7e7e; margin-right: 10px; }
h1 { margin: 34px 0 12px; font-size: 46px; line-height: 1.15; font-weight: 600; letter-spacing: -1px; }
.intro { margin: 0 0 30px; color: #a4a4a4; font-size: 23px; }
.editor { border: 1px solid #303030; background: #191919; border-radius: 20px; overflow: hidden; }
.editor-header { display: flex; align-items: center; gap: 12px; height: 58px; padding: 0 30px; border-bottom: 1px solid #303030; color: #c8c8c8; font-size: 19px; }
.ts { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; background: #254057; color: #a6d0f1; border-radius: 5px; font-size: 12px; font-weight: 600; }
.language { margin-left: auto; font-size: 17px; color: #858585; }
pre.shiki { margin: 0; padding: 28px 32px 32px; background: transparent !important; font-size: 25px; line-height: 1.52; tab-size: 2; }
pre, code { font-family: Menlo, Consolas, monospace; font-variant-ligatures: none; }
.line { display: inline-block; min-height: 1em; }
footer { display: flex; align-items: center; justify-content: space-between; margin-top: 25px; color: #9c9c9c; font-size: 19px; }
footer a { color: #c4c4c4; text-decoration: none; }
</style></head><body>
<main class="poster">
  <header class="brand"><span class="logo" aria-hidden="true"></span>Ship SDK
    <code class="install"><span>$</span>npm install openship</code>
  </header>
  <h1>Deploy from your code.</h1>
  <p class="intro">Build deployment workflows in JavaScript or TypeScript.</p>
  <section class="editor" aria-label="TypeScript deployment example">
    <div class="editor-header"><span class="ts">TS</span>deploy-app.mts<span class="language">TypeScript</span></div>
    ${highlighted}
  </section>
  <footer><span>Connect to OpenShip. Or embed the engine.</span><a href="https://openship.io/docs/api/sdk">openship.io/docs/api/sdk</a></footer>
</main></body></html>`;

await mkdir(output, { recursive: true });
await writeFile(resolve(output, "deploy-app.mts"), source);
await writeFile(resolve(output, "ship-sdk.html"), html);
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1200 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // No app server, authenticated browser, or deployment is involved in capture.
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  const content = await page.locator("pre code").textContent();
  if (content !== source.trimEnd()) throw new Error("Rendered code differs from the documented example.");
  const overflow = await page.evaluate(() => {
    const pre = document.querySelector("pre");
    return document.documentElement.scrollWidth > innerWidth || pre.scrollWidth > pre.clientWidth;
  });
  if (overflow) throw new Error("The code image contains clipped text.");
  if (errors.length) throw new Error(errors.join("\n"));
  await page.locator(".poster").screenshot({ path: resolve(output, "ship-sdk.png"), animations: "disabled" });
  console.log("Saved docs/screenshots/ship-sdk/ship-sdk.png, ship-sdk.html, and deploy-app.mts.");
} finally {
  await browser.close();
}
