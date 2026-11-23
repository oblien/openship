import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createServer as httpServer, type Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "@repo/db/factory";
import { createCloudSupportRepo } from "../../../../../packages/db/src/repos/cloud-support.repo";
import { CloudSupportService } from "@repo/platform/engine/modules/cloud-support/service";

// Exercise the support route, outbox and Oblien SDK over loopback HTTP.
const state = vi.hoisted(() => ({
  url: "",
  env: {
    CLOUD_MODE: true,
    DEPLOY_MODE: "docker",
    INTERNAL_TOKEN: "operator-test-token",
    OBLIEN_CLIENT_ID: "fixture-owner",
    OBLIEN_CLIENT_SECRET: "fixture-secret",
    OBLIEN_API_URL: "",
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
vi.mock("../../../src/modules/cloud-support/contact-challenge", () => ({ verifyContactChallenge: vi.fn(async () => {}) }));
vi.mock("../../../src/lib/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ allowed: true })),
}));

let api: HttpServer;
let client: PGlite;
let repo: ReturnType<typeof createCloudSupportRepo>;
let apiMode = "ok";
let rejectRecipient = "";
const delivered: Array<{ to: string[]; from: string; replyTo: string[]; text: string }> = [];
const forwarded: Headers[] = [];
const payload = () => ({
  requestId: randomUUID(),
  name: "Customer",
  email: "customer@example.com",
  subject: "Cloud deployment",
  message: "My deployment is failing. Please help.",
  source: "contact",
});
const submit = (body: unknown) => fetch(`${state.url}/api/cloud/support`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ ...body as object, turnstileToken: "fixture-token" }),
});

beforeAll(async () => {
  client = new PGlite("memory://");
  await client.exec(
    readFileSync(
      new URL("../../../../../packages/db/drizzle/0152_cloud_support.sql", import.meta.url),
      "utf8",
    ),
  );
  await client.exec(readFileSync(new URL("../../../../../packages/db/drizzle/0167_cloud_support_customers.sql", import.meta.url), "utf8"));
  await client.exec(readFileSync(new URL("../../../../../packages/db/drizzle/0229_support_intake_blocks.sql", import.meta.url), "utf8"));
  repo = createCloudSupportRepo(drizzle(client) as unknown as Database);
  const { sendMail } = await import("@repo/platform/engine/lib/mail");
  state.service = new CloudSupportService({ enabled: () => true, repo, send: sendMail });
  const { cloudSupportRoutes } =
    await import("../../../src/modules/cloud-support/cloud-support.routes");
  const app = new Hono();
  const { handleApiError } = await import("../../../src/middleware/error-handler");
  app.onError(handleApiError);
  app.route("/api/cloud/support", cloudSupportRoutes);
  api = httpServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const chunk of req) parts.push(Buffer.from(chunk));
    if (req.method === "POST" && req.url === "/v2/mail/openship/messages") {
      const mail = JSON.parse(Buffer.concat(parts).toString());
      if (req.headers["x-client-id"] !== "fixture-owner" || req.headers["x-client-secret"] !== "fixture-secret") {
        res.writeHead(401).end();
      } else if (mail.to.includes(rejectRecipient)) {
        res.writeHead(422).end(JSON.stringify({ success: false, code: "mail_invalid_address" }));
      } else {
        delivered.push(mail);
        res.writeHead(202).end(JSON.stringify({ success: true, data: { id: randomUUID(), state: "queued" } }));
      }
      return;
    }
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
  state.env.OBLIEN_API_URL = state.url + "/v2";
  // Cold PostgreSQL WASM startup and route transforms contend with the full API suite.
}, 30_000);
beforeEach(async () => {
  await client.exec("TRUNCATE cloud_support_ticket, cloud_support_block CASCADE");
  delivered.length = 0;
  forwarded.length = 0;
  apiMode = "ok";
  rejectRecipient = "";
});
afterAll(async () => {
  if (api) {
    api.closeAllConnections();
    await new Promise<void>((resolve) => api.close(() => resolve()));
  }
  await client?.close();
});

it("saves a website submission through HTTP and delivers both emails through the Oblien SDK", async () => {
  const body = payload();
  const response = await submit(body);
  expect(response.status).toBe(201);
  const receipt = await response.json();
  expect(await repo.find(receipt.id)).toMatchObject({ message: body.message });
  expect(await state.service!.flush()).toEqual({ delivered: 2, failed: 0 });
  expect(delivered).toHaveLength(2);
  const acknowledgement = delivered.find((m) => m.to.includes(body.email))!;
  expect(acknowledgement.from).toBe("noreply@openship.io");
  expect(acknowledgement.replyTo).toEqual(["support@openship.io"]);
  expect(acknowledgement.text).toContain(receipt.id);
  expect(delivered.find((m) => m.to.includes("support@openship.io"))!.replyTo).toEqual([body.email]);
  expect(state.localMail).not.toHaveBeenCalled();
  for (const name of ["cookie", "x-internal-token", "x-real-ip"])
    expect(forwarded[0]!.get(name)).toBeNull();
  expect(await (await submit(body)).json()).toEqual(receipt);
  expect(await state.service!.flush()).toEqual({ delivered: 0, failed: 0 });
});

it("keeps the ticket after an API recipient rejection and delivers on retry", async () => {
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

it("closes the legacy website proxy", async () => {
  const { POST } = await import("../../../../web/src/app/api/contact/route");
  expect((await POST()).status).toBe(410);
  expect(await repo.list({ limit: 10 })).toHaveLength(0);
});

it("rejects invalid and oversized website input before contacting Cloud", async () => {
  expect((await submit({ ...payload(), email: "not an email" })).status).toBe(400);
  expect((await submit({ ...payload(), message: "x".repeat(66_000) })).status).toBe(413);
  expect(await repo.list({ limit: 10 })).toHaveLength(0);
});
