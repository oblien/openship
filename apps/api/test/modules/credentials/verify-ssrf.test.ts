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

function response(status: number, headers: Record<string, string> = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers,
    text: async () => "",
    json: async () => ({}),
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
      headers: undefined,
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
      .mockResolvedValueOnce(response(200));
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
      }),
    );
  });

  it("keeps private and plaintext registries available to self-hosted operators", async () => {
    h.env.CLOUD_MODE = false;
    h.safeFetch.mockResolvedValueOnce(response(200));

    await expect(verifyCredentialValues(provider, values("localhost:5000"))).resolves.toEqual({
      ok: true,
    });

    expect(h.safeFetch).toHaveBeenCalledWith(
      "http://localhost:5000/v2/",
      expect.objectContaining({ allowHttp: true, allowPrivate: true }),
    );
  });
});
