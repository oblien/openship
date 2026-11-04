import { afterAll, expect, it } from "vitest";
import { Hono } from "hono";
import { closeDb } from "@repo/db";
import { env } from "@repo/platform/engine/config/env";
import { auth } from "@repo/platform/engine/lib/auth";
import { clientIpMiddleware } from "../../src/middleware/client-ip";

afterAll(() => closeDb());

it("isolates auth rate limits by the resolved client IP and rejects forged forwarding headers", async () => {
  const context = await auth.$context;
  const previousRateLimit = { ...context.rateLimit };
  const previousEnv = {
    TRUST_PROXY: env.TRUST_PROXY,
    OPENSHIP_PUBLIC_URL: env.OPENSHIP_PUBLIC_URL,
  };
  Object.assign(context.rateLimit, { enabled: true, window: 60, max: 1, storage: "memory" });
  const app = new Hono();
  app.use("*", clientIpMiddleware);
  app.get("/api/auth/get-session", (c) => auth.handler(c.req.raw));
  const status = async (peer: string, ip: string, xff = ip) =>
    (
      await app.request(
        "http://localhost:4000/api/auth/get-session",
        { headers: { "x-real-ip": ip, "x-forwarded-for": xff } },
        { incoming: { socket: { remoteAddress: peer } } },
      )
    ).status;

  try {
    env.TRUST_PROXY = true;
    env.OPENSHIP_PUBLIC_URL = "https://ops.example.test";
    // The edge overwrites X-Real-IP but preserves the client-supplied XFF prefix.
    expect(await status("172.18.0.2", "203.0.113.10", "192.0.2.1, 203.0.113.10")).toBe(200);
    expect(await status("172.18.0.2", "203.0.113.10", "192.0.2.2, 203.0.113.10")).toBe(429);
    expect(await status("172.18.0.2", "203.0.113.11", "192.0.2.1, 203.0.113.11")).toBe(200);

    // Rate-limit keys retain Better Auth's IPv6 /64 grouping even though
    // session pinning records the full address.
    expect(await status("172.18.0.2", "2001:db8:1::1")).toBe(200);
    expect(await status("172.18.0.2", "2001:db8:1::2")).toBe(429);
    expect(await status("172.18.0.2", "2001:db8:2::1")).toBe(200);

    env.TRUST_PROXY = false;
    // A direct untrusted peer cannot change its bucket with any forwarded header.
    expect(await status("203.0.113.20", "192.0.2.10")).toBe(200);
    expect(await status("203.0.113.20", "192.0.2.11")).toBe(429);
    expect(await status("203.0.113.21", "192.0.2.10")).toBe(200);

    // A public dashboard on loopback still needs explicit proxy trust.
    expect(await status("127.0.0.1", "192.0.2.20")).toBe(200);
    expect(await status("127.0.0.1", "192.0.2.21")).toBe(429);
  } finally {
    Object.assign(context.rateLimit, previousRateLimit);
    Object.assign(env, previousEnv);
  }
});
