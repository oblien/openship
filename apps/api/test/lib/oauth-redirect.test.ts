import { describe, expect, it } from "vitest";
import {
  findEquivalentLoopbackRedirectUri,
  normalizeMcpRedirectUri,
} from "../../src/lib/oauth-redirect";

describe("findEquivalentLoopbackRedirectUri", () => {
  it("returns an exact match", () => {
    const registered = "http://localhost:19876/mcp/oauth/callback";

    expect(findEquivalentLoopbackRedirectUri(registered, [registered])).toBe(registered);
  });

  it("aliases localhost and 127.0.0.1 for the same callback", () => {
    const registered = "http://localhost:19876/mcp/oauth/callback";

    expect(
      findEquivalentLoopbackRedirectUri("http://127.0.0.1:19876/mcp/oauth/callback", [registered]),
    ).toBe(registered);
  });

  it("rejects different loopback addresses and lookalike domains", () => {
    const registered = "http://localhost:19876/mcp/oauth/callback";

    expect(
      findEquivalentLoopbackRedirectUri("http://127.0.0.2:19876/mcp/oauth/callback", [registered]),
    ).toBeUndefined();
    expect(
      findEquivalentLoopbackRedirectUri("http://127.evil.example:19876/mcp/oauth/callback", [
        registered,
      ]),
    ).toBeUndefined();
    expect(
      findEquivalentLoopbackRedirectUri("http://127.0.0.1.nip.io:19876/mcp/oauth/callback", [
        registered,
      ]),
    ).toBeUndefined();
    expect(
      findEquivalentLoopbackRedirectUri("http://[::1]:19876/mcp/oauth/callback", [registered]),
    ).toBeUndefined();
  });

  it("does not alias a different port or callback path", () => {
    const registered = "http://localhost:19876/mcp/oauth/callback";

    expect(
      findEquivalentLoopbackRedirectUri("http://127.0.0.1:19877/mcp/oauth/callback", [registered]),
    ).toBeUndefined();
    expect(
      findEquivalentLoopbackRedirectUri("http://127.0.0.1:19876/other/callback", [registered]),
    ).toBeUndefined();
  });

  it("does not relax matching for public hosts", () => {
    expect(
      findEquivalentLoopbackRedirectUri("https://example.com/callback", [
        "https://example.net/callback",
      ]),
    ).toBeUndefined();
  });

  it("rewrites the token request to the registered loopback URI", async () => {
    const request = new Request("https://openship.test/api/auth/mcp/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: "client",
        redirect_uri: "http://127.0.0.1:19876/mcp/oauth/callback",
        code: "code",
      }),
    });

    const normalized = await normalizeMcpRedirectUri(request, async () => [
      "http://localhost:19876/mcp/oauth/callback",
    ]);
    const body = await normalized.formData();

    expect(body.get("redirect_uri")).toBe("http://localhost:19876/mcp/oauth/callback");
    expect(body.get("code")).toBe("code");
  });

  it("rewrites the authorize request before the redirect URI is persisted", async () => {
    const request = new Request(
      "https://openship.test/api/auth/mcp/authorize?client_id=client&redirect_uri=" +
        encodeURIComponent("http://127.0.0.1:19876/mcp/oauth/callback"),
    );

    const normalized = await normalizeMcpRedirectUri(request, async () => [
      "http://localhost:19876/mcp/oauth/callback",
    ]);

    expect(new URL(normalized.url).searchParams.get("redirect_uri")).toBe(
      "http://localhost:19876/mcp/oauth/callback",
    );
  });

  it("leaves malformed token requests for Better Auth to reject", async () => {
    const request = new Request("https://openship.test/api/auth/mcp/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });

    expect(await normalizeMcpRedirectUri(request, async () => [])).toBe(request);
  });
});
