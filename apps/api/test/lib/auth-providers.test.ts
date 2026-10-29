import { afterEach, describe, expect, it, vi } from "vitest";

const diagnosticsWarn = vi.hoisted(() => vi.fn());
const reportCaught = vi.hoisted(() => vi.fn());

vi.mock("@repo/core/diagnostics", () => ({
  diagnostics: { warn: diagnosticsWarn, error: vi.fn() },
  reportCaughtError: reportCaught,
}));

/**
 * Which social logins does this instance actually have credentials for?
 *
 * The dashboard used to answer that question itself, with `!selfHosted` — a
 * proxy that is wrong in both directions (a self-hosted operator WITH GitHub
 * creds got no button; a cloud deploy missing a pair would have got a button
 * that dead-ends). The answer now comes from the server, derived from the same
 * predicate that decides whether Better Auth registers the provider at all.
 *
 * These tests pin the two halves that matter:
 *   1. configured → advertised, not configured → absent (and half-configured
 *      counts as NOT configured — a client id with no secret cannot complete a
 *      redirect flow);
 *   2. the advertised payload carries IDs and nothing else. This list is served
 *      unauthenticated, so a client id leaking into it is a real disclosure, and
 *      it would leak by the most ordinary of edits: returning the config object
 *      the registration path already builds.
 */

const env: Record<string, string | undefined> = {};
const deployment = { selfHostedOidcAllowed: true };

vi.mock("@repo/platform/engine/config/env", () => ({
  get env() {
    return env;
  },
  get selfHostedOidcAllowed() {
    return deployment.selfHostedOidcAllowed;
  },
}));

async function load() {
  vi.resetModules();
  return import("@repo/platform/engine/lib/auth-providers");
}

afterEach(() => {
  for (const key of Object.keys(env)) delete env[key];
  deployment.selfHostedOidcAllowed = true;
  diagnosticsWarn.mockClear();
  reportCaught.mockClear();
  vi.unstubAllGlobals();
});

