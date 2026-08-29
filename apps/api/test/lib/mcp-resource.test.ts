import { describe, expect, it } from "vitest";
import {
  MCP_PROXY_RESOURCE_PATH,
  MCP_RESOURCE_PATH,
  allowedMcpResources,
  canonicalMcpResource,
  canonicalizeResource,
  isAllowedMcpResource,
  protectedResourceMetadata,
  protectedResourceMetadataUrl,
  publicRequestUrl,
  resolveTokenAudience,
  rewriteMetadataOrigin,
} from "../../src/lib/mcp-resource";

/**
 * RFC 8707 / RFC 9728 resource identity. The whole point is that comparison is
 * done on CANONICALIZED URLs — a client that sends a trailing slash, an
 * uppercase host or an explicit default port is naming the same resource, and
 * rejecting it strands the connection with an opaque authorization failure.
 */

const ORIGIN = "https://ship.example.net";

describe("canonicalizeResource", () => {
  it("lowercases scheme and host and keeps the path", () => {
    expect(canonicalizeResource("HTTPS://Ship.Example.NET/api/mcp")).toBe(
      "https://ship.example.net/api/mcp",
    );
  });

  it("drops a trailing slash, the default port, query and fragment", () => {
    expect(canonicalizeResource("https://ship.example.net:443/api/mcp/?a=1#f")).toBe(
      "https://ship.example.net/api/mcp",
    );
  });

  it("keeps a NON-default port — it is part of the identity", () => {
    expect(canonicalizeResource("http://localhost:4000/api/mcp")).toBe(
      "http://localhost:4000/api/mcp",
    );
  });

  it("rejects non-absolute and non-http(s) values", () => {
    expect(canonicalizeResource("/api/mcp")).toBeNull();
    expect(canonicalizeResource("ftp://ship.example.net/api/mcp")).toBeNull();
    expect(canonicalizeResource("")).toBeNull();
    expect(canonicalizeResource(null)).toBeNull();
  });
});

describe("allowedMcpResources", () => {
  it("lists the canonical URL first, then the proxy alias, then the legacy origin", () => {
    expect(allowedMcpResources(ORIGIN)).toEqual([
      `${ORIGIN}${MCP_RESOURCE_PATH}`,
      `${ORIGIN}${MCP_PROXY_RESOURCE_PATH}`,
      ORIGIN,
    ]);
  });

  it("is derived from the origin, never a hardcoded host", () => {
    expect(canonicalMcpResource("https://other.example.com")).toBe(
      "https://other.example.com/api/mcp",
    );
  });
});

describe("isAllowedMcpResource", () => {
  it("accepts the canonical URL and its noisy spellings", () => {
    for (const value of [
      `${ORIGIN}/api/mcp`,
      `${ORIGIN}/api/mcp/`,
      "HTTPS://SHIP.EXAMPLE.NET/api/mcp",
      "https://ship.example.net:443/api/mcp",
    ]) {
      expect(isAllowedMcpResource(value, ORIGIN)).toBe(true);
    }
  });

  it("accepts the same-origin proxy alias — it is the same endpoint", () => {
    expect(isAllowedMcpResource(`${ORIGIN}/api/proxy/api/mcp`, ORIGIN)).toBe(true);
  });

  it("accepts the bare origin so tokens issued against the legacy metadata survive", () => {
    expect(isAllowedMcpResource(ORIGIN, ORIGIN)).toBe(true);
  });

  it("rejects another host, another path, and a downgraded scheme", () => {
    expect(isAllowedMcpResource("https://evil.example.com/api/mcp", ORIGIN)).toBe(false);
    expect(isAllowedMcpResource(`${ORIGIN}/api/mcp/../admin`, ORIGIN)).toBe(false);
    expect(isAllowedMcpResource(`http://ship.example.net/api/mcp`, ORIGIN)).toBe(false);
  });
});

describe("resolveTokenAudience", () => {
  it("uses the requested resource, canonicalized", () => {
    expect(resolveTokenAudience(`${ORIGIN}/api/mcp/`, ORIGIN)).toBe(`${ORIGIN}/api/mcp`);
  });

  it("falls back to the canonical MCP URL for clients that send no resource", () => {
    expect(resolveTokenAudience(undefined, ORIGIN)).toBe(`${ORIGIN}/api/mcp`);
  });
});

