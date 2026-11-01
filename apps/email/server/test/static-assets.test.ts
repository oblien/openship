import { afterAll, beforeAll, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let directory: string;
let server: ReturnType<typeof Bun.spawn>;
let origin: string;
const javascript = 'console.log("asset loaded");';

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "webmail-static-"));
  const client = join(directory, "client");
  await mkdir(join(client, "assets"), { recursive: true });
  await writeFile(join(client, "index.html"), "<!doctype html><title>Mail</title>");
  await writeFile(join(client, "assets/app-AbCd1234.js"), javascript);
  await writeFile(join(client, "assets/style-AbCd1234.css"), "body { color: red; }");
  await writeFile(join(client, "assets/logo.svg"), "<svg></svg>");
  server = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
    const { default: app } = await import('./src/main.ts');
    const server = Bun.serve({ ...app, hostname: '127.0.0.1', port: 0 });
    console.log('ORIGIN:' + server.url.origin);
  `,
    ],
    {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        NODE_ENV: "production",
        SESSION_ENCRYPTION_KEY: "11".repeat(32),
        BRANDING_ADMIN_TOKEN: "test-only",
        SQLITE_PATH: join(directory, "zero.db"),
        BRANDING_PATH: join(directory, "branding"),
        CLIENT_BUILD_DIR: client,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const reader = server.stdout.getReader();
  let output = "";
  while (!origin) {
    const { value, done } = await reader.read();
    if (done) throw new Error("Webmail server exited before listening: " + output);
    output += new TextDecoder().decode(value);
    origin = /ORIGIN:(http:\/\/[^\s]+)/.exec(output)?.[1] ?? "";
  }
  reader.releaseLock();
});

afterAll(async () => {
  server?.kill();
  await server?.exited;
  if (directory) await rm(directory, { recursive: true, force: true });
});

it("serves fingerprinted assets unchanged with immutable caching", async () => {
  for (const path of ["/assets/app-AbCd1234.js", "/assets/style-AbCd1234.css"]) {
    const response = await fetch(origin + path);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await response.text()).toBe(path.endsWith(".js") ? javascript : "body { color: red; }");
  }
});

it("does not cache documents, branding, API responses, unhashed files, or missing assets as immutable", async () => {
  for (const path of [
    "/",
    "/index.html",
    "/mail/inbox",
    "/branding.json",
    "/auth/session",
    "/assets/logo.svg",
    "/assets/missing-AbCd1234.js",
  ]) {
    const response = await fetch(origin + path);
    expect(response.headers.get("cache-control")?.includes("immutable") ?? false).toBe(false);
    if (path === "/mail/inbox" || path.includes("missing-")) {
      expect(response.headers.get("cache-control")).toBe("no-cache, must-revalidate");
    }
    await response.arrayBuffer();
  }
});
