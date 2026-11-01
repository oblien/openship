import { createHash, createHmac, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// Real HTTP adapters, Better Auth, authorization, engine and migrated database.
// Only GitHub's network boundary is replaced, so no customer grants are changed.
vi.mock("@repo/platform/engine/config/env", async (original) => {
  const config = await original<typeof import("@repo/platform/engine/config/env")>();
  const { generateKeyPairSync } = await import("node:crypto");
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    ...config,
    env: {
      ...config.env,
      CLOUD_MODE: true,
      GITHUB_AUTH_MODE: "auto",
      GITHUB_APP_ID: "9",
      GITHUB_CLIENT_ID: "test-repository-app",
      GITHUB_CLIENT_SECRET: "test-provider-secret",
      GITHUB_PRIVATE_KEY: key.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    },
    cloudRuntimeTarget: { api: "https://api.openship.test" },
    runtimeTarget: {
      ...config.runtimeTarget,
      api: "https://api.openship.test",
      dashboard: "https://app.openship.test",
    },
    localDashboardUrl: "https://app.openship.test",
  };
});

import {
  db,
  repos,
  schema,
  seedOwner,
  installFakeRunner,
  type SeededOwner,
} from "../jobs/_harness";
import { eq, and } from "@repo/db";
import { env } from "@repo/platform/engine/config/env";
import { auth } from "@repo/platform/engine/lib/auth";
import { encrypt, decrypt } from "@repo/platform/engine/lib/encryption";
import { buildBackgroundContext } from "@repo/platform/engine/lib/background-context";
import { tokenFor } from "@repo/platform/engine/modules/github/github.token";
import { getUserToken } from "@repo/platform/engine/modules/github/github.auth";
import {
  getRepositoryAuthorizationToken,
  disconnectRepositoryAuthorization,
  repositoryOAuthCookieName,
  REPOSITORY_OAUTH_CALLBACK_PATH,
} from "@repo/platform/engine/modules/github/github-repository-authorization";
import {
  oauthBridgeStore,
  startGithubLinkFromBridgeToken,
} from "@repo/platform/engine/modules/cloud/cloud-github.service";
import { OpenshipClient } from "@repo/sdk/client";
import { githubRoutes } from "../../../src/modules/github/github.routes";
import { authRoutes } from "../../../src/modules/auth/auth.routes";
import { healthRoutes } from "../../../src/modules/health/health.routes";
import { githubInstallCallback, githubOauthHandoff, account } from "../../../src/modules/cloud/cloud-saas.controller";
import { authMiddleware } from "../../../src/middleware/auth";
import { connect, claimInstallation, pollConnect } from "@repo/platform/engine/modules/github/github-application.service";
import { cloudGitHubConnection } from "@repo/platform/engine/modules/github/github-cloud-connection";
import { handleApiError } from "../../../src/middleware/error-handler";

installFakeRunner();
const app = new Hono()
  .onError(handleApiError)
  // app.ts normally attaches the trusted proxy address before route limiters.
  .use(async (c, next) => {
    c.set("clientIp", "203.0.113.7");
    await next();
  })
  .route("/api/github", githubRoutes)
  .route("/api/auth", authRoutes)
  .route("/api/health", healthRoutes)
  .get("/api/cloud/github/install-callback", githubInstallCallback)
  .post("/api/cloud/github/oauth-handoff", authMiddleware, githubOauthHandoff)
  .get("/api/cloud/account", authMiddleware, account);
const apiOrigin = "https://api.openship.test";
const installation = {
  id: 42,
  app_id: 9,
  account: { id: 700, login: "Acme", type: "Organization", avatar_url: "" },
  target_type: "Organization",
  permissions: {},
  events: [],
  suspended_at: null,
};
const repository = {
  id: 100,
  name: "private-app",
  full_name: "Acme/private-app",
  owner: installation.account,
  private: true,
  visibility: "private",
  default_branch: "main",
  description: "Private app",
  language: "TypeScript",
  html_url: "https://github.com/Acme/private-app",
  clone_url: "https://github.com/Acme/private-app.git",
  stargazers_count: 0,
  forks: 0,
  watchers: 0,
  size: 1,
  license: null,
  updated_at: "2026-09-29T00:00:00Z",
  created_at: "2026-09-29T00:00:00Z",
  pushed_at: "2026-09-29T00:00:00Z",
};
let external: ReturnType<typeof vi.fn<typeof fetch>>;
let exchanges: URLSearchParams[];
let refreshResponse: () => Response | Promise<Response>;
let exchangeResponse: (code: string) => Response | Promise<Response>;
let available: (typeof installation)[];