describe("configuredAuthProviders", () => {
  it("advertises nothing on a default self-hosted instance", async () => {
    const { configuredAuthProviders } = await load();
    // No creds in env — password login only. The dashboard renders no buttons,
    // which is the same thing an operator sees today, just for a true reason.
    expect(configuredAuthProviders()).toEqual([]);
  });

  it("advertises a provider once both halves of its credential pair are set", async () => {
    env.GITHUB_CLIENT_ID = "Iv1.self-hosted-app";
    env.GITHUB_CLIENT_SECRET = "shhh-github";

    const { configuredAuthProviders } = await load();
    // The improvement this whole change exists for: a self-hosted operator who
    // DID configure GitHub now gets the button, where before it was hidden.
    expect(configuredAuthProviders()).toEqual([{ id: "github", kind: "social" }]);
  });

  it("omits a half-configured provider — an id without a secret cannot sign anyone in", async () => {
    env.GITHUB_CLIENT_ID = "Iv1.half-done";
    env.GOOGLE_CLIENT_SECRET = "secret-without-an-id";

    const { configuredAuthProviders } = await load();
    expect(configuredAuthProviders()).toEqual([]);
  });

  it("advertises both, in a stable order, when both are configured (the cloud case)", async () => {
    env.GITHUB_CLIENT_ID = "gh-id";
    env.GITHUB_CLIENT_SECRET = "gh-secret";
    env.GOOGLE_CLIENT_ID = "goog-id";
    env.GOOGLE_CLIENT_SECRET = "goog-secret";

    const { configuredAuthProviders } = await load();
    expect(configuredAuthProviders().map((p) => p.id)).toEqual(["github", "google"]);
  });

  it("advertises oidc with default display name when issuer, client id, and secret are all set", async () => {
    env.OIDC_ISSUER = "https://idp.example.com";
    env.OIDC_CLIENT_ID = "oidc-client";
    env.OIDC_CLIENT_SECRET = "oidc-secret";

    const { configuredAuthProviders } = await load();
    expect(configuredAuthProviders()).toEqual([
      { id: "oidc", kind: "oidc", name: "SSO" },
    ]);
  });

  it("advertises oidc with custom OIDC_DISPLAY_NAME when configured", async () => {
    env.OIDC_ISSUER = "https://idp.example.com";
    env.OIDC_CLIENT_ID = "oidc-client";
    env.OIDC_CLIENT_SECRET = "oidc-secret";
    env.OIDC_DISPLAY_NAME = "  Authentik  ";

    const { configuredAuthProviders } = await load();
    expect(configuredAuthProviders()).toEqual([
      { id: "oidc", kind: "oidc", name: "Authentik" },
    ]);
  });

  it("omits oidc when only a partial set of OIDC env vars is configured", async () => {
    env.OIDC_ISSUER = "https://idp.example.com";
    env.OIDC_CLIENT_ID = "oidc-client";

    const { configuredAuthProviders } = await load();
    expect(configuredAuthProviders()).toEqual([]);
    expect(diagnosticsWarn).toHaveBeenCalledWith(
      "platform/engine/lib/auth-providers",
      expect.stringContaining("OIDC_CLIENT_SECRET"),
    );
  });

  it("never puts a client id or secret in the advertised payload", async () => {
    env.GITHUB_CLIENT_ID = "Iv1.SECRET-CLIENT-ID";
    env.GITHUB_CLIENT_SECRET = "SECRET-CLIENT-SECRET";
    env.GOOGLE_CLIENT_ID = "google-SECRET-CLIENT-ID";
    env.GOOGLE_CLIENT_SECRET = "google-SECRET-CLIENT-SECRET";
    env.OIDC_ISSUER = "https://idp.example.com/secret-tenant";
    env.OIDC_CLIENT_ID = "oidc-SECRET-CLIENT-ID";
    env.OIDC_CLIENT_SECRET = "oidc-SECRET-CLIENT-SECRET";

    const { configuredAuthProviders } = await load();
    const serialized = JSON.stringify(configuredAuthProviders());

    for (const value of Object.values(env)) {
      expect(serialized).not.toContain(value);
    }
    // Belt and braces: the only keys are the documented ones, so a future
    // field can't be added without a test author looking at this assertion.
    expect(Object.keys(configuredAuthProviders()[0]!).sort()).toEqual(["id", "kind"]);
    expect(Object.keys(configuredAuthProviders()[2]!).sort()).toEqual(["id", "kind", "name"]);
  });
});

describe("socialProviderCredentials", () => {
  it("hands the registration path both halves when configured", async () => {
    env.GOOGLE_CLIENT_ID = "goog-id";
    env.GOOGLE_CLIENT_SECRET = "goog-secret";

    const { socialProviderCredentials } = await load();
    expect(socialProviderCredentials("google")).toEqual({
      clientId: "goog-id",
      clientSecret: "goog-secret",
    });
    expect(socialProviderCredentials("github")).toBeNull();
  });
});

