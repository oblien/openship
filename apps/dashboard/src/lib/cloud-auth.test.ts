import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api/urls", () => ({
  getCloudApiOrigin: () => "https://api.openship.io",
  getCloudDashboardUrl: () => "https://app.openship.io",
}));

import {
  buildAuthPageHref,
  computePkceChallenge,
  getCloudDesktopHandoffUrl,
  getPostAuthRedirect,
  selfHostedDesktopApiUrl,
  validateReturnTo,
} from "./cloud-auth";

describe("selfHostedDesktopApiUrl", () => {
  it("keeps the official cloud API and points every other host at itself", () => {
    expect(selfHostedDesktopApiUrl({ hostname: "app.openship.io", origin: "https://app.openship.io" })).toBeUndefined();
    expect(selfHostedDesktopApiUrl({ hostname: "ops.example.com", origin: "https://ops.example.com" })).toBe(
      "https://ops.example.com/api/proxy",
    );
    const handoff = getCloudDesktopHandoffUrl({
      callbackUrl: "http://127.0.0.1:4010/api/auth/cloud-callback",
      cloudApiUrl: "https://ops.example.com/api/proxy",
    });
    expect(handoff.startsWith("https://ops.example.com/api/proxy/api/cloud/desktop-handoff?")).toBe(true);
  });
});

describe("computePkceChallenge", () => {
  it("computes the RFC 7636 S256 example without Web Crypto", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

    await expect(computePkceChallenge(verifier, null)).resolves.toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("matches the Web Crypto implementation", async () => {
    const verifier = "openship-private-lan-pkce-regression-test";

    const native = await computePkceChallenge(verifier, globalThis.crypto.subtle);
    const fallback = await computePkceChallenge(verifier, null);

    expect(fallback).toBe(native);
  });
});

describe("invitation post-auth return", () => {
  const params = (returnTo: string) => new URLSearchParams({ returnTo });

  it("allows only an exact opaque invitation claim path", () => {
    expect(validateReturnTo("/accept-invite/inv_AbC-123")).toBe(
      "/accept-invite/inv_AbC-123",
    );
    expect(validateReturnTo("/accept-invite/../../settings")).toBeNull();
    expect(validateReturnTo("/accept-invite/")).toBeNull();
    expect(validateReturnTo("/accept-invite/inv_1/extra")).toBeNull();
  });

  it("preserves the claim through login/register and returns to it", () => {
    const returnTo = "/accept-invite/inv_AbC-123";
    expect(buildAuthPageHref("/register", params(returnTo))).toBe(
      "/register?returnTo=%2Faccept-invite%2Finv_AbC-123",
    );
    expect(getPostAuthRedirect(params(returnTo))).toBe(returnTo);
  });

  it("still rejects external and protocol-relative redirects", () => {
    expect(validateReturnTo("https://evil.example/accept-invite/inv_1")).toBeNull();
    expect(validateReturnTo("//evil.example/accept-invite/inv_1")).toBeNull();
  });

  it("keeps a billing link's organization through login without permitting arbitrary redirects", () => {
    const returnTo = "/cloud-billing?organizationId=org_one&tab=topups";
    expect(validateReturnTo(returnTo)).toBe(returnTo);
    expect(getPostAuthRedirect(params(returnTo))).toBe(returnTo);
    expect(new URL(buildAuthPageHref("/register", params(returnTo)), "https://dashboard.test").searchParams.get("returnTo")).toBe(returnTo);
    for (const unsafe of ["//evil.test/cloud-billing", "/cloud-billing/../../settings", "/cloud-billing-extra", "/cloud-billing\\evil.test"])
      expect(validateReturnTo(unsafe)).toBeNull();
  });
});
