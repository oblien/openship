import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// Exercise the real MCP routes without app.ts's server and scheduler startup.
vi.mock("../../../src/app", () => ({ app: { fetch: vi.fn() } }));
vi.mock("../../../src/middleware/rate-limiter", () => ({
  rateLimiterFor: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

import { mcpRoutes } from "../../../src/modules/mcp/mcp.routes";

const app = new Hono().route("/api/mcp", mcpRoutes);
const ORIGIN = "https://ops.example.com";

describe("MCP OAuth discovery challenge", () => {
  it.each([
    ["GET", "/api/mcp"],
    ["POST", "/api/mcp"],
    ["GET", "/api/proxy/api/mcp"],
    ["POST", "/api/proxy/api/mcp"],
  ])("advertises matching metadata for %s %s", async (method, publicPath) => {
    const response = await app.request("http://api:4000/api/mcp", {
      method,
      headers: {
        "x-forwarded-host": "ops.example.com",
        "x-forwarded-proto": "https",
        "x-forwarded-uri": publicPath,
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource${publicPath}"`,
    );
    expect(response.headers.get("access-control-expose-headers")).toBe("WWW-Authenticate");
  });

  it("keeps canonical discovery for a direct API request", async () => {
    const response = await app.request(`${ORIGIN}/api/mcp`, { method: "POST" });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api/mcp"`,
    );
  });
});
