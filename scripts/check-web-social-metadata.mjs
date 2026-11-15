// Run after `bun run --cwd apps/web build`. Check the actual HTML crawlers receive,
// including dynamic pages, and fetch each distinct preview image from the local build.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const webRoot = new URL("../apps/web/", import.meta.url);
const requireWeb = createRequire(new URL("package.json", webRoot));
const readJson = async (path) => JSON.parse(await readFile(new URL(path, webRoot), "utf8"));
const appRoutes = await readJson(".next/app-path-routes-manifest.json");
const prerender = await readJson(".next/prerender-manifest.json");
const pageRoutes = Object.entries(appRoutes)
  .filter(([file, route]) => file.endsWith("/page") && !route.startsWith("/_"))
  .map(([, route]) => route);
const locales = ["en", "ar", "es", "fr", "de", "pt", "ja", "zh", "tr", "ru"];
const translatedSections = new Set([
  "",
  "pricing",
  "features",
  "apps",
  "migrate",
  "referrals",
  "mail",
  "download",
  "about",
  "trust",
  "support",
  "contact",
  "blog",
  "changelog",
  "privacy",
  "terms",
]);
function publicPath(route) {
  const [, locale, ...rest] = route.split("/");
  if (!locales.includes(locale)) return route;
  const path = rest.join("/");
  if (locale === "en") return `/${path}`;
  if (!translatedSections.has(rest[0] ?? "")) return null;
  return route;
}
const paths = new Set(pageRoutes.filter((route) => !route.includes("[")));
for (const route of pageRoutes.filter((route) => route.includes("[locale]"))) {
  for (const locale of locales) {
    const example = route.replace("[locale]", locale);
    if (!example.includes("[")) {
      const path = publicPath(example);
      if (path) paths.add(path);
    }
  }
}
for (const [route, entry] of Object.entries(prerender.routes)) {
  if (pageRoutes.includes(entry.srcRoute ?? route)) {
    const path = publicPath(route);
    if (path) paths.add(path);
  }
}
for (const route of pageRoutes.filter((route) => route.includes("["))) {
  if (!route.replace("[locale]", "en").includes("[")) continue;
  assert(
    Object.values(prerender.routes).some((entry) => entry.srcRoute === route),
    `No rendered examples for ${route}`,
  );
}
paths.add("/blog?category=engineering");