describe("oidcProviderConfig", () => {
  it("neither registers nor advertises instance OIDC on Cloud, even with complete credentials", async () => {
    deployment.selfHostedOidcAllowed = false;
    Object.assign(env, {
      OIDC_ISSUER: "https://idp.example.com",
      OIDC_CLIENT_ID: "client",
      OIDC_CLIENT_SECRET: "secret",
      GITHUB_CLIENT_ID: "github-client",
      GITHUB_CLIENT_SECRET: "github-secret",
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { oidcProviderConfig, configuredAuthProviders } = await load();
    expect(oidcProviderConfig()).toBeUndefined();
    expect(configuredAuthProviders()).toEqual([{ id: "github", kind: "social" }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("registers oidc only when issuer, client id, and client secret are all present", async () => {
    env.OIDC_ISSUER = "https://idp.example.com/application/o/openship/";
    env.OIDC_CLIENT_ID = "oidc-client-id";
    env.OIDC_CLIENT_SECRET = "oidc-client-secret";

    const { oidcProviderConfig } = await load();
    const config = oidcProviderConfig();
    expect(config).toBeDefined();
    expect(config).toMatchObject({
      providerId: "oidc",
      issuer: "https://idp.example.com/application/o/openship/",
      clientId: "oidc-client-id",
      clientSecret: "oidc-client-secret",
      scopes: ["openid", "email", "profile"],
      pkce: true,
      displayName: "SSO",
    });
    expect(typeof config?.getUserInfo).toBe("function");
  });

  it("registers nothing and warns once per distinct partial OIDC env", async () => {
    const { oidcProviderConfig } = await load();

    env.OIDC_DISPLAY_NAME = "Okta";
    expect(oidcProviderConfig()).toBeUndefined();
    expect(diagnosticsWarn).not.toHaveBeenCalled();

    env.OIDC_ISSUER = "https://idp.example.com";
    expect(oidcProviderConfig()).toBeUndefined();
    expect(diagnosticsWarn).toHaveBeenCalledTimes(1);
    expect(diagnosticsWarn.mock.calls[0]?.[1]).toContain("OIDC_CLIENT_ID");
    expect(diagnosticsWarn.mock.calls[0]?.[1]).toContain("OIDC_CLIENT_SECRET");
    oidcProviderConfig();
    expect(diagnosticsWarn).toHaveBeenCalledTimes(1);

    delete env.OIDC_ISSUER;
    env.OIDC_CLIENT_ID = "only-id";
    env.OIDC_CLIENT_SECRET = "only-secret";
    expect(oidcProviderConfig()).toBeUndefined();
    expect(diagnosticsWarn).toHaveBeenCalledTimes(2);
    expect(diagnosticsWarn.mock.calls[1]?.[1]).toContain("OIDC_ISSUER");
  });
});

describe("mapOidcProfileToUser", () => {
  it("trusts email_verified only when it is boolean true", async () => {
    const { mapOidcProfileToUser } = await load();

    expect(mapOidcProfileToUser({
      sub: "u1",
      email: "alice@example.test",
      name: "Alice",
      email_verified: true,
    })).toEqual({ name: "Alice", emailVerified: true });

    expect(mapOidcProfileToUser({
      email: "alice@example.test",
      name: "Alice",
      email_verified: false,
      emailVerified: true,
    })).toEqual({ name: "Alice", emailVerified: false });

    expect(mapOidcProfileToUser({
      email: "alice@example.test",
      name: "Alice",
      email_verified: "true",
    })).toEqual({ name: "Alice", emailVerified: false });

    expect(mapOidcProfileToUser({
      email: "alice@example.test",
      emailVerified: true,
    })).toEqual({ name: "alice", emailVerified: false });

    expect(mapOidcProfileToUser({
      email: "alice@example.test",
    })).toEqual({ name: "alice", emailVerified: false });
  });
});

function unsignedJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.`;
}

describe("OIDC configuration and untrusted identities", () => {
  it.each(["http://idp.example.com", "http://127.0.0.1:3000", "https://user:password@idp.example.com", "https://idp.example.com/#fragment", "https://idp.example.com/?tenant=other"])("does not register an unsafe issuer: %s", async (issuer) => {
    Object.assign(env, { OIDC_ISSUER: issuer, OIDC_CLIENT_ID: "client", OIDC_CLIENT_SECRET: "secret", NODE_ENV: "production" });
    const { oidcProviderConfig } = await load();
    expect(oidcProviderConfig()).toBeUndefined();
  });

  it.each([undefined, "not-a-jwt", unsignedJwt({ sub: "u", email: "admin@example.com", email_verified: true })])("does not accept tokens outside a validated OAuth callback", async (idToken) => {
    Object.assign(env, { OIDC_ISSUER: "https://idp.example.com", OIDC_CLIENT_ID: "client", OIDC_CLIENT_SECRET: "secret" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { oidcProviderConfig } = await load();
    expect(await oidcProviderConfig()!.getUserInfo!({ idToken, accessToken: "token" })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
