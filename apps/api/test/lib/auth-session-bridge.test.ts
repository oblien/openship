import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { closeDb, db, schema, eq } from "@repo/db";
import { auth } from "@repo/platform/engine/lib/auth";
import { provisionUser } from "@repo/platform/engine/lib/provision-user";
import { mintSession } from "../../src/lib/cloud-auth-proxy";
import { setSessionCookie } from "../../src/lib/session-cookie";

vi.mock("@repo/db", async (original) => {
  const value = await original<typeof import("@repo/db")>();
  return { ...value, getDriver: () => "postgres" };
});

afterAll(() => closeDb());

async function user() {
  const id = randomUUID();
  await provisionUser({
    id,
    email: `${id}@example.test`,
    name: "Local operator",
    emailVerified: true,
  });
  return id;
}

describe("authenticated session bridge", () => {
  it("rolls back a session when the pairing transaction fails", async () => {
    const userId = await user();
    await auth.$context;
    await expect(
      db.transaction(async (tx) => {
        await mintSession({ purpose: "local-cookie", userId }, tx);
        throw new Error("Pairing was not committed");
      }),
    ).rejects.toThrow("Pairing was not committed");
    expect(await db.query.session.findMany({ where: eq(schema.session.userId, userId) })).toEqual(
      [],
    );
  });
  it("uses the same session policy hooks as a normal Better Auth sign-in", async () => {
    const userId = await user();
    const context = await auth.$context;
    const hooks = context.options.databaseHooks!.session!.create!;
    const original = hooks.before;
    hooks.before = async () => false;
    try {
      await expect(mintSession({ purpose: "local-cookie", userId })).rejects.toThrow();
      expect(await db.query.session.findMany({ where: eq(schema.session.userId, userId) })).toEqual(
        [],
      );
    } finally {
      hooks.before = original;
    }
  });

  it("preserves the selected workspace, explicit CLI expiry and independent revocation", async () => {
    const userId = await user();
    const context = await auth.$context;
    const browser = await mintSession({ purpose: "local-cookie", userId });
    const before = Date.now();
    const command = await mintSession({
      purpose: "local-cli",
      userId,
      activeOrganizationId: `org_${userId}`,
      userAgent: "openship-cli/local",
      ttlSeconds: 120,
    });
    expect(command.token).not.toBe(browser.token);
    expect(command.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 120_000);
    expect(command.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 120_000);
    const identity = await auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${command.token}` }),
    });
    expect(identity).toMatchObject({
      session: { id: command.id, activeOrganizationId: `org_${userId}` },
      user: { id: userId },
    });
    expect(identity?.session.expiresAt).toEqual(command.expiresAt);
    const response = await auth.handler(
      new Request("http://localhost:4000/api/auth/get-session", {
        headers: { authorization: `Bearer ${command.token}` },
      }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).session.expiresAt).toBe(command.expiresAt.toISOString());
    expect((await context.internalAdapter.findSession(command.token))?.session.expiresAt).toEqual(
      command.expiresAt,
    );
    await context.internalAdapter.deleteSession(command.token);
    expect(
      await auth.api.getSession({
        headers: new Headers({ authorization: `Bearer ${command.token}` }),
      }),
    ).toBeNull();
    expect(
      await auth.api.getSession({
        headers: new Headers({ authorization: `Bearer ${browser.token}` }),
      }),
    ).not.toBeNull();
  });

  it("keeps browser renewal after a bearer lookup without extending that bearer", async () => {
    const context = await auth.$context;
    const session = await mintSession({
      purpose: "local-cookie",
      userId: await user(),
      ttlSeconds: 120,
    });
    await auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${session.token}` }),
    });
    expect((await context.internalAdapter.findSession(session.token))?.session.expiresAt).toEqual(
      session.expiresAt,
    );
    const app = new Hono().get("/", async (c) => {
      await setSessionCookie(c, session.token);
      return c.json({ ok: true });
    });
    const response = await app.request("http://localhost/");
    const cookie = response.headers
      .getSetCookie()
      .find((value) => value.startsWith(`${context.authCookies.sessionToken.name}=`))!
      .split(";")[0]!;
    const renewed = await auth.api.getSession({
      headers: new Headers({ cookie }),
      query: { disableCookieCache: true },
    });
    expect(renewed?.session.expiresAt.getTime()).toBeGreaterThan(
      Date.now() + 29 * 24 * 60 * 60_000,
    );
  });

  it.each([false, true])(
    "uses Better Auth's cookie name, domain and TLS policy (HTTPS: %s)",
    async (secure) => {
      const userId = await user();
      const context = await auth.$context;
      const original = context.authCookies.sessionToken;
      // Exercise configured cookie policy, including Better Auth's secure prefix.
      context.authCookies.sessionToken = {
        name: `${secure ? "__Secure-" : ""}openship.session_token`,
        attributes: {
          ...original.attributes,
          secure,
          ...(secure ? { domain: "example.test" } : { domain: undefined }),
        },
      };
      try {
        const session = await mintSession({ purpose: "local-cookie", userId, ttlSeconds: 120 });
        const app = new Hono().get("/", async (c) => {
          await setSessionCookie(c, session.token);
          return c.json({ ok: true });
        });
        const response = await app.request(`${secure ? "https" : "http"}://example.test/`);
        const cookie = response.headers
          .getSetCookie()
          .find((value) => value.startsWith(`${context.authCookies.sessionToken.name}=`))!;
        expect(cookie.startsWith(`${context.authCookies.sessionToken.name}=`)).toBe(true);
        expect(cookie.includes("; Secure")).toBe(secure);
        expect(cookie.includes("Domain=example.test")).toBe(secure);
        expect(cookie).toContain("HttpOnly");
        expect(cookie).toContain("SameSite=Lax");
        const maxAge = Number(/Max-Age=(\d+)/.exec(cookie)?.[1]);
        expect(maxAge).toBeGreaterThan(0);
        expect(maxAge).toBeLessThanOrEqual(120);
        expect(
          await auth.api.getSession({ headers: new Headers({ cookie: cookie.split(";")[0]! }) }),
        ).toMatchObject({ user: { id: userId } });
      } finally {
        context.authCookies.sessionToken = original;
      }
    },
  );

  it("replaces the previous cached identity when a bridge signs in another account", async () => {
    const first = await mintSession({ purpose: "local-cookie", userId: await user() });
    const nextUserId = await user();
    const second = await mintSession({ purpose: "local-cookie", userId: nextUserId });
    let token = first.token;
    const app = new Hono().get("/", async (c) => {
      await setSessionCookie(c, token);
      return c.json({ ok: true });
    });
    const jar = new Map<string, string>();
    const cookies = () => [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
    const remember = (response: Response) => {
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(";")[0]!;
        const separator = pair.indexOf("=");
        const name = pair.slice(0, separator);
        if (/Max-Age=0(?:;|$)/i.test(cookie)) jar.delete(name);
        else jar.set(name, pair.slice(separator + 1));
      }
    };
    remember(await app.request("http://localhost/"));
    // The browser's normal session fetch also populates the cache on the old
    // bridge, so this also covers switching an already cached account.
    remember(
      await auth.api.getSession({ headers: new Headers({ cookie: cookies() }), asResponse: true }),
    );
    expect([...jar.keys()].some((name) => name.includes(".session_data"))).toBe(true);
    token = second.token;
    remember(await app.request("http://localhost/", { headers: { cookie: cookies() } }));
    expect(
      await auth.api.getSession({ headers: new Headers({ cookie: cookies() }) }),
    ).toMatchObject({ session: { id: second.id }, user: { id: nextUserId } });
  });

  it("does not expose the server-only cookie bridge over HTTP", async () => {
    const session = await mintSession({ purpose: "local-cookie", userId: await user() });
    const response = await auth.handler(
      new Request("http://localhost:4000/api/auth/set-bridge-session-cookie", {
        method: "POST",
        headers: { authorization: `Bearer ${session.token}` },
      }),
    );
    expect(response.status).toBe(404);
    expect(response.headers.has("set-cookie")).toBe(false);
  });
});
