import { describe, expect, it } from "vitest";
import config, { SECURITY_RESPONSE_HEADERS } from "../../next.config.mjs";

describe("dashboard security response headers", () => {
  it("applies the hardening headers to every dashboard and proxied API route", async () => {
    await expect(config.headers?.()).resolves.toEqual([
      { source: "/:path*", headers: SECURITY_RESPONSE_HEADERS },
    ]);
  });

  it("denies framing and sensitive browser features on the public control plane", () => {
    expect(SECURITY_RESPONSE_HEADERS).toEqual(
      expect.arrayContaining([
        { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      ]),
    );
  });
});
