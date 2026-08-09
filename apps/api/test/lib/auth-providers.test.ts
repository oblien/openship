import { afterEach, describe, expect, it, vi } from "vitest";

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

vi.mock("../../src/config/env", () => ({
  get env() {
    return env;
  },
}));

async function load() {
  vi.resetModules();
  return import("../../src/lib/auth-providers");
}

afterEach(() => {
  for (const key of Object.keys(env)) delete env[key];
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

  it("never puts a client id or secret in the advertised payload", async () => {
    env.GITHUB_CLIENT_ID = "Iv1.SECRET-CLIENT-ID";
    env.GITHUB_CLIENT_SECRET = "SECRET-CLIENT-SECRET";
    env.GOOGLE_CLIENT_ID = "google-SECRET-CLIENT-ID";
    env.GOOGLE_CLIENT_SECRET = "google-SECRET-CLIENT-SECRET";

    const { configuredAuthProviders } = await load();
    const serialized = JSON.stringify(configuredAuthProviders());

    for (const value of Object.values(env)) {
      expect(serialized).not.toContain(value);
    }
    // Belt and braces: the only keys are the two documented ones, so a future
    // field can't be added without a test author looking at this assertion.
    expect(Object.keys(configuredAuthProviders()[0]!).sort()).toEqual(["id", "kind"]);
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
