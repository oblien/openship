import { afterEach, describe, expect, it, vi } from "vitest";
import { unstable_getResponseFromNextConfig } from "next/experimental/testing/server";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe.each([false, true])("dashboard framing protection (API proxy: %s)", (apiProxy) => {
  it("denies framing across auth, project, API and middleware-excluded paths", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_PROXY", String(apiProxy));
    vi.resetModules();
    const { default: nextConfig } = await import("../../next.config.mjs");

    for (const path of [
      "/",
      "/login?returnTo=%2Fprojects",
      "/two-factor",
      "/projects/proj_test/settings",
      "/missing.html",
      "/api/proxy/api/auth/get-session",
    ]) {
      const response = await unstable_getResponseFromNextConfig({
        url: `https://app.openship.io${path}`,
        nextConfig,
      });

      expect(response.headers.get("Content-Security-Policy"), path).toBe("frame-ancestors 'none'");
      expect(response.headers.get("X-Frame-Options"), path).toBe("DENY");
    }
  });

  it("retains the OAuth endpoint rewrite with framing protection", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_PROXY", String(apiProxy));
    vi.resetModules();
    const { default: nextConfig } = await import("../../next.config.mjs");
    const response = await unstable_getResponseFromNextConfig({
      url: "https://ops.example.com/.well-known/oauth-authorization-server/api/mcp",
      nextConfig,
    });

    expect(response.headers.get("x-middleware-rewrite")).toBe(
      apiProxy
        ? "https://ops.example.com/api/proxy/.well-known/oauth-authorization-server/api/mcp"
        : null,
    );
    expect(response.headers.get("Content-Security-Policy")).toBe("frame-ancestors 'none'");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  });
});
