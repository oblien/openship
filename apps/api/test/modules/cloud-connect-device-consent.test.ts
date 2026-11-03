import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { db, schema } from "@repo/db";
import { isCloudDeviceAuthorization } from "@repo/contracts";
import { auth } from "@repo/platform/engine/lib/auth";
import { seedOwner, installFakeRunner, type SeededOwner } from "./jobs/_harness";
import { mintSession } from "../../src/lib/cloud-auth-proxy";
import { cloudSaasRoutes } from "../../src/modules/cloud/cloud-saas.routes";
import { handleApiError } from "../../src/middleware/error-handler";
import { trustedOrigins } from "@repo/platform/engine/config/env";
import { shutdownRateLimit } from "../../src/lib/rate-limit";

/**
 * H20 regression: the headless CLI device flow must not be approvable from a
 * bare link. `device-authorize` issues an opaque state plus a one-time
 * user code; the consent page must echo that code back with the matching state
 * and PKCE challenge before a session can be minted.
 */

vi.mock("@repo/db", async (original) => {
  const value = await original<typeof import("@repo/db")>();
  // Exercise Cloud's cookie cache using the isolated PGlite database.
  return { ...value, getDriver: () => "postgres" };
});

vi.mock("@repo/platform/engine/config/env", async (original) => {
  const config = await original<typeof import("@repo/platform/engine/config/env")>();
  return { ...config, env: { ...config.env, CLOUD_MODE: true } };
});

installFakeRunner();

const app = new Hono()
  .onError(handleApiError)
  .use("/api/cloud/*", async (c, next) => {
    c.set("clientIp", "192.0.2.10");
    await next();
  })
  .route("/api/cloud", cloudSaasRoutes);

