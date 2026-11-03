import { createHash, createHmac, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createLocalJWKSet, jwtVerify } from "jose";
import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";

vi.hoisted(() => {
  process.env.DEPLOY_MODE = "desktop";
  process.env.OPENSHIP_AUTH_MODE = "local";
  process.env.OPENSHIP_PUBLIC_URL = "https://mcp.example.test";
  process.env.BETTER_AUTH_SECRET = "mcp-provider-test-secret-01234567890123456789";
});
vi.mock("../../src/app", () => ({ app: { fetch: vi.fn() } }));
import { closeDb, db, eq, repos, schema } from "@repo/db";
import { auth } from "@repo/platform/engine/lib/auth";
import { env } from "@repo/platform/engine/config/env";
import { seedOrg } from "../helpers/seed";
import { authRoutes } from "../../src/modules/auth/auth.routes";
import { tokenRoutes } from "../../src/modules/tokens/token.routes";
import { bootstrapMcpSession } from "../../src/middleware/mcp-session";
import { resolveBearerIdentity } from "../../src/middleware/auth";
import { shutdownRateLimit } from "../../src/lib/rate-limit";

const ORIGIN = "https://mcp.example.test";
const app = new Hono()
  .use("/api/auth/mcp/authorize", bootstrapMcpSession)
  .use("/api/auth/oauth2/authorize", bootstrapMcpSession)
  .route("/api/auth", authRoutes)
  .route("/api/tokens", tokenRoutes);

afterAll(async () => {
  await shutdownRateLimit();
  await closeDb();
});

async function prepare() {
  const owner = await seedOrg();
  const sessionId = randomUUID(),
    token = randomUUID();
  await db.insert(schema.session).values({
    id: sessionId,
    token,
    userId: owner.userId,
    activeOrganizationId: owner.organizationId,
    expiresAt: new Date(Date.now() + 3600000),
  });
  const signature = createHmac("sha256", env.BETTER_AUTH_SECRET).update(token).digest("base64");
  const cookie = `${(await auth.$context).authCookies.sessionToken.name}=${encodeURIComponent(`${token}.${signature}`)}`;
  const registration = await app.request(`${ORIGIN}/api/auth/mcp/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Security regression client",
      redirect_uris: ["https://client.example/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "openid profile email offline_access",
    }),
  });
  expect(registration.status, await registration.clone().text()).toBe(201);
  const { client_id: clientId } = (await registration.json()) as { client_id: string };
  const verifier = randomUUID() + randomUUID();
  const query = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: "https://client.example/callback",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    scope: "openid profile email offline_access",
    resource: `${ORIGIN}/api/mcp`,
    state: randomUUID(),
    prompt: "consent",
  });
  const authorization = await app.request(`${ORIGIN}/api/auth/mcp/authorize?${query}`, {
    headers: { cookie },
  });
  expect(authorization.status, await authorization.clone().text()).toBe(302);
  const consent = new URL(authorization.headers.get("location")!);
  expect(consent.pathname).toBe("/mcp/authorize");
  expect(consent.searchParams.get("sig")).toBeTruthy();
  return {
    ...owner,
    clientId,
    verifier,
    cookie,
    sessionId,
    query,
    oauthQuery: consent.searchParams.toString(),
  };
}
type Flow = Awaited<ReturnType<typeof prepare>>;
function authorize(query: URLSearchParams, cookie?: string, method = "GET") {
  return app.request(`${ORIGIN}/api/auth/oauth2/authorize${method === "GET" ? `?${query}` : ""}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    ...(method === "POST" ? { body: query } : {}),
  });
}

async function consent(flow: Flow, oauthQuery = flow.oauthQuery) {
  return app.request(`${ORIGIN}/api/auth/oauth2/consent`, {
    method: "POST",
    headers: { cookie: flow.cookie, "content-type": "application/json" },
    body: JSON.stringify({ accept: true, oauth_query: oauthQuery }),
  });
}
async function code(flow: Flow) {
  const response = await consent(flow);
  expect(response.status, await response.clone().text()).toBe(200);
  const { url } = (await response.json()) as { url: string };
  const callback = new URL(url);
  expect(callback.searchParams.get("state")).toBe(flow.query.get("state"));
  return callback.searchParams.get("code")!;
}
function exchange(
  flow: Flow,
  code: string,
  verifier = flow.verifier,
  resource = `${ORIGIN}/api/mcp`,
) {
  return app.request(`${ORIGIN}/api/auth/mcp/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: flow.clientId,
      code,
      code_verifier: verifier,
      redirect_uri: "https://client.example/callback",
      resource,
    }),
  });
}
async function tokens(flow: Flow) {
  const response = await exchange(flow, await code(flow));
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json() as Promise<{
    access_token: string;
    refresh_token: string;
    id_token: string;
  }>;
}
function refresh(flow: Flow, refreshToken: string) {
  return app.request(`${ORIGIN}/api/auth/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: flow.clientId,
      refresh_token: refreshToken,
      resource: `${ORIGIN}/api/mcp`,
    }),
  });
}

