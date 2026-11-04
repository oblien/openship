import { createHash, randomUUID } from "node:crypto";
import { afterAll, expect, it, vi } from "vitest";
import { Hono } from "hono";

vi.hoisted(() => {
  process.env.DEPLOY_MODE = "desktop";
  process.env.OPENSHIP_AUTH_MODE = "none";
  process.env.OPENSHIP_ADVERTISED_ORIGIN = "http://127.0.0.1:41235";
  process.env.OPENSHIP_LOCAL_DASHBOARD_URL = "http://localhost:3001";
  process.env.BETTER_AUTH_SECRET = "desktop-mcp-regression-secret-01234567890123456789";
  delete process.env.OPENSHIP_PUBLIC_URL;
});
vi.mock("../../src/app", () => ({ app: { fetch: vi.fn() } }));

import { closeDb, repos } from "@repo/db";
import { auth } from "@repo/platform/engine/lib/auth";
import { authRoutes } from "../../src/modules/auth/auth.routes";
import { bootstrapMcpSession } from "../../src/middleware/mcp-session";
import { shutdownRateLimit } from "../../src/lib/rate-limit";
import { LOCAL_EMAIL } from "../../src/lib/local-user";

const origin = "http://127.0.0.1:41235";
const app = new Hono()
  .use("/api/auth/mcp/authorize", bootstrapMcpSession)
  .route("/api/auth", authRoutes);

afterAll(async () => {
  await shutdownRateLimit();
  await closeDb();
});

it("preserves a desktop POST through loopback bootstrap and still rejects a remote peer", async () => {
  const registration = await app.request(`${origin}/api/auth/mcp/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: ["http://127.0.0.1:4333/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    }),
  });
  expect(registration.status).toBe(201);
  const { client_id } = (await registration.json()) as { client_id: string };
  const form = new URLSearchParams({
    client_id,
    response_type: "code",
    redirect_uri: "http://127.0.0.1:4333/callback",
    code_challenge: createHash("sha256")
      .update(randomUUID() + randomUUID())
      .digest("base64url"),
    code_challenge_method: "S256",
    scope: "openid",
    state: randomUUID(),
  });
  const request = (cookie?: string) =>
    new Request(`${origin}/api/auth/mcp/authorize`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(cookie ? { cookie } : {}),
      },
      body: form,
    });
  const peer = (remoteAddress: string) => ({
    incoming: { socket: { remoteAddress, remoteFamily: "IPv4" } },
  });
  const remote = await app.fetch(request(), peer("192.0.2.20"));
  expect(remote.status).toBe(302);
  expect(await repos.user.findByEmail(LOCAL_EMAIL)).toBeUndefined();

  const bootstrap = await app.fetch(request(), peer("127.0.0.1"));
  expect(bootstrap.status).toBe(307);
  expect(bootstrap.headers.get("location")).toBe(`${origin}/api/auth/mcp/authorize`);
  const cookieName = (await auth.$context).authCookies.sessionToken.name;
  const cookie = bootstrap.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${cookieName}=`))
    ?.split(";")[0];
  expect(cookie).toBeTruthy();
  const consent = await app.fetch(request(cookie), peer("127.0.0.1"));
  expect(consent.status).toBe(302);
  const destination = new URL(consent.headers.get("location")!);
  expect(destination.pathname).toBe("/mcp/authorize");
  expect(destination.searchParams.get("sig")).toBeTruthy();
  expect(destination.searchParams.get("client_id")).toBe(client_id);
  expect(destination.searchParams.get("code_challenge")).toBe(form.get("code_challenge"));
  expect(destination.searchParams.get("resource")).toBe(`${origin}/api/mcp`);
});