beforeEach(() => {
  exchanges = [];
  available = [installation];
  refreshResponse = () =>
    Response.json({
      access_token: "repository-refreshed",
      refresh_token: "refresh-rotated",
      expires_in: 28800,
    });
  exchangeResponse = (code) =>
    Response.json({
      access_token: `repository-${code}`,
      refresh_token: `refresh-${code}`,
      expires_in: 28800,
      refresh_token_expires_in: 15811200,
    });
  external = vi.fn(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === apiOrigin) {
      const previous = env.CLOUD_MODE;
      env.CLOUD_MODE = true;
      try { return await app.request(request); } finally { env.CLOUD_MODE = previous; }
    }
    if (url.origin === "https://github.com" && url.pathname === "/login/oauth/access_token") {
      const fields = new URLSearchParams(await request.text());
      exchanges.push(fields);
      expect(fields.get("client_id")).toBe("test-repository-app");
      expect(fields.get("client_secret")).toBe("test-provider-secret");
      if (fields.get("grant_type") === "refresh_token") return refreshResponse();
      return exchangeResponse(fields.get("code")!);
    }
    if (url.origin !== "https://api.github.com")
      throw new Error(`Unexpected external request: ${url.origin}${url.pathname}`);
    expect(request.headers.get("authorization")).toMatch(/^Bearer /);
    if (url.pathname === "/user")
      return Response.json({ id: 77, login: "shared-github-user", avatar_url: "" });
    if (url.pathname === "/user/installations")
      return Response.json({ total_count: available.length, installations: available });
    if (url.pathname === "/app/installations/42") return Response.json(installation);
    if (url.pathname === "/app/installations/42/access_tokens")
      return Response.json({
        token: "installation-token",
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      });
    if (
      url.pathname === "/installation/repositories" ||
      url.pathname === "/user/installations/42/repositories"
    ) {
      return Response.json({ total_count: 1, repositories: [repository] });
    }
    if (url.pathname === "/repos/Acme/private-app" || url.pathname === "/repos/acme/private-app")
      return Response.json(repository);
    throw new Error(`Unexpected GitHub request: ${url.pathname}`);
  });
  vi.stubGlobal("fetch", external);
});
afterEach(() => vi.unstubAllGlobals());

