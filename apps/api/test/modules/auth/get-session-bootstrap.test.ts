import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
const posture = vi.hoisted(() => ({
  allowed: true,
  cloud: false,
  publicUrl: "",
  requireAuth: false,
  loopback: true,
}));
vi.mock("@repo/platform/engine/config/env", async (original) => {
  const actual = await original<typeof import("@repo/platform/engine/config/env")>();
  return {
    ...actual,
    env: {
      ...actual.env,
      DEPLOY_MODE: "desktop",
      get CLOUD_MODE() {
        return posture.cloud;
      },
      get OPENSHIP_PUBLIC_URL() {
        return posture.publicUrl;
      },
      get OPENSHIP_REQUIRE_AUTH() {
        return posture.requireAuth;
      },
    },
  };
});
vi.mock("@/middleware/zero-auth-guard", () => ({
  zeroAuthAllowed: async () =>
    posture.allowed ? { ok: true } : { ok: false, reason: "requires-authentication" },
}));
vi.mock("@/middleware/loopback-peer", async (original) => ({
  ...(await original<typeof import("@/middleware/loopback-peer")>()),
  isLoopbackRequest: () => posture.loopback,
}));
import { closeDb, db, eq, repos, schema } from "@repo/db";
import { provisionUser } from "@repo/platform/engine/lib/provision-user";
import { auth } from "@repo/platform/engine/lib/auth";
import { ensureLocalUser, invalidateLocalUserCache, rememberDesktopUser } from "@/lib/local-user";
import * as proxy from "@/lib/cloud-auth-proxy";
import {
  getSession,
  desktopLogin,
  desktopClaim,
  desktopAuthStart,
  cloudCallback,
} from "@/modules/auth/auth.controller";
import { setSessionCookie } from "@/lib/session-cookie";

const app = new Hono()
  .get("/get-session", getSession)
  .get("/login", desktopLogin)
  .get("/claim", desktopClaim)
  .post("/start", desktopAuthStart)
  .get("/callback", cloudCallback);