const server = spawn(
  process.execPath,
  [requireWeb.resolve("next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", "0"],
  {
    cwd: fileURLToPath(webRoot),
    env: { ...process.env, NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let output = "";
for (const stream of [server.stdout, server.stderr]) {
  stream.on("data", (chunk) => {
    output = (output + chunk).slice(-16000);
  });
}

async function request(origin, path, followRedirect = false) {
  const response = await fetch(new URL(path, origin), {
    headers: { "User-Agent": "Twitterbot/1.0" },
    redirect: followRedirect ? "follow" : "manual",
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(response.status, 200, `${path}: HTTP ${response.status}`);
  assert.equal(new URL(response.url).origin, origin, `${path}: local response origin`);
  return response;
}

function metaTags(html) {
  // Next emits quoted, HTML-escaped attributes. Inspect the head, not serialized
  // React data or metadata streamed into the body after a crawler has stopped reading.
  const head = html.match(/<head>([\s\S]*?)<\/head>/i)?.[1];
  assert(head, "Missing document head");
  const result = new Map();
  for (const tag of head.matchAll(/<meta\s[^>]*>/gi)) {
    const attributes = Object.fromEntries(
      [...tag[0].matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, name, value]) => [
        name,
        value.replaceAll("&amp;", "&"),
      ]),
    );
    const key = attributes.property ?? attributes.name;
    if (key) result.set(key, attributes.content);
  }
  return result;
}

async function each(items, work) {
  const queue = [...items];
  const failures = [];
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (queue.length) {
        const item = queue.shift();
        try {
          await work(item);
        } catch (error) {
          failures.push(new Error(`${item}: ${error.message}`, { cause: error }));
        }
      }
    }),
  );
  if (failures.length)
    throw new AggregateError(failures, failures.map((error) => error.message).join("\n"));
}

try {
  const origin = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Next did not start:\n${output}`)), 30_000);
    server.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    server.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Next exited (${code}):\n${output}`));
    });
    server.stdout.on("data", () => {
      const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
      if (url && output.includes("Ready in")) {
        clearTimeout(timeout);
        resolve(url);
      }
    });
  });
  const images = new Set();
  const pages = new Map();
  await each([...paths].sort(), async (path) => {
    const response = await request(origin, path);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    const html = await response.text();
    const tags = metaTags(html);
    const first = path.split("/")[1];
    const locale = locales.includes(first) ? first : "en";
    assert.match(html, new RegExp(`<html[^>]*lang="${locale}"`), `${path}: document language`);
    if (locale === "ar") assert.match(html, /<html[^>]*dir="rtl"/, `${path}: Arabic direction`);
    if (locales.includes(first) && translatedSections.has(path.split("/")[2] ?? "")) {
      assert(html.includes(`href="https://openship.io${path}"`), `${path}: canonical locale URL`);
      for (const language of [...locales, "x-default"])
        assert(
          html.includes(`hrefLang="${language}"`) || html.includes(`hreflang="${language}"`),
          `${path}: alternate ${language}`,
        );
    }
    assert.equal(tags.get("twitter:card"), "summary_large_image", `${path}: Twitter card`);
    for (const key of ["og:image", "twitter:image"]) {
      assert(tags.get(key), `${path}: missing ${key}`);
      const image = new URL(tags.get(key));
      assert.equal(
        image.origin,
        "https://openship.io",
        `${path}: preview must use the public site URL`,
      );
      images.add(`${image.pathname}${image.search}`);
    }
    pages.set(path, tags);
  });
  assert.match(pages.get("/pricing").get("og:title"), /Pricing/);
  // These pages own their images. Inheriting the homepage's metadata can hide
  // a route's provider artwork even when its image handler itself works.
  const customPreviews = [...paths].filter(
    (path) => path === "/pricing" || path === "/migrate" || path.startsWith("/migrate/"),
  );
  for (const path of customPreviews) {
    for (const [key, filename] of [
      ["og:image", "opengraph-image"],
      ["twitter:image", "twitter-image"],
    ]) {
      assert(
        publicPath(new URL(pages.get(path).get(key)).pathname)?.startsWith(`${path}/${filename}`),
        `${path}: ${key} must use its own image`,
      );
    }
  }
  assert.match(
    publicPath(new URL(pages.get("/download").get("og:image")).pathname),
    /^\/download\/opengraph-image/,
  );
  assert.match(
    publicPath(new URL(pages.get("/download").get("twitter:image")).pathname),
    /^\/download\/twitter-image/,
  );
  assert.equal(new URL(pages.get("/docs").get("og:image")).pathname, "/docs-og");
  assert.match(pages.get("/referrals").get("og:title"), /OpenShip Referral/);
  for (const key of ["og:image", "twitter:image"]) {
    assert.match(
      publicPath(new URL(pages.get("/referrals").get(key)).pathname),
      /^\/referrals\/(opengraph|twitter)-image/,
    );
  }

  await each(images, async (path) => {
    const response = await request(origin, path, true);
    assert.match(response.headers.get("content-type") ?? "", /image\/png/);
    const png = Buffer.from(await response.arrayBuffer());
    assert(png.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")), "Not a PNG");
    assert.equal(png.readUInt32BE(16), 1200, "Preview width");
    assert.equal(png.readUInt32BE(20), 630, "Preview height");
    assert(png.length < 5 * 1024 * 1024, "Preview exceeds Twitter's 5 MB limit");
  });
  console.log(`Social previews verified: ${paths.size} pages, ${images.size} images (1200 × 630).`);
} finally {
  if (server.exitCode === null && server.signalCode === null) {
    const exited = once(server, "exit");
    const timeout = setTimeout(() => server.kill("SIGKILL"), 10_000);
    server.kill("SIGTERM");
    await exited;
    clearTimeout(timeout);
  }
}
