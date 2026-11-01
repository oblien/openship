import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createServer as httpServer, type Server as HttpServer } from "node:http";
import { createServer as smtpServer, type Server as SmtpServer, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "@repo/db/factory";
import { createCloudSupportRepo } from "../../../../../packages/db/src/repos/cloud-support.repo";
import { CloudSupportService } from "@repo/platform/engine/modules/cloud-support/service";

// Real HTTP, SQL and SMTP; external infrastructure, auth sessions and unrelated
// platform mail provisioning are the only boundaries isolated in this test.
const state = vi.hoisted(() => ({
  url: "",
  env: {
    CLOUD_MODE: true,
    DEPLOY_MODE: "docker",
    INTERNAL_TOKEN: "operator-test-token",
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: 0,
    SMTP_USER: "test",
    SMTP_PASS: "test",
    SMTP_FROM: "Openship Support <support@openship.io>",
  },
  service: null as CloudSupportService | null,
  localMail: vi.fn(),
}));
vi.mock("@repo/core", async (original) => ({
  ...(await original<object>()),
  get CLOUD_API_URL() {
    return state.url;
  },
}));
vi.mock("@repo/platform/engine/config/env", () => ({ env: state.env }));
vi.mock("@repo/platform/engine/config/index", () => ({ env: state.env }));
vi.mock("@repo/db", () => ({ repos: { mailServer: { list: state.localMail } } }));
vi.mock("@repo/platform/engine/lib/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/platform/engine/lib/cloud/client", () => ({ cloudClient: vi.fn() }));
vi.mock("@repo/platform/engine/lib/encryption", () => ({ decrypt: vi.fn() }));
vi.mock("@repo/platform/engine/modules/cloud-support/index", () => ({
  get cloudSupport() {
    return state.service;
  },
  deliverCloudSupport: vi.fn(),
}));
vi.mock("../../../src/middleware/auth", () => ({ authMiddleware: vi.fn() }));
vi.mock("../../../src/middleware/rate-limiter", () => ({
  rateLimiterFor: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock("../../../src/lib/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ allowed: true })),
}));

let smtp: SmtpServer;
let api: HttpServer;
let client: PGlite;
let repo: ReturnType<typeof createCloudSupportRepo>;
let post: typeof import("../../../../web/src/app/api/contact/route").POST;
let apiMode = "ok";
let rejectRecipient = "";
const sockets = new Set<Socket>();
const delivered: Array<{ recipient: string; message: string }> = [];
const forwarded: Headers[] = [];
const payload = () => ({
  requestId: randomUUID(),
  name: "Customer",
  email: "customer@example.com",
  subject: "Cloud deployment",
  message: "My deployment is failing. Please help.",
  source: "support",
});
const submit = (body: unknown) =>
  post(
    new Request("https://openship.io/api/contact", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://openship.io",
        Cookie: "private-cookie",
        "X-Internal-Token": "never-forward-this",
        "X-Real-IP": "untrusted",
      },
      body: JSON.stringify(body),
    }) as never,
  );

