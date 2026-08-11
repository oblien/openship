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