describe("protected resource metadata", () => {
  it("advertises the FULL MCP URL as the resource, not the origin", () => {
    const doc = protectedResourceMetadata(ORIGIN, `${ORIGIN}${MCP_RESOURCE_PATH}`);
    expect(doc.resource).toBe("https://ship.example.net/api/mcp");
    expect(doc.resource.endsWith("/")).toBe(false);
    expect(doc.authorization_servers).toEqual([ORIGIN]);
    expect(doc.jwks_uri).toBe(`${ORIGIN}/api/auth/mcp/jwks`);
    expect(doc.bearer_methods_supported).toEqual(["header"]);
  });

  it("points clients at the path-aware well-known location", () => {
    expect(protectedResourceMetadataUrl(ORIGIN, MCP_RESOURCE_PATH)).toBe(
      `${ORIGIN}/.well-known/oauth-protected-resource/api/mcp`,
    );
  });
});

describe("rewriteMetadataOrigin", () => {
  /**
   * #543: Better Auth builds this document from its static baseURL, which on a
   * box whose API container has no OPENSHIP_PUBLIC_URL is the internal
   * `http://api:4000`. The advertised authorize/token endpoints then name a
   * host the external OAuth client can't reach. Re-point the whole document at
   * the request's public origin.
   */
  const INTERNAL = "http://api:4000";

  /**
   * Mirrors better-auth's `getMCPProviderMetadata` field-for-field (plugins/mcp
   * — v1.5.4). Kept faithful on purpose: the "never leaks" assertion below is
   * only load-bearing if the fixture carries every URL the real document does.
   */
  const metadata = () => ({
    issuer: INTERNAL,
    authorization_endpoint: `${INTERNAL}/api/auth/mcp/authorize`,
    token_endpoint: `${INTERNAL}/api/auth/mcp/token`,
    userinfo_endpoint: `${INTERNAL}/api/auth/mcp/userinfo`,
    jwks_uri: `${INTERNAL}/api/auth/mcp/jwks`,
    registration_endpoint: `${INTERNAL}/api/auth/mcp/register`,
    scopes_supported: ["openid", "profile", "email", "offline_access"],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    acr_values_supported: ["urn:mace:incommon:iap:silver", "urn:mace:incommon:iap:bronze"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256", "none"],
    code_challenge_methods_supported: ["S256"],
  });

  /** better-auth's `getMCPProtectedResourceMetadata` — note the URL nested in an ARRAY. */
  const protectedResource = () => ({
    resource: INTERNAL,
    authorization_servers: [INTERNAL],
    jwks_uri: `${INTERNAL}/api/auth/mcp/jwks`,
    scopes_supported: ["openid", "profile", "email", "offline_access"],
    bearer_methods_supported: ["header"],
    resource_signing_alg_values_supported: ["RS256", "none"],
  });

  it("re-points issuer + every endpoint URL onto the public origin, keeping paths", () => {
    const doc = rewriteMetadataOrigin(metadata(), ORIGIN);
    expect(doc.issuer).toBe(ORIGIN);
    expect(doc.authorization_endpoint).toBe(`${ORIGIN}/api/auth/mcp/authorize`);
    expect(doc.token_endpoint).toBe(`${ORIGIN}/api/auth/mcp/token`);
    expect(doc.userinfo_endpoint).toBe(`${ORIGIN}/api/auth/mcp/userinfo`);
    expect(doc.registration_endpoint).toBe(`${ORIGIN}/api/auth/mcp/register`);
    expect(doc.jwks_uri).toBe(`${ORIGIN}/api/auth/mcp/jwks`);
  });

  /**
   * `authorization_servers` is the field a top-level-strings-only pass misses:
   * its URL lives inside an array. A client that read the internal origin here
   * would echo it back as `resource=` and get `invalid_target` from the token
   * handler, which validates against the PUBLIC origin's resources.
   */
  it("re-points a URL nested inside an array (authorization_servers)", () => {
    const doc = rewriteMetadataOrigin(protectedResource(), ORIGIN);
    expect(doc.resource).toBe(ORIGIN);
    expect(doc.authorization_servers).toEqual([ORIGIN]);
    expect(doc.jwks_uri).toBe(`${ORIGIN}/api/auth/mcp/jwks`);
    expect(JSON.stringify(doc)).not.toContain("api:4000");
  });

  it("re-points URLs nested in objects (the plugin's options.metadata spread)", () => {
    const doc = rewriteMetadataOrigin(
      { nested: { end_session_endpoint: `${INTERNAL}/api/auth/mcp/logout`, depth: { u: [INTERNAL] } } },
      ORIGIN,
    );
    expect(doc).toEqual({
      nested: { end_session_endpoint: `${ORIGIN}/api/auth/mcp/logout`, depth: { u: [ORIGIN] } },
    });
  });

  it("keeps the issuer a bare origin — no trailing slash", () => {
    expect(rewriteMetadataOrigin(metadata(), ORIGIN).issuer).toBe(ORIGIN);
    expect((rewriteMetadataOrigin(metadata(), ORIGIN).issuer as string).endsWith("/")).toBe(false);
  });

  it("preserves query and fragment on a rewritten URL", () => {
    const doc = rewriteMetadataOrigin(
      { authorization_endpoint: `${INTERNAL}/api/auth/mcp/authorize?a=1#f` },
      ORIGIN,
    );
    expect(doc.authorization_endpoint).toBe(`${ORIGIN}/api/auth/mcp/authorize?a=1#f`);
  });

  /**
   * The walk is blind, so what keeps it safe is that non-URL strings fail the
   * parse-or-protocol check. `acr_values_supported` is the one that proves the
   * protocol half: `urn:…` PARSES as a URL, and must still pass through.
   */
  it("leaves non-URL values untouched, including urn: values that parse as URLs", () => {
    const doc = rewriteMetadataOrigin(metadata(), ORIGIN);
    expect(doc.scopes_supported).toEqual(["openid", "profile", "email", "offline_access"]);
    expect(doc.response_types_supported).toEqual(["code"]);
    expect(doc.id_token_signing_alg_values_supported).toEqual(["RS256", "none"]);
    expect(doc.acr_values_supported).toEqual([
      "urn:mace:incommon:iap:silver",
      "urn:mace:incommon:iap:bronze",
    ]);
  });

  it("passes non-string scalars through", () => {
    expect(rewriteMetadataOrigin({ a: 1, b: true, c: null, d: [1, null] }, ORIGIN)).toEqual({
      a: 1,
      b: true,
      c: null,
      d: [1, null],
    });
  });

  it("is idempotent — URLs already on the public origin are unchanged", () => {
    const already = rewriteMetadataOrigin(metadata(), ORIGIN);
    expect(rewriteMetadataOrigin(already, ORIGIN)).toEqual(already);
  });

  it("never leaks the internal upstream authority", () => {
    expect(JSON.stringify(rewriteMetadataOrigin(metadata(), ORIGIN))).not.toContain("api:4000");
  });
});

describe("publicRequestUrl", () => {
  /**
   * Regression for the flow-breaking bug: behind the dashboard's same-origin
   * proxy the API sees `Host: api:4000`, so a redirect built from `request.url`
   * sent every MCP client to an unresolvable internal host mid-OAuth.
   */
  const proxied = (path: string) =>
    new Request(`http://api:4000${path}`, {
      headers: { "x-forwarded-host": "ship.example.net", "x-forwarded-proto": "https" },
    });

  it("rebuilds a proxied request on the public origin, preserving path and query", () => {
    const url = publicRequestUrl(proxied("/api/auth/mcp/authorize?client_id=abc&state=1"));
    expect(url.origin).toBe("https://ship.example.net");
    expect(url.pathname).toBe("/api/auth/mcp/authorize");
    expect(url.searchParams.get("client_id")).toBe("abc");
    expect(url.searchParams.get("state")).toBe("1");
  });

  it("never leaks the internal upstream authority", () => {
    expect(publicRequestUrl(proxied("/api/auth/mcp/authorize")).toString()).not.toContain(
      "api:4000",
    );
  });

  it("ignores a spoofed forwarded host that is not a well-formed host", () => {
    const spoofed = new Request("http://api:4000/api/auth/mcp/authorize", {
      headers: { "x-forwarded-host": "evil.example.com/path", "x-forwarded-proto": "https" },
    });
    expect(publicRequestUrl(spoofed).origin).toBe("http://api:4000");
  });
});
