import { describe, expect, it } from "vitest";
import { rewriteUpstreamLocation } from "./proxy-response";

describe("rewriteUpstreamLocation", () => {
  const upstream = new URL("http://127.0.0.1:4000/api/auth/mcp/authorize");
  const publicOrigin = "https://ops.example.com";

  it("keeps OAuth self-redirects on the public dashboard origin", () => {
    const location = "http://127.0.0.1:4000/api/auth/mcp/authorize?client_id=codex&prompt=consent";

    expect(rewriteUpstreamLocation(location, upstream, publicOrigin)).toBe(
      "https://ops.example.com/api/auth/mcp/authorize?client_id=codex&prompt=consent",
    );
  });

  it("does not rewrite the OAuth client's loopback callback", () => {
    const location = "http://127.0.0.1:60580/callback/codex?code=abc&state=xyz";

    expect(rewriteUpstreamLocation(location, upstream, publicOrigin)).toBe(location);
  });
});
