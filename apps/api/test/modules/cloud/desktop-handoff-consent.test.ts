import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { db, repos, schema, eq } from "@repo/db";
import { auth } from "@repo/platform/engine/lib/auth";
import { provisionUser } from "@repo/platform/engine/lib/provision-user";
import { mintSession } from "../../../src/lib/cloud-auth-proxy";
import { setSessionCookie } from "../../../src/lib/session-cookie";
import { originGuard } from "../../../src/middleware/origin-guard";
import { cloudSaasRoutes } from "../../../src/modules/cloud/cloud-saas.routes";
import { shutdownRateLimit } from "../../../src/lib/rate-limit";

const config = vi.hoisted(() => ({ origin: "http://127.0.0.1", trusted: [] as string[] }));
vi.mock("@repo/db", async (original) => {
  const value = await original<typeof import("@repo/db")>();
  // Exercise Cloud's cookie cache using the isolated PGlite database.
  return { ...value, getDriver: () => "postgres" };
});
vi.mock("@repo/platform/engine/config/env", async (original) => {
  const value = await original<typeof import("@repo/platform/engine/config/env")>();
  return {
    ...value,
    env: { ...value.env, CLOUD_MODE: true },
    trustedOrigins: config.trusted,
    cloudRuntimeTarget: {
      ...value.cloudRuntimeTarget,
      get dashboard() {
        return config.origin;
      },
    },
  };
});

let browser: Awaited<ReturnType<typeof mintSession>>;
let cookie: string;
let userId: string;
const verifier = "v".repeat(43);
const challenge = createHash("sha256").update(verifier).digest("base64url");
const callback = "http://localhost:4500/api/auth/cloud-callback";
const app = new Hono()
  .use("*", async (c, next) => {
    c.set("clientIp", "127.0.0.1");
    await next();
  })
  .use("*", originGuard)
  .route("/api/cloud", cloudSaasRoutes);
app.get("/test/browser-session", async (c) => {
  await setSessionCookie(c, browser.token);
  return c.json({ ok: true });
});
const server = createServer(async (incoming, outgoing) => {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  const response = await app.fetch(
    new Request(`${config.origin}${incoming.url}`, {
      method: incoming.method,
      headers,
      ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
    }),
  );
  outgoing.writeHead(response.status, {
    ...Object.fromEntries(response.headers),
    "set-cookie": response.headers.getSetCookie(),
  });
  outgoing.end(Buffer.from(await response.arrayBuffer()));
});
const request = (path: string, init?: RequestInit) =>
  fetch(`${config.origin}${path}`, { redirect: "manual", ...init });
const approve = (
  body: Record<string, unknown>,
  origin: string | null = config.origin,
  session = cookie,
) =>
  request("/api/cloud/connect-authorize", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(origin ? { Origin: origin } : {}),
      ...(session ? { Cookie: session } : {}),
    },
    body: JSON.stringify(body),
  });
const desktopBody = (state = randomUUID()) => ({
  redirect: callback,
  state,
  codeChallenge: challenge,
  mode: "desktop",
});
const sessions = () => db.query.session.findMany({ where: eq(schema.session.userId, userId) });

beforeAll(async () => {
  process.env.OPENSHIP_RATE_LIMIT_STORE = "memory";
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTP fixture port");
  config.origin = `http://127.0.0.1:${address.port}`;
  config.trusted.push(config.origin);
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await shutdownRateLimit();
});
beforeEach(async () => {
  userId = `consent-${randomUUID()}`;
  await provisionUser({
    id: userId,
    name: "Browser user",
    email: `${userId}@example.test`,
    emailVerified: true,
    role: "user",
  });
  browser = await mintSession({ purpose: "local-cookie", userId });
  const response = await request("/test/browser-session");
  cookie = response.headers
    .getSetCookie()
    .filter((value) => !/Max-Age=0(?:;|$)/i.test(value))
    .map((value) => value.split(";")[0]!)
    .join("; ");
  expect(await auth.api.getSession({ headers: new Headers({ cookie }) })).not.toBeNull();
});