async function actor() {
  const owner = await seedOwner();
  const id = randomUUID();
  const token = randomUUID();
  await db.insert(schema.session).values({
    id,
    token,
    userId: owner.userId,
    activeOrganizationId: owner.orgId,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const authContext = await auth.$context;
  const signature = createHmac("sha256", env.BETTER_AUTH_SECRET).update(token).digest("base64");
  const cookie = `${authContext.authCookies.sessionToken.name}=${encodeURIComponent(`${token}.${signature}`)}`;
  const client = new OpenshipClient({
    baseUrl: apiOrigin,
    token: owner.token,
    organizationId: owner.orgId,
    fetch: ((url, init) => app.request(url as string, init)) as typeof fetch,
  });
  return { ...owner, sessionId: id, sessionToken: token, cookie, client };
}
type Actor = Awaited<ReturnType<typeof actor>>;

async function start(owner: Actor) {
  const response = await owner.client.github.connect({ source: "oauth" });
  if (response.connected || response.flow !== "redirect" || !response.url || !response.state)
    throw new Error("Expected repository OAuth redirect");
  expect(response.completion).toBe("attempt");
  const started = await app.request(response.url, { headers: { cookie: owner.cookie } });
  expect(started.status, await started.clone().text()).toBe(302);
  const location = new URL(started.headers.get("location")!);
  expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
  expect(location.searchParams.get("redirect_uri")).toBe(
    `${apiOrigin}${REPOSITORY_OAUTH_CALLBACK_PATH}`,
  );
  expect(location.searchParams.get("state")).toBe(response.state);
  expect(location.searchParams.get("code_challenge_method")).toBe("S256");
  const cookie = started.headers.get("set-cookie")!;
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("SameSite=Lax");
  expect(cookie).toContain("Secure");
  expect(cookie).not.toContain("session_token");
  const binding = await repos.githubInstallState.find(response.state);
  expect(binding?.payload.codeVerifierEncrypted).not.toBeNull();
  const verifier = decrypt(binding!.payload.codeVerifierEncrypted!);
  expect(createHash("sha256").update(verifier).digest("base64url")).toBe(
    location.searchParams.get("code_challenge"),
  );
  expect(started.headers.get("cache-control")).toBe("no-store");
  expect(started.headers.get("referrer-policy")).toBe("no-referrer");
  return { state: response.state, cookie: cookie.split(";")[0]!, verifier };
}
type Attempt = Awaited<ReturnType<typeof start>>;

async function callback(attempt: Attempt, code = randomUUID(), extra: Record<string, string> = {}) {
  return app.request(
    `${apiOrigin}${REPOSITORY_OAUTH_CALLBACK_PATH}?${new URLSearchParams({ state: attempt.state, code, ...extra })}`,
    { headers: { cookie: attempt.cookie } },
  );
}
async function authorize(owner: Actor) {
  const attempt = await start(owner);
  const code = randomUUID();
  const completed = await callback(attempt, code);
  expect(completed.status).toBe(302);
  expect(completed.headers.get("location")).toBe(
    `https://app.openship.test/auth/callback/install?state=${attempt.state}`,
  );
  expect(exchanges.at(-1)?.get("code_verifier")).toBe(attempt.verifier);
  expect(exchanges.at(-1)?.get("redirect_uri")).toBe(
    `${apiOrigin}${REPOSITORY_OAUTH_CALLBACK_PATH}`,
  );
  expect(await owner.client.github.pollConnect({ state: attempt.state })).toEqual({
    status: "waiting",
  });
  const binding = await repos.githubInstallState.find(attempt.state);
  expect(binding?.payload).toEqual({ sessionId: owner.sessionId });
  return { ...attempt, code };
}
async function selection(owner: Actor, state: string) {
  const response = await owner.client.github.connect({ source: "oauth", state });
  if (response.connected || response.flow !== "installations")
    throw new Error("Expected installation selection");
  return response;
}
function claim(owner: Actor, state: string, installationId = "42") {
  return owner.client.github.claimInstallation({ state, installationId });
}

describe("Cloud repository authorization from browser callback through library and clone", () => {
  it("lets two Openship accounts connect the same GitHub identity without transferring either login", async () => {
    const first = await actor();
    const second = await actor();
    await db
      .insert(schema.account)
      .values({ id: randomUUID(), providerId: "github", accountId: "77", userId: first.userId });
    const before = await db.query.account.findMany({ where: eq(schema.account.accountId, "77") });
    await repos.settings.upsert({ id: randomUUID(), userId: first.userId, buildMode: "local" });
    for (const owner of [first, second]) {
      const attempt = await authorize(owner);
      expect(await selection(owner, attempt.state)).toMatchObject({
        installations: [{ id: 42, login: "Acme", connected: false }],
      });
      expect(await claim(owner, attempt.state)).toMatchObject({
        ok: true,
        installation: { id: 42 },
      });
      expect(await owner.client.github.pollConnect({ state: attempt.state })).toEqual({
        status: "complete",
      });
      expect(await repos.gitInstallation.listByOrganization(owner.orgId)).toMatchObject([
        { installationId: 42, userId: owner.userId },
      ]);
      const home = await owner.client.github.getHome();
      expect(home.accounts).toMatchObject([{ login: "acme" }]);
      expect(home.repos).toMatchObject([{ full_name: "Acme/private-app" }]);
      const ctx = buildBackgroundContext({
        userId: owner.userId,
        organizationId: owner.orgId,
        role: "owner",
      });
      expect(await tokenFor(ctx, "remote", { owner: "acme", repo: "private-app" })).toMatchObject({
        token: "installation-token",
        source: "app-installation",
      });
      const settings = await repos.settings.findByUser(owner.userId);
      expect(settings!.githubAuthorizationEncrypted).not.toContain(`repository-${attempt.code}`);
      expect(await getUserToken(owner.userId)).toBe(`repository-${attempt.code}`);
    }
    expect((await repos.settings.findByUser(first.userId))?.buildMode).toBe("local");
    expect(await db.query.account.findMany({ where: eq(schema.account.accountId, "77") })).toEqual(
      before,
    );
    const session = await app.request(`${apiOrigin}/api/auth/get-session`, {
      headers: { cookie: first.cookie },
    });
    expect((await session.json()).user.id).toBe(first.userId);
    const unaffiliated = await actor();
    expect(
      (await unaffiliated.client.github.getStatus({ includeInstallUrl: false })).accounts,
    ).toEqual([]);
  });

  it("rejects another browser or account without consuming the initiating user's attempt", async () => {
    const owner = await actor();
    const other = await actor();
    const attempt = await start(owner);
    const denied = await callback({
      ...attempt,
      cookie: `${repositoryOAuthCookieName(attempt.state)}=wrong-browser`,
    });
    expect(denied.headers.get("location")).toContain("/auth/callback/close?error=");
    expect(exchanges).toHaveLength(0);
    expect((await repos.githubInstallState.find(attempt.state))?.flow).toBe("repository-oauth");
    expect(await other.client.github.pollConnect({ state: attempt.state })).toMatchObject({
      status: "error",
    });
    await expect(claim(other, attempt.state)).rejects.toThrow();
    expect((await callback(attempt)).headers.get("location")).toContain("/auth/callback/install?");
  });

  it.each(["expired", "logged-out", "removed", "permission-revoked"])(
    "stops authorization after the initiating access becomes %s",
    async (reason) => {
      const owner = await actor();
      const attempt = await start(owner);
      if (reason === "expired")
        await db
          .update(schema.session)
          .set({ expiresAt: new Date(0) })
          .where(eq(schema.session.id, owner.sessionId));
      if (reason === "logged-out")
        await db.delete(schema.session).where(eq(schema.session.id, owner.sessionId));
      if (reason === "removed")
        await db
          .delete(schema.member)
          .where(
            and(
              eq(schema.member.userId, owner.userId),
              eq(schema.member.organizationId, owner.orgId),
            ),
          );
      if (reason === "permission-revoked")
        await db
          .update(schema.member)
          .set({ role: "restricted" })
          .where(eq(schema.member.userId, owner.userId));
      expect((await callback(attempt)).headers.get("location")).toContain(
        "/auth/callback/close?error=",
      );
      expect(exchanges).toHaveLength(0);
      expect(
        (await repos.settings.findByUser(owner.userId))?.githubAuthorizationEncrypted,
      ).toBeFalsy();
      expect(
        await repos.githubInstallState.progress(attempt.state, owner.userId, owner.orgId),
      ).toMatchObject({ status: "failed" });
    },
  );

  it("also checks the issuing session at installation completion", async () => {
    const owner = await actor();
    const attempt = await authorize(owner);
    const selectionUrl = `${apiOrigin}/api/cloud/github/install-callback?${new URLSearchParams({ state: attempt.state, flow: "select" })}`;
    const selection = await app.request(selectionUrl);
    expect(selection.status).toBe(200);
    expect(await selection.text()).toContain("Acme");
    await db.delete(schema.session).where(eq(schema.session.id, owner.sessionId));
    expect((await app.request(selectionUrl)).status).toBe(403);
    const response = await app.request(
      `${apiOrigin}/api/cloud/github/install-callback?${new URLSearchParams({ state: attempt.state, installation_id: "42", setup_action: "install" })}`,
    );
    expect(response.status).toBe(403);
    expect(await repos.gitInstallation.listByOrganization(owner.orgId)).toEqual([]);
  });

  it("completes repository authorization through the public picker without a Cloud session cookie", async () => {
    const owner = await actor();
    const attempt = await authorize(owner);
    const page = await app.request(
      `${apiOrigin}/api/cloud/github/install-callback?${new URLSearchParams({ state: attempt.state, flow: "select" })}`,
    );
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain(`name="state" value="${attempt.state}"`);
    expect(html).toContain('name="installation_id" value="42"');
    expect(page.headers.get("set-cookie")).toBeNull();
    const selected = await app.request(
      `${apiOrigin}/api/cloud/github/install-callback?${new URLSearchParams({ state: attempt.state, installation_id: "42", setup_action: "update" })}`,
    );
    expect(selected.status).toBe(200);
    expect(await owner.client.github.pollConnect({ state: attempt.state })).toEqual({
      status: "complete",
    });
    expect((await owner.client.github.getHome()).repos).toMatchObject([
      { full_name: "Acme/private-app" },
    ]);
  });

  it("completes OAuth and an installation claim once when callbacks race", async () => {
    const owner = await actor();
    const attempt = await start(owner);
    const replies = await Promise.all([
      callback(attempt, "same-code"),
      callback(attempt, "same-code"),
    ]);
    expect(
      replies.filter((response) =>
        response.headers.get("location")?.includes("/auth/callback/install?"),
      ),
    ).toHaveLength(1);
    expect(exchanges).toHaveLength(1);
    const claims = await Promise.allSettled([
      claim(owner, attempt.state),
      claim(owner, attempt.state),
    ]);
    expect(claims.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await repos.gitInstallation.listByOrganization(owner.orgId)).toHaveLength(1);
    expect(await owner.client.github.pollConnect({ state: attempt.state })).toEqual({
      status: "complete",
    });
  });

  it("reports organization approval requests that have no installation id yet", async () => {
    const owner = await actor();
    const attempt = await authorize(owner);
    const response = await app.request(
      `${apiOrigin}/api/cloud/github/install-callback?${new URLSearchParams({ state: attempt.state, setup_action: "request" })}`,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Installation requested");
    expect(await owner.client.github.pollConnect({ state: attempt.state })).toMatchObject({
      status: "error",
      error: expect.stringContaining("approve"),
    });
    expect(await repos.gitInstallation.listByOrganization(owner.orgId)).toEqual([]);
  });

  it("filters other Apps and suspended installations, and refuses a spoofed claim", async () => {
    const owner = await actor();
    const attempt = await authorize(owner);
    available = [
      installation,
      { ...installation, id: 43, app_id: 10 },
      {
        ...installation,
        id: 44,
        suspended_at: "2026-09-29T00:00:00Z",
      } as unknown as typeof installation,
    ];
    expect((await selection(owner, attempt.state)).installations.map((entry) => entry.id)).toEqual([
      42,
    ]);
    await expect(claim(owner, attempt.state, "999")).rejects.toThrow();
    expect(await repos.gitInstallation.listByOrganization(owner.orgId)).toEqual([]);
    expect(await claim(owner, attempt.state)).toMatchObject({ ok: true });
  });

  it.each(["cancelled", "provider-error"])(
    "surfaces %s without overwriting a saved personal credential",
    async (reason) => {
      const owner = await actor();
      await repos.settings.upsert({
        id: randomUUID(),
        userId: owner.userId,
        cloneTokenEncrypted: encrypt("existing-personal-token"),
      });
      const attempt = await start(owner);
      exchangeResponse = () => Response.json({ error: "temporarily_unavailable" }, { status: 503 });
      const response = await callback(
        attempt,
        "code",
        reason === "cancelled" ? { error: "access_denied" } : {},
      );
      expect(response.headers.get("location")).toContain("/auth/callback/close?error=");
      expect(await owner.client.github.pollConnect({ state: attempt.state })).toMatchObject({
        status: "error",
        error: expect.stringMatching(/cancelled|could not complete/),
      });
      expect(decrypt((await repos.settings.findByUser(owner.userId))!.cloneTokenEncrypted!)).toBe(
        "existing-personal-token",
      );
      expect(await getRepositoryAuthorizationToken(owner.userId)).toBeUndefined();
    },
  );

  it("does not turn ordinary Better Auth callbacks into repository grants", async () => {
    const response = await app.request(
      `${apiOrigin}${REPOSITORY_OAUTH_CALLBACK_PATH}?state=ordinary-login-state&code=not-a-grant`,
    );
    expect(response.headers.get("location") ?? "").not.toContain("/auth/callback/install");
    expect(exchanges).toHaveLength(0);
  });

  it("uses the same authorization for the desktop bridge without issuing a Cloud session cookie", async () => {
    const owner = await actor();
    const bridge = await oauthBridgeStore.issue(
      { userId: owner.userId, organizationId: owner.orgId, sessionToken: owner.sessionToken },
      { ttlMs: 60000 },
    );
    const result = await startGithubLinkFromBridgeToken(bridge);
    if (result.kind !== "redirect") throw new Error(`Bridge failed: ${result.kind}`);
    expect(result.forwardCookies).toHaveLength(1);
    expect(result.forwardCookies[0]).not.toContain("session_token");
    const state = new URL(result.url).searchParams.get("state")!;
    const response = await callback({
      state,
      cookie: result.forwardCookies[0]!.split(";")[0]!,
      verifier: "",
    });
    const next = response.headers.get("location")!;
    expect(next).toBe(`${apiOrigin}/api/cloud/github/install-callback?${new URLSearchParams({ flow: "select", state })}`);
    const picker = await app.request(next);
    expect(picker.status).toBe(200);
    expect(await picker.text()).toContain('name="installation_id" value="42"');
    expect((await repos.githubInstallState.find(state))?.flow).toBe("install");
    expect(await owner.client.github.pollConnect({ state })).toEqual({ status: "waiting" });
    await claim(owner, state);
    expect(await owner.client.github.pollConnect({ state })).toEqual({ status: "complete" });
    expect(await startGithubLinkFromBridgeToken(bridge)).toEqual({ kind: "expired" });
  });
});

async function expiredGrant(owner: SeededOwner) {
  const encrypted = encrypt(
    JSON.stringify({
      accessToken: "expired-access",
      refreshToken: "refresh-old",
      accessExpiresAt: Date.now() - 1000,
      refreshExpiresAt: Date.now() + 86400_000,
    }),
  );
  await repos.settings.setGitHubAuthorization(owner.userId, encrypted);
  return encrypted;
}

describe("repository grant refresh and disconnect", () => {
  it("serializes rotating refresh tokens and preserves unrelated settings", async () => {
    const owner = await actor();
    await expiredGrant(owner);
    await repos.settings.update(owner.userId, { buildMode: "local" });
    expect(await Promise.all(Array.from({ length: 6 }, () => getUserToken(owner.userId)))).toEqual(
      Array(6).fill("repository-refreshed"),
    );
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]?.get("refresh_token")).toBe("refresh-old");
    expect((await repos.settings.findByUser(owner.userId))?.buildMode).toBe("local");
  });

  it("keeps the grant on provider outage, but refuses a revoked refresh token", async () => {
    const owner = await actor();
    const before = await expiredGrant(owner);
    refreshResponse = () => Response.json({ error: "temporarily_unavailable" }, { status: 503 });
    await expect(getUserToken(owner.userId)).rejects.toThrow("could not complete");
    expect((await repos.settings.findByUser(owner.userId))?.githubAuthorizationEncrypted).toBe(
      before,
    );
    refreshResponse = () => Response.json({ error: "bad_refresh_token" });
    expect(await getUserToken(owner.userId)).toBeNull();
    expect(
      decrypt((await repos.settings.findByUser(owner.userId))!.githubAuthorizationEncrypted!),
    ).toBe('{"disconnected":true}');
  });

  it("does not let an in-flight refresh resurrect access after disconnect", async () => {
    const owner = await actor();
    await expiredGrant(owner);
    let release!: (response: Response) => void;
    refreshResponse = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const refreshing = getUserToken(owner.userId);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const disconnecting = disconnectRepositoryAuthorization(owner.userId);
    release(Response.json({ access_token: "late-refresh", expires_in: 28800 }));
    await refreshing;
    await disconnecting;
    expect(await getUserToken(owner.userId)).toBeNull();
  });

  it("cancels pending callbacks on disconnect while preserving the GitHub login and token alternative", async () => {
    const owner = await actor();
    await db
      .insert(schema.account)
      .values({ id: randomUUID(), providerId: "github", accountId: "77", userId: owner.userId });
    const attempt = await start(owner);
    await repos.settings.upsert({
      id: randomUUID(),
      userId: owner.userId,
      cloneTokenEncrypted: encrypt("personal-token"),
    });
    await owner.client.github.disconnect({ source: "oauth" });
    expect((await callback(attempt)).headers.get("location")).toContain(
      "/auth/callback/close?error=",
    );
    expect(exchanges).toHaveLength(0);
    expect(
      await db.query.account.findFirst({ where: eq(schema.account.userId, owner.userId) }),
    ).toMatchObject({ providerId: "github", accountId: "77" });
    expect(decrypt((await repos.settings.findByUser(owner.userId))!.cloneTokenEncrypted!)).toBe(
      "personal-token",
    );
    expect(await getUserToken(owner.userId)).toBeNull();
    expect((await start(owner)).state).not.toBe(attempt.state);
  });
});


describe("self-hosted hosted-App connection over the real Cloud transport", () => {
  async function selfHosted<T>(call: () => Promise<T>): Promise<T> {
    env.CLOUD_MODE = false;
    try { return await call(); } finally { env.CLOUD_MODE = true; }
  }
  async function linked(owner: Actor) {
    const local = await seedOwner();
    await repos.settings.upsert({ id: randomUUID(), userId: local.userId });
    await repos.settings.setCloudSession(local.userId, encrypt(JSON.stringify({
      token: owner.sessionToken, apiUrl: apiOrigin, userId: owner.userId, organizationId: owner.orgId,
    })));
    return buildBackgroundContext({ userId: local.userId, organizationId: local.orgId, role: "owner" });
  }

  it("keeps one Cloud attempt through OAuth, existing-install selection, claim and polling, without local rows", async () => {
    const owner = await actor();
    const local = await linked(owner);
    const started = await selfHosted(() => connect(local, { source: "oauth" }));
    if (started.connected || started.flow !== "redirect" || !started.url || !started.state) throw new Error("Expected Cloud OAuth bridge");
    expect(started.completion).toBe("attempt");
    const token = new URL(started.url).searchParams.get("token")!;
    expect(token).toBeTruthy();
    expect(await selfHosted(() => pollConnect(local, { state: started.state }))).toEqual({ status: "waiting" });
    const bridge = await startGithubLinkFromBridgeToken(token);
    if (bridge.kind !== "redirect") throw new Error(`Bridge failed: ${bridge.kind}`);
    expect(new URL(bridge.url).searchParams.get("state")).toBe(started.state);
    const completed = await callback({ state: started.state, cookie: bridge.forwardCookies[0]!.split(";")[0]!, verifier: "" });
    const page = await app.request(completed.headers.get("location")!);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('name="installation_id" value="42"');
    const selected = await selfHosted(() => connect(local, { source: "oauth", state: started.state }));
    expect(selected).toMatchObject({ flow: "installations", state: started.state, installations: [{ id: 42 }] });
    expect(await selfHosted(() => claimInstallation(local, { state: started.state!, installationId: 42 }))).toMatchObject({ ok: true });
    expect(await selfHosted(() => pollConnect(local, { state: started.state }))).toEqual({ status: "complete" });
    expect(await repos.gitInstallation.listByOrganization(local.organizationId)).toEqual([]);
    expect(await repos.gitInstallation.listByOrganization(owner.orgId)).toHaveLength(1);
    expect((await owner.client.github.getHome()).repos).toMatchObject([{ full_name: "Acme/private-app", private: true }]);
    await expect(cloudGitHubConnection(local, "claimInstallation", { state: started.state, installationId: 42 })).rejects.toThrow(/expired/);
    expect(await repos.gitInstallation.listByOrganization(owner.orgId)).toHaveLength(1);
  });

  it.each(["{", "null", "[]"])("rejects a malformed OAuth bridge request %s", async body => {
    const owner = await actor();
    const response = await app.request(`${apiOrigin}/api/cloud/github/oauth-handoff`, {
      method: "POST", headers: { authorization: `Bearer ${owner.sessionToken}`, "content-type": "application/json" }, body,
    });
    expect(response.status).toBe(400);
  });

  it("refuses to bridge or claim an attempt bound to another Cloud workspace", async () => {
    const owner = await actor();
    const other = await actor();
    const attempt = await start(other);
    const local = await linked(owner);
    const response = await app.request(`${apiOrigin}/api/cloud/github/oauth-handoff`, {
      method: "POST", headers: { authorization: `Bearer ${owner.sessionToken}`, "content-type": "application/json", "X-Organization-Id": owner.orgId },
      body: JSON.stringify({ state: attempt.state }),
    });
    expect(response.status).toBe(403);
    await expect(cloudGitHubConnection(local, "claimInstallation", { state: attempt.state, installationId: 42 })).rejects.toMatchObject({ statusCode: 403 });
    expect(await repos.githubInstallState.find(attempt.state)).toBeTruthy();
    expect(await repos.gitInstallation.listByOrganization(owner.orgId)).toEqual([]);
    expect(await repos.gitInstallation.listByOrganization(other.orgId)).toEqual([]);
  });
});
