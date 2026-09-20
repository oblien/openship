import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { generateGitHubAppJwt, githubAppFetch } from "@repo/platform/engine/modules/github/github.app-client";

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GitHub App client", () => {
  it("signs a short-lived RS256 JWT for the supplied App", () => {
    const jwt = generateGitHubAppJwt({ appId: 12345, privateKeyPem: privateKey });
    const [encodedHeader, encodedPayload, signature] = jwt.split(".");
    const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8"));
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));

    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(payload.iss).toBe("12345");
    expect(payload.exp - payload.iat).toBe(660);
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(
      crypto.verify(
        "RSA-SHA256",
        Buffer.from(`${encodedHeader}.${encodedPayload}`),
        publicKey,
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
  });

  it("uses the configured Enterprise API base and authenticates with the App JWT", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ id: 12345, slug: "acme-app" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      githubAppFetch(
        {
          appId: 12345,
          privateKeyPem: privateKey,
          apiBaseUrl: "https://github.acme.test/api/v3/",
        },
        "/app",
      ),
    ).resolves.toMatchObject({ id: 12345, slug: "acme-app" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://github.acme.test/api/v3/app");
    expect(init?.headers).toMatchObject({
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    });
    expect((init?.headers as Record<string, string>).Authorization).toMatch(/^Bearer eyJ/);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects a non-RSA private key before making a request", async () => {
    const ec = crypto.generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    }).privateKey;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(githubAppFetch({ appId: 12345, privateKeyPem: ec }, "/app")).rejects.toThrow(
      "must be an RSA private key",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