describe("Better Auth 1.7 MCP compatibility and grant boundaries", () => {
  it("does not register an untrusted forwarded host on an unauthenticated request", async () => {
    await auth.$context;
    const configured = env.OPENSHIP_PUBLIC_URL;
    const advertised = env.OPENSHIP_ADVERTISED_ORIGIN;
    try {
      env.OPENSHIP_PUBLIC_URL = "";
      env.OPENSHIP_ADVERTISED_ORIGIN = "";
      const response = await app.request(`${ORIGIN}/api/auth/oauth2/userinfo`, {
        headers: {
          "x-forwarded-host": "untrusted.example.test",
          "x-forwarded-proto": "https",
        },
      });
      expect(response.ok).toBe(false);
      expect(
        await db
          .select({ identifier: schema.oauthResource.identifier })
          .from(schema.oauthResource)
          .where(eq(schema.oauthResource.identifier, "https://untrusted.example.test/api/mcp")),
      ).toEqual([]);
    } finally {
      env.OPENSHIP_PUBLIC_URL = configured;
      env.OPENSHIP_ADVERTISED_ORIGIN = advertised;
    }
  });

  it.each(["GET", "POST"])(
    "preserves %s authorization parameters and requires consent for returning clients",
    async (method) => {
      const flow = await prepare();
      await tokens(flow); // The provider already remembers this client's consent.
      const query = new URLSearchParams(flow.query);
      query.delete("prompt");
      query.delete("resource");
      const response = await authorize(query, flow.cookie, method);
      expect(response.status, await response.clone().text()).toBe(302);
      const destination = new URL(response.headers.get("location")!);
      expect(destination.pathname).toBe("/mcp/authorize");
      for (const key of [
        "client_id",
        "state",
        "code_challenge",
        "code_challenge_method",
        "redirect_uri",
      ]) {
        expect(destination.searchParams.get(key), key).toBe(query.get(key));
      }
      expect(destination.searchParams.get("sig")).toBeTruthy();
      expect(destination.searchParams.get("resource")).toBe(`${ORIGIN}/api/mcp`);
      const authorizationCode = await code({
        ...flow,
        oauthQuery: destination.searchParams.toString(),
      });
      expect((await exchange(flow, authorizationCode)).status).toBe(200);
    },
  );

  it.each(["GET", "POST"])(
    "lets the provider return %s prompt=none errors without opening an interaction page",
    async (method) => {
      const flow = await prepare();
      const query = new URLSearchParams(flow.query);
      query.set("prompt", "none");
      query.delete("resource");
      for (const [cookie, error] of [
        [undefined, "login_required"],
        [flow.cookie, "consent_required"],
      ] as const) {
        const response = await authorize(query, cookie, method);
        expect(response.status).toBe(302);
        const destination = new URL(response.headers.get("location")!);
        expect(destination.origin + destination.pathname).toBe("https://client.example/callback");
        expect(destination.searchParams.get("error")).toBe(error);
        expect(destination.searchParams.get("state")).toBe(query.get("state"));
        expect(destination.searchParams.get("iss")).toBe(ORIGIN);
        expect(destination.searchParams.has("code")).toBe(false);
      }
      expect(await repos.oauth.findClientToken(flow.userId, flow.clientId)).toBeUndefined();
    },
  );

  it.each(
    ["GET", "POST"].flatMap((method) =>
      ["none consent", "none login", "", "   ", "unsupported"].map((prompt) => ({
        method,
        prompt,
      })),
    ),
  )(
    "leaves invalid $method prompt $prompt for the provider to reject",
    async ({ method, prompt }) => {
      const flow = await prepare();
      const query = new URLSearchParams(flow.query);
      query.set("prompt", prompt);
      const response = await authorize(query, flow.cookie, method);
      expect(response.status).toBe(302);
      const destination = new URL(response.headers.get("location")!);
      expect(destination.origin + destination.pathname).toBe("https://client.example/callback");
      expect(destination.searchParams.get("error")).toBe("invalid_request");
      expect(destination.searchParams.get("state")).toBe(query.get("state"));
      expect(destination.searchParams.has("code")).toBe(false);
    },
  );

  it("keeps provider consent and Openship permissions independent on a silent authorization", async () => {
    const flow = await prepare();
    await tokens(flow);
    const query = new URLSearchParams(flow.query);
    query.set("prompt", "none");
    const response = await authorize(query, flow.cookie);
    const destination = new URL(response.headers.get("location")!);
    expect(destination.origin + destination.pathname).toBe("https://client.example/callback");
    const authorizationCode = destination.searchParams.get("code");
    expect(authorizationCode).toBeTruthy();
    const issued = await exchange(flow, authorizationCode!);
    expect(issued.status).toBe(200);
    const { access_token } = (await issued.json()) as { access_token: string };
    expect(await resolveBearerIdentity(access_token, new Headers())).toMatchObject({
      userId: flow.userId,
      scoped: true,
      hasBinding: false,
    });
    await repos.oauth.disconnectMcpClient(flow.userId, flow.clientId);
    expect(await resolveBearerIdentity(access_token, new Headers())).toBeNull();
    const disconnected = await authorize(query, flow.cookie);
    expect(new URL(disconnected.headers.get("location")!).searchParams.get("error")).toBe(
      "consent_required",
    );
  });

  it("keeps redirect and resource validation with the provider for prompt=none", async () => {
    const flow = await prepare();
    const query = new URLSearchParams(flow.query);
    query.set("prompt", "none");
    query.set("redirect_uri", "https://untrusted.example/callback");
    const invalidRedirect = await authorize(query, flow.cookie);
    const errorPage = new URL(invalidRedirect.headers.get("location")!);
    expect(errorPage.origin).toBe(ORIGIN);
    expect(errorPage.searchParams.get("error")).toBeTruthy();
    query.set("redirect_uri", flow.query.get("redirect_uri")!);
    query.set("resource", "https://untrusted.example/api/mcp");
    const invalidResource = await authorize(query, flow.cookie);
    const callback = new URL(invalidResource.headers.get("location")!);
    expect(callback.origin + callback.pathname).toBe("https://client.example/callback");
    expect(callback.searchParams.get("error")).toBe("invalid_target");
    expect(callback.searchParams.get("state")).toBe(query.get("state"));
    expect(callback.searchParams.has("code")).toBe(false);
  });

  it("uses provider APIs for a trusted origin change and keeps resource administration off HTTP", async () => {
    const flow = await prepare();
    const configured = env.OPENSHIP_PUBLIC_URL;
    const changedOrigin = "https://verified-domain.example.test";
    try {
      env.OPENSHIP_PUBLIC_URL = changedOrigin;
      const query = new URLSearchParams(flow.query);
      query.set("resource", `${changedOrigin}/api/mcp`);
      const response = await app.request(`${changedOrigin}/api/auth/oauth2/authorize?${query}`, {
        headers: { cookie: flow.cookie },
      });
      expect(response.status, await response.clone().text()).toBe(302);
      const destination = new URL(response.headers.get("location")!);
      expect(destination.searchParams.get("sig")).toBeTruthy();
      const authorizationCode = await code({
        ...flow,
        oauthQuery: destination.searchParams.toString(),
      });
      const issued = await exchange(
        flow,
        authorizationCode,
        flow.verifier,
        `${changedOrigin}/api/mcp`,
      );
      expect(issued.status, await issued.clone().text()).toBe(200);
      const { access_token } = (await issued.json()) as { access_token: string };
      await expect(
        jwtVerify(access_token, createLocalJWKSet(await auth.api.getJwks()), {
          issuer: changedOrigin,
          audience: `${changedOrigin}/api/mcp`,
        }),
      ).resolves.toBeTruthy();

      // A later read cannot overwrite an operator's disabled resource policy.
      await db
        .update(schema.oauthResource)
        .set({ disabled: true })
        .where(eq(schema.oauthResource.identifier, `${changedOrigin}/api/mcp`));
      const rejected = await app.request(`${changedOrigin}/api/auth/oauth2/authorize?${query}`, {
        headers: { cookie: flow.cookie },
      });
      expect(rejected.status).toBe(302);
      expect(new URL(rejected.headers.get("location")!).searchParams.get("error")).toBe(
        "invalid_target",
      );

      const admin = await app.request(`${changedOrigin}/api/auth/admin/oauth2/resources`, {
        method: "POST",
        headers: { cookie: flow.cookie, "content-type": "application/json" },
        body: JSON.stringify({ identifier: "https://untrusted.example.test/api/mcp" }),
      });
      expect(admin.status).toBe(404);
    } finally {
      env.OPENSHIP_PUBLIC_URL = configured;
    }
  });

  it("preserves the signed grant through password login before showing consent", async () => {
    const flow = await prepare();
    const user = await repos.user.findById(flow.userId);
    const password = "mcp-login-regression-password";
    await db.insert(schema.account).values({
      id: randomUUID(),
      userId: flow.userId,
      accountId: flow.userId,
      providerId: "credential",
      password: await (await auth.$context).password.hash(password),
    });
    const anonymous = await app.request(`${ORIGIN}/api/auth/oauth2/authorize?${flow.query}`);
    const loginUrl = new URL(anonymous.headers.get("location")!);
    const login = await app.request(`${ORIGIN}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: user!.email,
        password,
        oauth_query: loginUrl.searchParams.toString(),
      }),
    });
    expect(login.status, await login.clone().text()).toBe(200);
    const result = (await login.json()) as { url: string };
    const destination = new URL(result.url);
    expect(destination.pathname).toBe("/mcp/authorize");
    expect(destination.searchParams.get("sig")).toBeTruthy();
    expect(destination.searchParams.get("state")).toBe(flow.query.get("state"));
    expect(destination.searchParams.get("code_challenge")).toBe(flow.query.get("code_challenge"));
  });

  it("advertises reachable provider endpoints and its public signing keys", async () => {
    const response = await oauthProviderAuthServerMetadata(auth)(
      new Request(`${ORIGIN}/.well-known/oauth-authorization-server`),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/api/auth/oauth2/authorize`,
      token_endpoint: `${ORIGIN}/api/auth/oauth2/token`,
      registration_endpoint: `${ORIGIN}/api/auth/oauth2/register`,
      jwks_uri: `${ORIGIN}/api/auth/jwks`,
    });
  });

  it("authenticates a confidential client with the legacy SHA-256 secret format", async () => {
    const flow = await prepare();
    const secret = "legacy-client-secret-for-migration-test";
    await db
      .update(schema.oauthClient)
      .set({
        tokenEndpointAuthMethod: "client_secret_basic",
        clientSecret: createHash("sha256").update(secret).digest("base64url"),
      })
      .where(eq(schema.oauthClient.clientId, flow.clientId));
    const response = await app.request(`${ORIGIN}/api/auth/oauth2/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(`${flow.clientId}:${secret}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: await code(flow),
        code_verifier: flow.verifier,
        redirect_uri: "https://client.example/callback",
        resource: `${ORIGIN}/api/mcp`,
      }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await repos.oauth.findClientToken(flow.userId, flow.clientId)).toBeTruthy();
  });

  it("registers older loopback clients without weakening explicit web redirect validation", async () => {
    const body = {
      client_name: "Desktop MCP",
      redirect_uris: ["http://localhost:4333/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    };
    const register = (input: object) =>
      app.request(`${ORIGIN}/api/auth/mcp/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
    expect((await register(body)).status).toBe(201);
    expect((await register({ ...body, application_type: "web" })).status).toBe(400);
    expect(
      (await register({ ...body, redirect_uris: ["http://untrusted.example/callback"] })).status,
    ).toBe(400);
  });

  it("serves verifiable JWTs through legacy URLs, keeps credentials encrypted, and requires the Openship binding", async () => {
    const flow = await prepare(),
      issued = await tokens(flow);
    const jwks = await (await app.request(`${ORIGIN}/api/auth/mcp/jwks`)).json();
    const keys = createLocalJWKSet(jwks as Parameters<typeof createLocalJWKSet>[0]);
    const access = await jwtVerify(issued.access_token, keys, {
      issuer: ORIGIN,
      audience: `${ORIGIN}/api/mcp`,
      algorithms: ["RS256"],
    });
    const userInfo = await app.request(`${ORIGIN}/api/auth/mcp/userinfo`, {
      headers: { authorization: `Bearer ${issued.access_token}` },
    });
    expect(userInfo.status, await userInfo.clone().text()).toBe(200);
    expect(await userInfo.json()).toMatchObject({ sub: flow.userId, email_verified: true });
    expect(access.payload).toMatchObject({
      sub: flow.userId,
      client_id: flow.clientId,
      sid: flow.sessionId,
    });
    expect(
      (await jwtVerify(issued.id_token, keys, { issuer: ORIGIN, audience: flow.clientId })).payload
        .sub,
    ).toBe(flow.userId);
    expect(await resolveBearerIdentity(issued.access_token, new Headers())).toMatchObject({
      userId: flow.userId,
      scoped: true,
      hasBinding: false,
    });
    const grant = await app.request(`${ORIGIN}/api/tokens/mcp-authorize`, {
      method: "POST",
      headers: { cookie: flow.cookie, "content-type": "application/json" },
      body: JSON.stringify({
        clientId: flow.clientId,
        organizationId: flow.organizationId,
        fullAccess: true,
        readOnly: true,
        grants: [],
      }),
    });
    expect(grant.status, await grant.clone().text()).toBe(200);
    expect(await resolveBearerIdentity(issued.access_token, new Headers())).toMatchObject({
      hasBinding: true,
      readOnly: true,
      organizationId: flow.organizationId,
    });
    const [receipt] = await db
      .select()
      .from(schema.mcpOAuthToken)
      .where(eq(schema.mcpOAuthToken.clientId, flow.clientId));
    expect(receipt!.accessTokenEncrypted).not.toContain(issued.access_token);
    expect(receipt!.refreshTokenEncrypted).not.toContain(issued.refresh_token);
    expect((await repos.oauth.findClientToken(flow.userId, flow.clientId))?.accessToken).toBe(
      issued.access_token,
    );
    await repos.oauth.disconnectMcpClient(flow.userId, flow.clientId);
    expect(await resolveBearerIdentity(issued.access_token, new Headers())).toBeNull();
    expect((await refresh(flow, issued.refresh_token)).status).toBe(400);
  });

  it("keeps a signed authorization query on the consent page when the browser needs to log in", async () => {
    const flow = await prepare();
    const response = await app.request(`${ORIGIN}/api/auth/oauth2/authorize?${flow.query}`);
    expect(response.status).toBe(302);
    const destination = new URL(response.headers.get("location")!);
    expect(destination.pathname).toBe("/mcp/authorize");
    expect(destination.searchParams.get("sig")).toBeTruthy();
    expect(destination.searchParams.get("client_id")).toBe(flow.clientId);
    expect(await repos.oauth.findClientToken(flow.userId, flow.clientId)).toBeUndefined();
  });

  it("rejects a modified consent query and a wrong PKCE verifier", async () => {
    const flow = await prepare(),
      tampered = new URLSearchParams(flow.oauthQuery);
    tampered.set("redirect_uri", "https://attacker.example/callback");
    expect((await consent(flow, tampered.toString())).status).toBe(400);
    expect((await exchange(flow, await code(flow), randomUUID() + randomUUID())).status).toBe(400);
    expect(await repos.oauth.findClientToken(flow.userId, flow.clientId)).toBeUndefined();
  });

  it("rejects another resource and invalidates the refresh family when a code is replayed", async () => {
    const flow = await prepare(),
      authorizationCode = await code(flow);
    expect(
      (await exchange(flow, authorizationCode, flow.verifier, "https://attacker.example/mcp"))
        .status,
    ).toBe(400);
    const response = await exchange(flow, authorizationCode);
    expect(response.status).toBe(200);
    const issued = (await response.json()) as { access_token: string; refresh_token: string };
    expect(await repos.oauth.findAccessToken(issued.access_token)).toBeTruthy();
    expect((await exchange(flow, authorizationCode)).status).toBe(400);
    expect(await repos.oauth.findAccessToken(issued.access_token)).toBeNull();
    expect((await refresh(flow, issued.refresh_token)).status).toBe(400);
  });

  it("rotates refresh credentials and rejects tokens after the login session is removed", async () => {
    const flow = await prepare(),
      issued = await tokens(flow);
    const renewed = await refresh(flow, issued.refresh_token);
    expect(renewed.status, await renewed.clone().text()).toBe(200);
    const next = (await renewed.json()) as { access_token: string; refresh_token: string };
    expect(next.refresh_token).not.toBe(issued.refresh_token);
    expect((await repos.oauth.findClientToken(flow.userId, flow.clientId))?.accessToken).toBe(
      next.access_token,
    );
    await db.delete(schema.session).where(eq(schema.session.id, flow.sessionId));
    expect(await repos.oauth.findAccessToken(next.access_token)).toBeNull();
    expect((await refresh(flow, next.refresh_token)).status).toBe(400);
  });
});
