import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("OPENSHIP_TARGET", "local");
  vi.stubEnv("CLOUD_MODE", "false");
  vi.stubEnv("DEPLOY_MODE", "docker");
  vi.stubEnv("INTERNAL_TOKEN", "test-internal-token-0000000000000000000000000000");
  vi.stubEnv("BETTER_AUTH_SECRET", "oidc-boot-test-secret-00000000000000000000000000000000");
  vi.stubEnv("BILLING_ENABLED", "false");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("OIDC issuer boot validation", () => {
  it.each([
    { target: "local", cloudMode: "true" },
    { target: "local-saas", cloudMode: "false" },
    { target: "cloud-saas", cloudMode: "false" },
  ])("ignores self-hosted OIDC configuration on Cloud: %j", async ({ target, cloudMode }) => {
    vi.stubEnv("OPENSHIP_TARGET", target);
    vi.stubEnv("CLOUD_MODE", cloudMode);
    vi.stubEnv("OIDC_ISSUER", "http://user:password@idp.example.com");
    const { selfHostedOidcAllowed } = await import("@repo/platform/engine/config/env");
    expect(selfHostedOidcAllowed).toBe(false);
  });

  it.each([
    "http://idp.example.com",
    "http://localhost:9000",
    "https://user:password@idp.example.com",
    "https://idp.example.com/?tenant=other",
  ])("rejects unsafe issuer %s at boot", async (issuer) => {
    vi.stubEnv("OIDC_ISSUER", issuer);
    await expect(import("@repo/platform/engine/config/env")).rejects.toThrow(
      "OIDC_ISSUER must use HTTPS",
    );
  });

  it.each(["https://idp.example.com"])("accepts %s in production at import", async (issuer) => {
    vi.stubEnv("OIDC_ISSUER", issuer);
    const { env } = await import("@repo/platform/engine/config/env");
    expect(env.NODE_ENV).toBe("production");
    expect(env.OIDC_ISSUER).toBe(issuer);
  });
});

it("allows a loopback IdP for local development", async () => {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("OIDC_ISSUER", "http://localhost:9000");
  const { env } = await import("@repo/platform/engine/config/env");
  expect(env.OIDC_ISSUER).toBe("http://localhost:9000");
});