afterAll(() => closeDb());
beforeEach(async () => {
  vi.restoreAllMocks();
  Object.assign(posture, {
    allowed: true,
    cloud: false,
    publicUrl: "",
    requireAuth: false,
    loopback: true,
  });
  await db.delete(schema.instanceController);
  await db.delete(schema.session);
  invalidateLocalUserCache();
});
async function administrator(role = "admin") {
  const id = randomUUID();
  await provisionUser({
    id,
    email: `${id}@cloud.test`,
    name: "Cloud User",
    emailVerified: true,
    role,
  });
  return id;
}
async function cookie(userId: string) {
  const session = await proxy.mintSession({ purpose: "local-cookie", userId });
  const response = await new Hono()
    .get("/", async (c) => {
      await setSessionCookie(c, session.token);
      return c.text("ok");
    })
    .request("/");
  return sessionCookie(response);
}
async function sessionCookie(response: Response) {
  const name = (await auth.$context).authCookies.sessionToken.name;
  return response.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${name}=`))!
    .split(";", 1)[0]!;
}
async function owner() {
  return (
    await db
      .select()
      .from(schema.instanceController)
      .where(eq(schema.instanceController.id, "local"))
  )[0]?.desktopUserId;
}
function claim(token: string) {
  const nonce = randomUUID();
  const state = randomUUID();
  proxy.registerDesktopNonce(nonce, state, "verifier");
  proxy.validateDesktopState(state);
  proxy.resolveDesktopAuth(nonce, token, new Date(Date.now() + 60_000));
  return proxy.pollDesktopAuth(nonce).claimCode!;
}

describe("durable Desktop bootstrap identity (#1612)", () => {
  it.each(["admin", "user"])(
    "preserves a verified legacy %s session during refresh and Desktop startup",
    async (role) => {
      await db.insert(schema.instanceController).values({ installationId: randomUUID() });
      const local = await ensureLocalUser();
      expect(await owner()).toBe(local.id);
      const expected = await administrator(role);
      const existingCookie = await cookie(expected);
      const headers = { cookie: existingCookie };
      expect((await auth.api.getSession({ headers: new Headers(headers) }))?.user.id).toBe(expected);

      const response = await app.request("/get-session", { headers });
      expect(response.status).toBe(200);
      expect((await response.json()).user).toMatchObject({ id: expected, role });
      expect(response.headers.get("set-cookie")).toBeNull();
      const startup = await app.request("/login", { headers });
      expect(startup.status).toBe(302);
      expect(startup.headers.get("set-cookie")).toBeNull();
      expect(await owner()).toBe(local.id);

      // Reading a verified cookie is not an installation ownership change.
      invalidateLocalUserCache();
      expect((await ensureLocalUser()).id).toBe(local.id);
      expect((await (await app.request("/get-session", { headers })).json()).user.id).toBe(expected);
    },
  );
  it("does not rebind an explicitly saved owner from another user's valid cookie", async () => {
    const saved = await administrator();
    await rememberDesktopUser(saved);
    const expected = await administrator();
    const headers = { cookie: await cookie(expected) };
    expect((await (await app.request("/get-session", { headers })).json()).user.id).toBe(expected);
    expect((await app.request("/login", { headers })).headers.get("set-cookie")).toBeNull();
    invalidateLocalUserCache();
    expect((await ensureLocalUser()).id).toBe(saved);
    expect(await owner()).toBe(saved);
  });
  it("does not guess an identity from another user's recent session", async () => {
    const local = await ensureLocalUser();
    const other = await administrator();
    await proxy.mintSession({ purpose: "local-cookie", userId: other });
    expect((await (await app.request("/get-session")).json()).user.id).toBe(local.id);
  });
  it("keeps the authenticated installation owner through cache loss and expired sessions", async () => {
    const expected = await administrator();
    await rememberDesktopUser(expected);
    await db.delete(schema.session);
    invalidateLocalUserCache();
    const other = await administrator("user");
    await proxy.mintSession({ purpose: "local-cookie", userId: other });
    expect((await (await app.request("/get-session")).json()).user.id).toBe(expected);
    expect((await app.request("/login")).headers.get("set-cookie")).toContain(
      "openship.session_token",
    );
    expect(await owner()).toBe(expected);
  });
  it("repairs an existing valid Local User cookie under the same zero-auth policy", async () => {
    const local = await ensureLocalUser();
    const oldCookie = await cookie(local.id);
    const expected = await administrator();
    await rememberDesktopUser(expected);
    const response = await app.request("/get-session", { headers: { cookie: oldCookie } });
    expect((await response.json()).user.id).toBe(expected);
    expect(response.headers.get("set-cookie")).toContain("openship.session_token");
    const startup = await app.request("/login", { headers: { cookie: oldCookie } });
    const restored = await auth.api.getSession({
      headers: new Headers({ cookie: await sessionCookie(startup) }),
    });
    expect(restored?.user.id).toBe(expected);
  });
  it("preserves real authenticated sessions and refuses cookieless bootstrap when the gate fails", async () => {
    const local = await ensureLocalUser();
    const existingCookie = await cookie(local.id);
    await rememberDesktopUser(await administrator());
    posture.allowed = false;
    expect((await app.request("/get-session")).status).toBe(401);
    expect(
      (await (await app.request("/get-session", { headers: { cookie: existingCookie } })).json())
        .user.id,
    ).toBe(local.id);
  });
  it.each(["receiving", "frozen", "connected"] as const)(
    "does not overwrite a %s instance identity",
    async (role) => {
      const expected = await administrator();
      await rememberDesktopUser(expected);
      await db
        .update(schema.instanceController)
        .set({ role })
        .where(eq(schema.instanceController.id, "local"));
      await expect(rememberDesktopUser(await administrator())).rejects.toMatchObject({
        statusCode: 409,
      });
      expect(await owner()).toBe(expected);
    },
  );
  it("refuses an active handoff and non-admin identities", async () => {
    const expected = await administrator();
    await rememberDesktopUser(expected);
    await expect(rememberDesktopUser(await administrator("user"))).rejects.toMatchObject({
      statusCode: 403,
    });
    await db
      .update(schema.instanceController)
      .set({ handoffId: "move-one" })
      .where(eq(schema.instanceController.id, "local"));
    await expect(rememberDesktopUser(await administrator())).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(await owner()).toBe(expected);
  });
  it.each(["cloud", "publicUrl", "requireAuth"] as const)(
    "cannot bind the local owner on a %s instance",
    async (flag) => {
      const expected = await administrator();
      await rememberDesktopUser(expected);
      if (flag === "publicUrl") posture.publicUrl = "https://public.example.test";
      else posture[flag] = true;
      await expect(rememberDesktopUser(await administrator())).rejects.toMatchObject({
        statusCode: 403,
      });
      expect(await owner()).toBe(expected);
    },
  );
  it("does not let an in-flight synthetic bootstrap overwrite the signed-in owner", async () => {
    const local = await ensureLocalUser();
    await db.insert(schema.instanceController).values({ installationId: randomUUID() });
    invalidateLocalUserCache();
    let release!: () => void;
    let reached!: () => void;
    const paused = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = repos.user.findById.bind(repos.user);
    vi.spyOn(repos.user, "findById").mockImplementation(async (id) => {
      const result = await original(id);
      if (id === local.id) {
        reached();
        await barrier;
      }
      return result;
    });
    const bootstrap = ensureLocalUser();
    await paused;
    const expected = await administrator();
    await rememberDesktopUser(expected);
    release();
    expect((await bootstrap).id).toBe(expected);
    expect(await owner()).toBe(expected);
  });
  it("consumes a real signed-in session claim and remembers its administrator", async () => {
    const expected = await administrator();
    const session = await proxy.mintSession({ purpose: "local-cookie", userId: expected });
    const code = claim(session.token);
    const response = await app.request(`/claim?code=${code}`);
    expect(response.status).toBe(302);
    expect(await owner()).toBe(expected);
    expect((await app.request(`/claim?code=${code}`)).status).toBe(400);
  });
  it("does not bind a revoked claim or one presented by a remote peer", async () => {
    const expected = await administrator();
    const session = await proxy.mintSession({ purpose: "local-cookie", userId: expected });
    const revoked = claim(session.token);
    await db.delete(schema.session).where(eq(schema.session.id, session.id));
    expect((await app.request(`/claim?code=${revoked}`)).status).toBe(401);
    expect(await owner()).toBeUndefined();
    const live = await proxy.mintSession({ purpose: "local-cookie", userId: expected });
    posture.loopback = false;
    expect((await app.request(`/claim?code=${claim(live.token)}`)).status).toBe(302);
    expect(await owner()).toBeUndefined();
  });
  it("distinguishes explicit recovery sign-in from connecting Cloud to the current user", async () => {
    const local = await ensureLocalUser();
    const existingCookie = await cookie(local.id);
    for (const intent of ["sign-in", "connect"] as const) {
      const nonce = randomUUID();
      const state = randomUUID();
      const response = await app.request("/start", {
        method: "POST",
        headers: { cookie: existingCookie, "content-type": "application/json" },
        body: JSON.stringify({ nonce, state, code_verifier: "verifier", intent }),
      });
      expect(response.status).toBe(200);
      expect(proxy.validateDesktopState(state)?.connectUserId).toBe(
        intent === "connect" ? local.id : undefined,
      );
    }
  });
  it("keeps the current user's workspace when the Cloud callback connects an account", async () => {
    const local = await ensureLocalUser();
    const nonce = randomUUID();
    const state = randomUUID();
    proxy.registerDesktopNonce(nonce, state, "verifier", local.id);
    vi.spyOn(proxy, "exchangeCodeWithCloud").mockResolvedValue({
      user: {
        id: randomUUID(),
        name: "Cloud account",
        email: "cloud-account@example.test",
        emailVerified: true,
      },
      sessionToken: "test-cloud-session",
    });
    vi.spyOn(proxy, "storeCloudSession").mockResolvedValue(undefined);
    expect((await app.request(`/callback?code=test-code&state=${state}`)).status).toBe(200);
    const code = proxy.pollDesktopAuth(nonce).claimCode!;
    const result = proxy.exchangeDesktopClaim(code)!;
    expect((await (await auth.$context).internalAdapter.findSession(result.token))?.user.id).toBe(
      local.id,
    );
  });
});