describe("desktop browser consent over HTTP", () => {
  it("keeps a cookie-authenticated navigation side-effect free and leaves public polling pending", async () => {
    const state = randomUUID();
    const params = new URLSearchParams({ redirect: callback, state, code_challenge: challenge });
    const response = await request(`/api/cloud/desktop-handoff?${params}`, {
      headers: { Cookie: cookie, "Sec-Fetch-Site": "cross-site" },
    });
    expect(response.status, await response.clone().text()).toBe(302);
    const consent = new URL(response.headers.get("location")!);
    expect(consent.origin).toBe(config.origin);
    expect(consent.pathname).toBe("/authorize");
    expect(consent.searchParams.get("callback")).toBe(callback);
    expect(consent.searchParams.get("state")).toBe(state);
    expect(consent.searchParams.get("code_challenge")).toBe(challenge);
    expect(await repos.cloudHandoffCode.findByState(state)).toBeNull();
    expect(await (await request(`/api/cloud/connect-poll?state=${state}`)).json()).toEqual({
      status: "pending",
    });
    expect(await sessions()).toHaveLength(1);
  });

  it("requires trusted explicit approval and exchanges only a separate PKCE-bound linked session", async () => {
    const body = desktopBody();
    expect((await approve(body, "https://other.example.test")).status).toBe(403);
    const noOrigin = await approve(body, null);
    expect(noOrigin.status, await noOrigin.clone().text()).toBe(403);
    expect((await approve(body, config.origin, "")).status).toBe(401);
    const form = await request("/api/cloud/connect-authorize", {
      method: "POST",
      headers: { Origin: config.origin, Cookie: cookie, "Content-Type": "text/plain" },
      body: JSON.stringify(body),
    });
    expect(form.status).toBe(415);
    expect(await sessions()).toHaveLength(1);

    const response = await approve(body);
    expect(response.status, await response.clone().text()).toBe(200);
    const approved = new URL((await response.json()).callbackUrl);
    expect(approved.origin).toBe(new URL(callback).origin);
    expect(approved.searchParams.get("state")).toBe(body.state);
    const code = approved.searchParams.get("code")!;
    const exchange = await request("/api/cloud/exchange-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, code_verifier: verifier }),
    });
    expect(exchange.status).toBe(200);
    const token = (await exchange.json()).data.sessionToken;
    expect(token).not.toBe(browser.token);
    const linked = (await sessions()).find((row) => row.token === token);
    expect(linked?.id).toBeTruthy();
    expect(linked?.id).not.toBe(browser.id);
    expect(linked?.activeOrganizationId).toBe(`org_${userId}`);
    expect(await auth.api.getSession({ headers: new Headers({ cookie }) })).not.toBeNull();
    expect(
      (
        await request("/api/cloud/exchange-code", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code, code_verifier: verifier }),
        })
      ).status,
    ).toBe(401);

    const disconnect = await request("/api/cloud/disconnect", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(disconnect.status, await disconnect.clone().text()).toBe(200);
    expect(
      await auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${token}` }) }),
    ).toBeNull();
    expect(await auth.api.getSession({ headers: new Headers({ cookie }) })).not.toBeNull();
    expect(await sessions()).toHaveLength(1);
  });

  it("does not approve with a revoked session retained in a valid cookie cache", async () => {
    const cached = await auth.api.getSession({
      headers: new Headers({ cookie }),
      query: { disableCookieCache: true },
      asResponse: true,
    });
    const cachedCookies = cached.headers.getSetCookie().map((value) => value.split(";")[0]!);
    expect(cachedCookies.some((value) => value.includes(".session_data="))).toBe(true);
    const staleCookie = [cookie, ...cachedCookies].join("; ");
    await (await auth.$context).internalAdapter.deleteSession(browser.token);
    // Prove this is a still-valid cache, not an expired or malformed cookie.
    expect(
      await auth.api.getSession({ headers: new Headers({ cookie: staleCookie }) }),
    ).not.toBeNull();
    expect((await approve(desktopBody(), config.origin, staleCookie)).status).toBe(401);
    expect(await sessions()).toHaveLength(0);
  });

  it("retains PKCE, callback validation, and self-hosted approval compatibility", async () => {
    expect(
      (await approve({ ...desktopBody(), redirect: "https://other.example.test/callback" })).status,
    ).toBe(400);
    expect(
      (
        await approve({
          ...desktopBody(),
          redirect: "http://user:password@localhost:4500/callback",
        })
      ).status,
    ).toBe(400);
    expect(
      (await approve({ ...desktopBody(), redirect: "http://localhost:80/callback" })).status,
    ).toBe(400);
    const body = desktopBody();
    const approved = await approve(body);
    expect(approved.status, await approved.clone().text()).toBe(200);
    const code = new URL((await approved.json()).callbackUrl).searchParams.get("code");
    expect(
      (
        await request("/api/cloud/exchange-code", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code, code_verifier: "wrong" }),
        })
      ).status,
    ).toBe(401);

    const local = await approve({
      ...desktopBody(),
      mode: undefined,
      redirect: "https://instance.example.test/cloud-connect-callback",
    });
    expect(local.status).toBe(200);
    expect(new URL((await local.json()).callbackUrl).hostname).toBe("instance.example.test");
  });
});
