import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { Hono } from "hono";

const previousEnv = vi.hoisted(() => {
  const values = {
    NODE_ENV: "production",
    TEST: "false",
    CLOUD_MODE: "true",
    OPENSHIP_TARGET: "local-saas",
    TRUST_PROXY: "true",
    CLOUD_SESSION_PINNING: "strict",
    BETTER_AUTH_SECRET: "cloud-session-test-secret-0000000000000000000000000000",
  };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  return previous;
});

import { diagnostics } from "@repo/core/diagnostics";
import { closeDb, db, eq, schema } from "@repo/db";
import { env } from "@repo/platform/engine/config/env";
import { auth } from "@repo/platform/engine/lib/auth";
import { provisionUserWithCredential } from "@repo/platform/engine/lib/provision-user";
import { mintSession } from "../../src/lib/cloud-auth-proxy";
import { clientIpMiddleware } from "../../src/middleware/client-ip";
import { cloudSessionAuth } from "../../src/modules/cloud/cloud-session-auth";

// Real sign-in, migrated in-memory PGlite and the production middleware chain.
const app = new Hono();
app.use("*", clientIpMiddleware);
app.post("/api/auth/sign-in/email", (c) => auth.handler(c.req.raw));
app.get("/api/cloud/account", cloudSessionAuth, (c) => c.json({ ok: true }));
const password = "cloud-session-test-password";
const userId = "cloud-session-user";
const email = "cloud-session@example.test";
const userAgent = "openship-cloud-session-test";
const peer = { incoming: { socket: { remoteAddress: "172.18.0.2" } } };
const warn = vi.spyOn(diagnostics, "warn").mockImplementation(() => {});

function headers(ip: string, ua = userAgent) {
  return {
    "content-type": "application/json",
    "user-agent": ua,
    "x-real-ip": ip,
    "x-forwarded-for": `192.0.2.99, ${ip}`,
  };
}

async function signIn(ip: string) {
  const response = await app.request(
    "http://localhost:4100/api/auth/sign-in/email",
    { method: "POST", headers: headers(ip), body: JSON.stringify({ email, password }) },
    peer,
  );
  expect(response.status).toBe(200);
  const { token } = await response.json();
  expect(token).toBeTypeOf("string");
  return token as string;
}

function account(token: string, ip: string, ua = userAgent) {
  return app.request(
    "http://localhost:4100/api/cloud/account",
    { headers: { ...headers(ip, ua), authorization: `Bearer ${token}` } },
    peer,
  );
}

beforeAll(async () => {
  const context = await auth.$context;
  context.rateLimit.enabled = false; // Rate-limit bucket isolation has its own regression.
  await provisionUserWithCredential(
    { id: userId, name: "Cloud session user", email, emailVerified: true },
    { passwordHash: await context.password.hash(password) },
  );
});

beforeEach(() => {
  env.CLOUD_SESSION_PINNING = "strict";
  warn.mockClear();
});
afterEach(() => {
  env.CLOUD_SESSION_PINNING = "strict";
});
afterAll(async () => {
  warn.mockRestore();
  await closeDb();
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const addresses = [
  { ip: "203.0.113.10", stored: "203.0.113.10", equivalent: "::ffff:203.0.113.10" },
  {
    ip: "2001:db8:1234:5678::abcd",
    stored: "2001:0db8:1234:5678:0000:0000:0000:abcd",
    equivalent: "2001:0DB8:1234:5678:0:0:0:ABCD",
  },
  { ip: "::ffff:203.0.113.10", stored: "203.0.113.10", equivalent: "203.0.113.10" },
];

it.each(addresses)("stores the full address and accepts the same device: $ip", async (address) => {
  const token = await signIn(address.ip);
  const [session] = await db.select().from(schema.session).where(eq(schema.session.token, token));
  expect(session.ipAddress).toBe(address.stored);
  expect(session.activeOrganizationId).toBe(`org_${userId}`);
  for (const mode of ["strict", "warn"] as const) {
    env.CLOUD_SESSION_PINNING = mode;
    expect((await account(token, address.ip)).status).toBe(200);
    expect((await account(token, address.equivalent)).status).toBe(200);
  }
  expect(warn).not.toHaveBeenCalled();
});

it.each([
  { original: "203.0.113.10", changed: "203.0.113.11" },
  { original: "2001:db8:1234:5678::abcd", changed: "2001:db8:1234:5678::abce" },
  { original: "2001:db8:1234:5678::abcd", changed: "2001:db8:1234:5679::abcd" },
])("rejects a changed IP in strict mode, including within one IPv6 /64: $changed", async (ips) => {
  const token = await signIn(ips.original);
  const response = await account(token, ips.changed);
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({ code: "SESSION_FINGERPRINT_MISMATCH" });
});

it("keeps existing linked-instance sessions pinned to the full address", async () => {
  const session = await mintSession({
    purpose: "linked-instance",
    userId,
    ipAddress: "2001:db8:1234:5678::abcd",
    userAgent,
  });
  expect((await account(session.token, "2001:0DB8:1234:5678:0:0:0:ABCD")).status).toBe(200);
  expect((await account(session.token, "2001:db8:1234:5678::abce")).status).toBe(401);
});

it.each([
  { mode: "strict", status: 401, warnings: 1 },
  { mode: "warn", status: 200, warnings: 1 },
  { mode: "off", status: 200, warnings: 0 },
] as const)(
  "preserves $mode policy for a changed user agent",
  async ({ mode, status, warnings }) => {
    const token = await signIn("203.0.113.10");
    env.CLOUD_SESSION_PINNING = mode;
    expect((await account(token, "203.0.113.10", "another-device")).status).toBe(status);
    expect(warn).toHaveBeenCalledTimes(warnings);
  },
);
