import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api/urls", () => ({
  getCloudApiOrigin: (url?: string) => url ?? "https://api.example.com",
  getCloudDashboardUrl: (url?: string) => url ?? "https://app.example.com",
}));

import { getPostAuthRedirect, validateReturnTo } from "./cloud-auth";

describe("MCP OAuth returnTo", () => {
  it("preserves the consent request through login", () => {
    const returnTo = "/mcp/authorize?client_id=desktop-client&consent_code=abc";
    const params = new URLSearchParams({ returnTo });

    expect(validateReturnTo(returnTo)).toBe(returnTo);
    expect(getPostAuthRedirect(params)).toBe(returnTo);
  });

  it("still rejects external redirects", () => {
    expect(validateReturnTo("//evil.example/mcp/authorize")).toBeNull();
    expect(validateReturnTo("https://evil.example/mcp/authorize")).toBeNull();
  });
});
