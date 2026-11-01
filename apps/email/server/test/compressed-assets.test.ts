import { afterAll, beforeAll, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let directory: string;
let server: ReturnType<typeof Bun.spawn>;
let origin: string;
const javascript = 'console.log("asset loaded");'.repeat(100);

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "webmail-static-"));
  const client = join(directory, "client");
  await mkdir(join(client, "assets"), { recursive: true });
  await writeFile(join(client, "index.html"), "<!doctype html><title>Mail</title>");
  await writeFile(join(client, "assets/app-AbCd1234.js"), javascript);
  await writeFile(join(client, "assets/style-AbCd1234.css"), "body { color: red; }");
  await writeFile(join(client, "assets/logo.svg"), "<svg></svg>");
  const compressed = Bun.spawnSync([
    process.execPath,
    join(import.meta.dir, "../../scripts/precompress-client.ts"),
    join(client, "assets"),
  ]);
  if (compressed.exitCode !== 0) throw new Error(compressed.stderr.toString());
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

it("negotiates Brotli and gzip while retaining immutable caching and the decoded JavaScript", async () => {
  for (const encoding of ["br", "gzip", "identity"]) {
    const response = await fetch(origin + "/assets/app-AbCd1234.js", {
      headers: { "Accept-Encoding": encoding, Origin: "https://mail.example.test" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBe(
      encoding === "identity" ? null : encoding,
    );
    expect(response.headers.get("content-type")).toContain("javascript");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("vary")).toContain("Accept-Encoding");
    expect(response.headers.get("vary")).toContain("Origin");
    expect(
      response.headers
        .get("vary")
        ?.split(",")
        .filter((value) => value.trim() === "Accept-Encoding"),
    ).toHaveLength(1);
    expect(await response.text()).toBe(javascript);
  }
});

it("falls back to original files and keeps public documents and the session route unchanged", async () => {
  const fallback = await fetch(origin + "/assets/style-AbCd1234.css", {
    headers: { "Accept-Encoding": "br, gzip" },
  });
  expect(fallback.headers.get("content-encoding")).toBeNull();
  expect(await fallback.text()).toBe("body { color: red; }");
  for (const path of ["/", "/mail/inbox", "/branding.json", "/auth/session"]) {
    const response = await fetch(origin + path, { headers: { "Accept-Encoding": "br, gzip" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBeNull();
    await response.arrayBuffer();
  }
});

it("preserves unauthenticated responses from protected mail APIs and the idle stream", async () => {
  for (const path of [
    "/api/trpc/mail.listThreads?batch=1&input=%7B%220%22%3A%7B%22json%22%3A%7B%22folder%22%3A%22inbox%22%7D%7D%7D",
    "/mail/idle",
  ]) {
    const response = await fetch(origin + path, { headers: { "Accept-Encoding": "br, gzip" } });
    expect(response.status).toBe(401);
    expect(response.headers.get("content-encoding")).toBeNull();
    await response.arrayBuffer();
  }
});
