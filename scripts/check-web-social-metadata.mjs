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
const paths = new Set(pageRoutes.filter((route) => !route.includes("[")));
for (const [route, entry] of Object.entries(prerender.routes)) {
  if (pageRoutes.includes(entry.srcRoute ?? route)) paths.add(route);
}
for (const route of pageRoutes.filter((route) => route.includes("["))) {
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

async function request(origin, path) {
  const response = await fetch(new URL(path, origin), {
    headers: { "User-Agent": "Twitterbot/1.0" },
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(response.status, 200, `${path}: HTTP ${response.status}`);
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
    const tags = metaTags(await response.text());
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
  assert.equal(pages.get("/pricing").get("og:image"), pages.get("/").get("og:image"));
  assert.match(
    new URL(pages.get("/download").get("og:image")).pathname,
    /^\/download\/opengraph-image/,
  );
  assert.match(
    new URL(pages.get("/download").get("twitter:image")).pathname,
    /^\/download\/twitter-image/,
  );
  assert.equal(new URL(pages.get("/docs").get("og:image")).pathname, "/docs-og");
  assert.match(pages.get("/affiliates").get("og:title"), /OpenShip Earn/);
  for (const key of ["og:image", "twitter:image"]) {
    assert.equal(new URL(pages.get("/affiliates").get(key)).pathname, "/og/affiliates.png");
  }

  await each(images, async (path) => {
    const response = await request(origin, path);
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