beforeAll(async () => {
  smtp = smtpServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    socket.write("220 localhost SMTP test\r\n");
    let buffer = "",
      data = false,
      recipient = "",
      message = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\r\n")) {
        const end = buffer.indexOf("\r\n");
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (data) {
          if (line === ".") {
            delivered.push({ recipient, message });
            data = false;
            message = "";
            socket.write("250 accepted\r\n");
          } else message += line.replace(/^\.\./, ".") + "\r\n";
        } else if (line.startsWith("EHLO") || line.startsWith("HELO"))
          socket.write("250-localhost\r\n250-AUTH PLAIN\r\n250 SIZE 65536\r\n");
        else if (line.startsWith("AUTH")) socket.write("235 authenticated\r\n");
        else if (line.startsWith("RCPT TO:")) {
          recipient = line.match(/<([^>]+)>/)?.[1] ?? "";
          socket.write(
            recipient === rejectRecipient
              ? "550 Recipient address rejected: User unknown\r\n"
              : "250 recipient ok\r\n",
          );
        } else if (line === "DATA") {
          data = true;
          socket.write("354 send message\r\n");
        } else if (line === "QUIT") socket.end("221 goodbye\r\n");
        else socket.write("250 ok\r\n");
      }
    });
  });
  await new Promise<void>((resolve) => smtp.listen(0, "127.0.0.1", resolve));
  state.env.SMTP_PORT = (smtp.address() as { port: number }).port;
  client = new PGlite("memory://");
  await client.exec(
    readFileSync(
      new URL("../../../../../packages/db/drizzle/0152_cloud_support.sql", import.meta.url),
      "utf8",
    ),
  );
  await client.exec(readFileSync(new URL("../../../../../packages/db/drizzle/0167_cloud_support_customers.sql", import.meta.url), "utf8"));
  repo = createCloudSupportRepo(drizzle(client) as unknown as Database);
  const { sendMail } = await import("@repo/platform/engine/lib/mail");
  state.service = new CloudSupportService({ enabled: () => true, repo, send: sendMail });
  const { cloudSupportRoutes } =
    await import("../../../src/modules/cloud-support/cloud-support.routes");
  const app = new Hono();
  app.route("/api/cloud/support", cloudSupportRoutes);
  api = httpServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const chunk of req) parts.push(Buffer.from(chunk));
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers))
      if (value) headers.set(key, Array.isArray(value) ? value.join(",") : value);
    forwarded.push(headers);
    const response =
      apiMode === "ok"
        ? await app.fetch(
            new Request(state.url + req.url, {
              method: req.method,
              headers,
              body: parts.length ? Buffer.concat(parts) : undefined,
            }),
          )
        : new Response(JSON.stringify({ ok: true }), {
            status: apiMode === "unavailable" ? 503 : 200,
          });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  state.url = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
  ({ POST: post } = await import("../../../../web/src/app/api/contact/route"));
  // Cold PostgreSQL WASM startup and route transforms contend with the full API suite.
}, 30_000);
beforeEach(async () => {
  await client.exec("TRUNCATE cloud_support_ticket CASCADE");
  delivered.length = 0;
  forwarded.length = 0;
  apiMode = "ok";
  rejectRecipient = "";
});
afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  if (smtp) await new Promise<void>((resolve) => smtp.close(() => resolve()));
  if (api) {
    api.closeAllConnections();
    await new Promise<void>((resolve) => api.close(() => resolve()));
  }
  await client?.close();
});

it("saves a website submission through HTTP and delivers both emails through the real SMTP sender", async () => {
  const body = payload();
  const response = await submit(body);
  expect(response.status).toBe(201);
  const receipt = await response.json();
  expect(await repo.find(receipt.id)).toMatchObject({ message: body.message });
  expect(await state.service!.flush()).toEqual({ delivered: 2, failed: 0 });
  expect(delivered).toHaveLength(2);
  const acknowledgement = delivered.find((m) => m.recipient === body.email)!;
  expect(acknowledgement.message).toContain("Reply-To: support@openship.io");
  expect(acknowledgement.message).toContain("From: Openship Support <support@openship.io>");
  expect(acknowledgement.message).toContain(receipt.id);
  expect(delivered.find((m) => m.recipient === "support@openship.io")!.message).toContain(
    `Reply-To: ${body.email}`,
  );
  expect(state.localMail).not.toHaveBeenCalled();
  for (const name of ["cookie", "x-internal-token", "x-real-ip"])
    expect(forwarded[0]!.get(name)).toBeNull();
  expect(await (await submit(body)).json()).toEqual(receipt);
  expect(await state.service!.flush()).toEqual({ delivered: 0, failed: 0 });
});

it("keeps the ticket after an actual SMTP recipient rejection and delivers on retry", async () => {
  const body = payload();
  rejectRecipient = body.email;
  const receipt = await (await submit(body)).json();
  expect(await state.service!.flush()).toEqual({ delivered: 1, failed: 1 });
  expect(
    (await repo.messages(receipt.id)).find((m) => m.kind === "receipt")!.deliveredAt,
  ).toBeNull();
  rejectRecipient = "";
  await state.service!.retry(receipt.id);
  expect(await state.service!.flush()).toEqual({ delivered: 1, failed: 0 });
  expect(delivered).toHaveLength(2);
});

it.each(["unavailable", "invalid-receipt"])(
  "does not claim success when the Cloud API returns %s",
  async (mode) => {
    apiMode = mode;
    const response = await submit(payload());
    expect(response.status).toBe(503);
    expect((await response.json()).error).toContain("support@openship.io");
    expect(await repo.list({ limit: 10 })).toHaveLength(0);
  },
);

it("rejects invalid and oversized website input before contacting Cloud", async () => {
  expect((await submit({ ...payload(), email: "not an email" })).status).toBe(400);
  expect((await submit({ ...payload(), message: "x".repeat(66_000) })).status).toBe(413);
  expect(forwarded).toHaveLength(0);
});