const b64url = (buf: Buffer) =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function pkce() {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

async function startDeviceAuthorization(challenge: string) {
  const response = await app.request("/api/cloud/device-authorize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code_challenge: challenge }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const body: unknown = await response.json();
  // The CLI consumes this same shared wire contract.
  if (!isCloudDeviceAuthorization(body)) throw new Error("Invalid device authorization response");
  return body;
}

function authorize(body: Record<string, unknown>) {
  return app.request("/api/cloud/connect-authorize", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: trustedOrigins[0]!,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function asCloudSession(owner: SeededOwner) {
  const session = await mintSession({
    purpose: "local-cookie",
    userId: owner.userId,
    activeOrganizationId: owner.orgId,
  });
  const { headers } = await auth.api.setBridgeSessionCookie({
    headers: new Headers({ authorization: `Bearer ${session.token}` }),
    returnHeaders: true,
  });
  cookie = headers
    .getSetCookie()
    .filter((value) => !/Max-Age=0(?:;|$)/i.test(value))
    .map((value) => value.split(";")[0]!)
    .join("; ");
  expect(await auth.api.getSession({ headers: new Headers({ cookie }) })).not.toBeNull();
  return session;
}

let owner: SeededOwner;
let cookie: string;

beforeAll(() => vi.stubEnv("OPENSHIP_RATE_LIMIT_STORE", "memory"));
afterAll(async () => {
  await shutdownRateLimit();
  vi.unstubAllEnvs();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
beforeEach(async () => {
  owner = await seedOwner();
  cookie = "";
});

describe("Cloud device authorization consent (H20)", () => {
  it("issues an opaque state and a short user code without a session", async () => {
    const { challenge } = pkce();
    const issued = await startDeviceAuthorization(challenge);

    expect(issued.state).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(issued.state.length).toBeLessThanOrEqual(256);
    expect(issued.user_code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(issued.expires_in).toBe(300);
  });

  it("rejects a missing or malformed PKCE challenge", async () => {
    for (const code_challenge of [undefined, "", "short", "has spaces in it"]) {
      const response = await app.request("/api/cloud/device-authorize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(code_challenge === undefined ? {} : { code_challenge }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "MISSING_CODE_CHALLENGE" });
    }
  });

  it("rejects malformed start bodies without coercing a challenge or throwing", async () => {
    const { challenge } = pkce();
    for (const body of [null, [], "invalid", { code_challenge: [challenge] }]) {
      const response = await app.request("/api/cloud/device-authorize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status, await response.clone().text()).toBe(400);
    }
  });

  it("rejects an attacker-chosen state at the browser handoff", async () => {
    const { challenge } = pkce();
    const attackerState = b64url(randomBytes(24));
    const response = await app.request(
      `/api/cloud/connect-handoff?mode=device&state=${encodeURIComponent(attackerState)}&code_challenge=${challenge}`,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_DEVICE_AUTHORIZATION" });
  });

  it("rejects an expired state at the browser handoff", async () => {
    const { challenge } = pkce();
    const issued = await startDeviceAuthorization(challenge);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 6 * 60_000);

    const response = await app.request(
      `/api/cloud/connect-handoff?mode=device&state=${encodeURIComponent(issued.state)}&code_challenge=${challenge}`,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_DEVICE_AUTHORIZATION" });
  });

  it("forwards a valid device authorization to the consent page without minting a code", async () => {
    const { challenge } = pkce();
    const issued = await startDeviceAuthorization(challenge);

    const response = await app.request(
      `/api/cloud/connect-handoff?mode=device&state=${encodeURIComponent(issued.state)}&code_challenge=${challenge}`,
      { redirect: "manual" },
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/cloud-authorize");
    expect(location.searchParams.get("mode")).toBe("device");
    expect(location.searchParams.get("state")).toBe(issued.state);
    expect(location.searchParams.get("code_challenge")).toBe(challenge);
    expect(location.searchParams.get("code")).toBeNull();
  });

  it("requires the user code for device authorization", async () => {
    await asCloudSession(owner);
    const { challenge } = pkce();
    const issued = await startDeviceAuthorization(challenge);

    const missing = await authorize({
      mode: "device",
      state: issued.state,
      codeChallenge: challenge,
    });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ code: "MISSING_USER_CODE" });

    const wrong = await authorize({
      mode: "device",
      state: issued.state,
      codeChallenge: challenge,
      userCode: "AAAA-AAAA",
    });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ code: "INVALID_USER_CODE" });
    const corrected = await authorize({
      mode: "device",
      state: issued.state,
      codeChallenge: challenge,
      userCode: issued.user_code,
    });
    expect(corrected.status).toBe(200);
  });

  it("binds the user code to its state and PKCE challenge", async () => {
    await asCloudSession(owner);
    const flowA = pkce();
    const flowB = pkce();
    const issuedA = await startDeviceAuthorization(flowA.challenge);
    const issuedB = await startDeviceAuthorization(flowB.challenge);

    // Correct code presented with someone else's state.
    const crossState = await authorize({
      mode: "device",
      state: issuedA.state,
      codeChallenge: flowA.challenge,
      userCode: issuedB.user_code,
    });
    expect(crossState.status).toBe(400);
    expect(await crossState.json()).toMatchObject({ code: "INVALID_USER_CODE" });

    // Correct state + code presented with a different PKCE challenge.
    const crossChallenge = await authorize({
      mode: "device",
      state: issuedA.state,
      codeChallenge: flowB.challenge,
      userCode: issuedA.user_code,
    });
    expect(crossChallenge.status).toBe(400);
    expect(await crossChallenge.json()).toMatchObject({ code: "INVALID_USER_CODE" });
  });

  it("cannot be approved from an attacker link even when the victim is signed in", async () => {
    await asCloudSession(owner);
    const { challenge } = pkce();
    const issuedForVictim = await startDeviceAuthorization(challenge);

    // The attacker links a pending request they started, then hopes the signed-in
    // victim clicks Authorize. Without the terminal code, nothing is minted.
    const attackerFlow = pkce();
    const attackerIssued = await startDeviceAuthorization(attackerFlow.challenge);
    const response = await authorize({
      mode: "device",
      state: attackerIssued.state,
      codeChallenge: attackerFlow.challenge,
      userCode: issuedForVictim.user_code,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_USER_CODE" });

    const poll = await app.request(
      `/api/cloud/connect-poll?state=${encodeURIComponent(attackerIssued.state)}`,
    );
    expect(await poll.json()).toEqual({ status: "pending" });
  });

  it("still requires a signed-in Cloud session after a valid user code", async () => {
    const { challenge } = pkce();
    const issued = await startDeviceAuthorization(challenge);

    const response = await authorize({
      mode: "device",
      state: issued.state,
      codeChallenge: challenge,
      userCode: issued.user_code,
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "UNAUTHENTICATED" });

    // A rejected attempt must not consume the terminal's request.
    await asCloudSession(owner);
    const approved = await authorize({
      mode: "device",
      state: issued.state,
      codeChallenge: challenge,
      userCode: issued.user_code,
    });
    expect(approved.status).toBe(200);
  });

  it("refuses an expired approval even if the consent page was opened earlier", async () => {
    await asCloudSession(owner);
    const { challenge } = pkce();
    const issued = await startDeviceAuthorization(challenge);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + (issued.expires_in + 1) * 1000);

    const response = await authorize({
      mode: "device",
      state: issued.state,
      codeChallenge: challenge,
      userCode: issued.user_code,
    });
    expect(response.status).toBe(400);
    const poll = await app.request(
      `/api/cloud/connect-poll?state=${encodeURIComponent(issued.state)}`,
    );
    expect(await poll.json()).toEqual({ status: "pending" });
  });

  it("rejects approval after revocation even with a valid cached browser session", async () => {
    const browser = await asCloudSession(owner);
    const { challenge } = pkce();
    const issued = await startDeviceAuthorization(challenge);
    await (await auth.$context).internalAdapter.deleteSession(browser.token);

    const response = await authorize({
      mode: "device",
      state: issued.state,
      codeChallenge: challenge,
      userCode: issued.user_code,
    });
    expect(response.status).toBe(401);
    const poll = await app.request(
      `/api/cloud/connect-poll?state=${encodeURIComponent(issued.state)}`,
    );
    expect(await poll.json()).toEqual({ status: "pending" });
  });

  it("completes the device flow for the CLI that started it", async () => {
    const browser = await asCloudSession(owner);
    const { verifier, challenge } = pkce();
    const issued = await startDeviceAuthorization(challenge);

    const authorized = await authorize({
      mode: "device",
      state: issued.state,
      codeChallenge: challenge,
      userCode: issued.user_code.toLowerCase(), // typed by a human; normalized server-side
    });
    expect(authorized.status, await authorized.clone().text()).toBe(200);
    expect(await authorized.json()).toEqual({ authorized: true });

    const poll = await app.request(
      `/api/cloud/connect-poll?state=${encodeURIComponent(issued.state)}`,
    );
    expect(poll.status).toBe(200);
    const polled = (await poll.json()) as { status: string; code: string };
    expect(polled.status).toBe("ready");
    expect(polled.code).toMatch(/^[a-f0-9]{64}$/);

    const exchanged = await app.request("/api/cloud/exchange-code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: polled.code, code_verifier: verifier }),
    });
    expect(exchanged.status, await exchanged.clone().text()).toBe(200);
    const exchangedBody = (await exchanged.json()) as {
      data: { user: { id: string }; sessionToken: string };
    };
    expect(exchangedBody.data.user.id).toBe(owner.userId);
    expect(exchangedBody.data.sessionToken).toBeTruthy();
    expect(exchangedBody.data.sessionToken).not.toBe(browser.token);

    // The minted linked-instance session can read the victim's own account...
    const account = await app.request("/api/cloud/account", {
      headers: { authorization: `Bearer ${exchangedBody.data.sessionToken}` },
    });
    expect(account.status, await account.clone().text()).toBe(200);
    expect((await account.json()).user).toMatchObject({
      id: owner.userId,
      organizationId: owner.orgId,
    });

    // ...and nothing more than the org the consent page showed.
    const exported = await app.request("/api/cloud/export-subgraph", {
      method: "POST",
      headers: {
        authorization: `Bearer ${exchangedBody.data.sessionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ scope: { kind: "organization", organizationId: owner.orgId } }),
    });
    expect(exported.status, await exported.clone().text()).toBe(200);
    expect(await exported.json()).toMatchObject({ ok: true });

    // One-time: replaying the same code cannot mint a second session.
    const replay = await app.request("/api/cloud/exchange-code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: polled.code, code_verifier: verifier }),
    });
    expect(replay.status).toBe(401);

    // The approval itself is also single-use, not just its exchange code.
    const repeatedApproval = await authorize({
      mode: "device",
      state: issued.state,
      codeChallenge: challenge,
      userCode: issued.user_code,
    });
    expect(repeatedApproval.status).toBe(400);
    const repeatedPoll = await app.request(
      `/api/cloud/connect-poll?state=${encodeURIComponent(issued.state)}`,
    );
    expect(await repeatedPoll.json()).toEqual({ status: "pending" });
  });

  it("allows only one of two concurrent approvals to create a linked session", async () => {
    await asCloudSession(owner);
    const { challenge } = pkce();
    const issued = await startDeviceAuthorization(challenge);
    const body = {
      mode: "device",
      state: issued.state,
      codeChallenge: challenge,
      userCode: issued.user_code,
    };
    const responses = await Promise.all([authorize(body), authorize(body)]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
  });

  it("keeps the selected Cloud workspace when the browser cache still names the personal workspace", async () => {
    const browser = await asCloudSession(owner);
    const team = await seedOwner();
    await db.insert(schema.member).values({
      id: randomUUID(),
      userId: owner.userId,
      organizationId: team.orgId,
      role: "owner",
      createdAt: new Date(),
    });
    await auth.api.setActiveOrganization({
      headers: new Headers({ cookie }),
      body: { organizationId: team.orgId },
    });
    const { verifier, challenge } = pkce();
    const issued = await startDeviceAuthorization(challenge);
    const approved = await authorize({
      mode: "device",
      state: issued.state,
      codeChallenge: challenge,
      userCode: issued.user_code,
    });
    expect(approved.status).toBe(200);
    const poll = await app.request(
      `/api/cloud/connect-poll?state=${encodeURIComponent(issued.state)}`,
    );
    const { code } = await poll.json();
    const exchanged = await app.request("/api/cloud/exchange-code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, code_verifier: verifier }),
    });
    expect(exchanged.status).toBe(200);
    const { data } = await exchanged.json();
    const account = await app.request("/api/cloud/account", {
      headers: { authorization: `Bearer ${data.sessionToken}` },
    });
    expect(account.status).toBe(200);
    expect((await account.json()).user).toMatchObject({
      id: owner.userId,
      organizationId: team.orgId,
    });
    expect(data.sessionToken).not.toBe(browser.token);
    expect(await auth.api.getSession({ headers: new Headers({ cookie }) })).not.toBeNull();
  });

  it("leaves the browser-redirect flow free of the device code requirement", async () => {
    await asCloudSession(owner);
    const { challenge } = pkce();
    const redirect = "http://localhost:3000/api/cloud/connect-callback";

    const response = await authorize({
      redirect,
      state: b64url(randomBytes(24)),
      codeChallenge: challenge,
    });

    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as { callbackUrl: string };
    const callback = new URL(body.callbackUrl);
    expect(callback.searchParams.get("code")).toMatch(/^[a-f0-9]{64}$/);
  });
});
