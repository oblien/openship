import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  env: { CLOUD_MODE: true },
  safeFetch: vi.fn(),
}));

vi.mock("@repo/platform/engine/config/env", () => ({ env: h.env }));
vi.mock("@repo/platform/engine/lib/safe-fetch", () => ({ safeFetch: h.safeFetch }));

import { getCredentialProvider } from "@repo/core";
import { verifyCredentialValues } from "@repo/platform/engine/modules/credentials/verify";

const provider = getCredentialProvider("docker-registry")!;

function response(status: number, headers: Record<string, string> = {}, body: unknown = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers,
    text: async () => JSON.stringify(body),
    json: async () => body,
    bytes: async () => Buffer.alloc(0),
  };
}

const values = (selector: string) => ({
  selector,
  publicFields: { username: "operator" },
  secrets: { secret: "registry-token" },
});

beforeEach(() => {
  vi.resetAllMocks();
  h.env.CLOUD_MODE = true;
});

describe("container-registry credential verification SSRF policy", () => {
  it("blocks private and plaintext registry targets in hosted mode", async () => {
    h.safeFetch.mockRejectedValueOnce(new Error("SSRF_BLOCKED"));

    await expect(verifyCredentialValues(provider, values("127.0.0.1:8080"))).resolves.toMatchObject(
      {
        ok: false,
      },
    );

    expect(h.safeFetch).toHaveBeenCalledWith("http://127.0.0.1:8080/v2/", {
      sameOriginRedirectsOnly: true,
      timeoutMs: 10_000,
      allowHttp: false,
      allowPrivate: false,
      maxRedirects: 3,
    });
  });

  it.each(["https://127.0.0.1:8443/token", "https://unrelated.example.test/token", "http://registry.example.com/token", "not-a-url"])("never forwards credentials to an untrusted bearer realm: %s", async realm => {
    h.safeFetch
      .mockResolvedValueOnce(
        response(401, {
          "www-authenticate":
            `Bearer realm="${realm}",service="hostile-registry"`,
        }),
      );

    await expect(
      verifyCredentialValues(provider, values("registry.example.com")),
    ).resolves.toMatchObject({ ok: false });

    expect(h.safeFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["docker.io", "https://auth.docker.io/token"],
    ["registry.gitlab.com", "https://gitlab.com/jwt/auth"],
    ["registry.example.com", "https://registry.example.com/token"],
  ])("preserves trusted token authentication for %s", async (registry, realm) => {
    h.safeFetch.mockResolvedValueOnce(response(401, { "www-authenticate": `Bearer realm="${realm}"` }))
      .mockResolvedValueOnce(response(200, {}, { token: "fixture-token" }));
    expect(await verifyCredentialValues(provider, values(registry))).toEqual({ ok: true });
    expect(h.safeFetch).toHaveBeenNthCalledWith(2, realm, expect.objectContaining({
      headers: { authorization: `Basic ${Buffer.from("operator:registry-token").toString("base64")}` },
      allowPrivate: false,
    }));
  });

  it("applies the hosted-mode guard to the authenticated basic retry", async () => {
    h.safeFetch
      .mockResolvedValueOnce(response(401, { "www-authenticate": 'Basic realm="registry"' }))
      .mockResolvedValueOnce(response(200));

    await expect(verifyCredentialValues(provider, values("registry.example.com"))).resolves.toEqual(
      { ok: true },
    );

    expect(h.safeFetch).toHaveBeenNthCalledWith(
      2,
      "https://registry.example.com/v2/",
      expect.objectContaining({
        headers: {
          authorization: `Basic ${Buffer.from("operator:registry-token").toString("base64")}`,
        },
        allowPrivate: false,
        maxRedirects: 3,
        sameOriginRedirectsOnly: true,
      }),
    );
  });

  it("keeps private and plaintext registries available to self-hosted operators", async () => {
    h.env.CLOUD_MODE = false;
    h.safeFetch.mockResolvedValueOnce(response(200));

    await expect(verifyCredentialValues(provider, values("localhost:5000"))).resolves.toMatchObject({
      ok: true,
      unverifiedReason: expect.stringContaining("could not verify"),
    });

    expect(h.safeFetch).toHaveBeenCalledWith(
      "http://localhost:5000/v2/",
      expect.objectContaining({ allowHttp: true, allowPrivate: true }),
    );
  });
});

describe("registry connection errors", () => {
  it("checks the registry login without a repository scope supplied in the challenge", async () => {
    h.safeFetch
      .mockResolvedValueOnce(response(401, {
        "www-authenticate": 'Bearer realm="https://registry.example.com/token?scope=repository:private:pull",service="registry.example.com"',
      }))
      .mockResolvedValueOnce(response(200, {}, { access_token: "fixture-token" }));

    expect(await verifyCredentialValues(provider, values("registry.example.com"))).toEqual({ ok: true });
    expect(h.safeFetch).toHaveBeenNthCalledWith(
      2,
      "https://registry.example.com/token?service=registry.example.com",
      expect.objectContaining({ sameOriginRedirectsOnly: true }),
    );
  });

  it.each(["{}", "invalid JSON"])(
    "does not verify a login from a successful response without a token (%s)",
    async (body) => {
      h.safeFetch
        .mockResolvedValueOnce(
          response(401, {
            "www-authenticate": 'Bearer realm="https://registry.example.com/token"',
          }),
        )
        .mockResolvedValueOnce({ ...response(200), text: async () => body });

      await expect(
        verifyCredentialValues(provider, values("registry.example.com")),
      ).resolves.toMatchObject({
        ok: false,
        reason: expect.stringContaining("did not return a registry token"),
      });
    },
  );

  it("treats a blocked authentication redirect as inconclusive", async () => {
    h.safeFetch
      .mockResolvedValueOnce(response(401, { "www-authenticate": 'Basic realm="registry"' }))
      .mockResolvedValueOnce(response(302, { location: "https://other.example.com/login" }));

    const result = await verifyCredentialValues(provider, values("registry.example.com"));
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("answered 302") });
  });

  it.each([
    'Bearer realm="https://registry.example.com/token",service="registry.example.com"',
    'Basic realm="registry"',
  ])("distinguishes a rejected login from an unavailable authentication endpoint: %s", async challenge => {
    for (const status of [401, 403, 429, 500, 503]) {
      h.safeFetch.mockResolvedValueOnce(response(401, { "www-authenticate": challenge }))
        .mockResolvedValueOnce(response(status));
      const result = await verifyCredentialValues(provider, values("registry.example.com"));
      expect(result.ok).toBe(false);
      expect("credentialRejected" in result).toBe(status === 401);
    }
    for (const [url] of h.safeFetch.mock.calls) expect(new URL(url).searchParams.has("scope")).toBe(false);
  });

  it.each([
    ["probe", undefined, "ERR_TLS_CERT_ALTNAME_INVALID"],
    [
      "token endpoint",
      'Bearer realm="https://registry.example.com/token"',
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    ],
    ["basic retry", 'Basic realm="registry"', "CERT_HAS_EXPIRED"],
  ])(
    "distinguishes TLS failures during the %s without exposing error details",
    async (_stage, challenge, code) => {
      if (challenge)
        h.safeFetch.mockResolvedValueOnce(response(401, { "www-authenticate": challenge }));
      h.safeFetch.mockRejectedValueOnce(
        Object.assign(new Error("https://operator:registry-token@private.example/secret"), {
          code,
        }),
      );

      const result = await verifyCredentialValues(provider, values("registry.example.com"));
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("TLS");
      expect(result.reason).toContain("Openship API");
      expect(result.reason).not.toMatch(/operator|registry-token|private\.example|\/secret/);
      if (challenge?.startsWith("Bearer")) expect(result.reason).toContain("token endpoint");
    },
  );

  it("recognizes a wrapped TLS error without publishing its cause", async () => {
    h.safeFetch.mockRejectedValueOnce(
      new Error("fetch failed", {
        cause: Object.assign(new Error("registry-token"), { code: "SELF_SIGNED_CERT_IN_CHAIN" }),
      }),
    );
    const result = await verifyCredentialValues(provider, values("registry.example.com"));
    expect(result.reason).toContain("TLS");
    expect(result.reason).not.toContain("registry-token");
  });

  it.each([
    [new Error("Request timed out"), "timed out"],
    [
      Object.assign(new Error("connect failed: registry-token"), { code: "ECONNREFUSED" }),
      "could not be reached",
    ],
  ])("keeps timeout and connectivity failures distinct", async (error, detail) => {
    h.safeFetch.mockRejectedValueOnce(error);
    const result = await verifyCredentialValues(provider, values("registry.example.com"));
    expect(result.reason).toContain(detail);
    expect(result.reason).not.toMatch(/TLS|registry-token/);
  });
});
