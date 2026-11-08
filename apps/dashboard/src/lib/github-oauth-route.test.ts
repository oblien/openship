import { afterEach, describe, expect, it, vi } from "vitest";
import { unstable_getResponseFromNextConfig } from "next/experimental/testing/server";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe.each([false, true])("GitHub OAuth navigation (API proxy: %s)", (apiProxy) => {
  it("routes the canonical authorization endpoint while preserving the query", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_PROXY", String(apiProxy));
    vi.resetModules();
    const { default: nextConfig } = await import("../../next.config.mjs");
    const response = await unstable_getResponseFromNextConfig({
      url: "https://ops.example.com/api/github/connect/redirect?install_state=fixture",
      nextConfig,
    });

    expect(response.headers.get("x-middleware-rewrite")).toBe(
      apiProxy
        ? "https://ops.example.com/api/proxy/api/github/connect/redirect?install_state=fixture"
        : null,
    );
  });
});
