import { describe, expect, it, vi } from "vitest";
import { newServerBillingHref } from "./billing-links";

vi.mock("@/lib/api/urls", () => ({
  getCloudApiOrigin: () => "https://api.openship.io",
  getCloudDashboardUrl: () => "https://app.openship.io",
}));

import {
  buildAuthPageHref,
  computePkceChallenge,
  getPostAuthRedirect,
  validateReturnTo,
  authContinuationHref,
  emailVerificationHref,
} from "./cloud-auth";

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

describe("app installation post-auth return", () => {
  const destination = "/apps/new/open-webui?projectId=proj_draft";

  it("preserves custom catalog identifiers without restricting them to bundled app names", () => {
    const returnTo = "/apps/new/Custom_app_42";
    expect(getPostAuthRedirect(new URLSearchParams({ returnTo }))).toBe(returnTo);
  });

  it("keeps the app across login, registration, verification, 2FA and organization selection", () => {
    let href = authContinuationHref("/login", destination);
    href = buildAuthPageHref("/register", new URL(href, "https://app.openship.io").searchParams);
    href = emailVerificationHref("user@example.test", new URL(href, "https://app.openship.io").searchParams);
    expect(getPostAuthRedirect(new URL(href, "https://app.openship.io").searchParams)).toBe(destination);
    for (const route of ["/two-factor", "/select-organization", "/forgot-password", "/reset-password", "/login"] as const) {
      href = buildAuthPageHref(route, new URL(href, "https://app.openship.io").searchParams);
      expect(getPostAuthRedirect(new URL(href, "https://app.openship.io").searchParams)).toBe(destination);
    }
  });

  it.each([
    "https://evil.test/apps/new/minio", "//evil.test/apps/new/minio", "/\\evil.test/apps/new/minio",
    "/apps/new", "/apps/new/", "/apps/new/minio/extra", "/apps/new/minio/../../settings",
    "/apps/new/minio\\..\\settings", "/apps/new/%2e%2e", "/apps/new/%2f%2fevil.test",
    "/apps/new/minio\n", "/settings", "/apps/new/minio" + "?x=" + "x".repeat(512),
  ])("rejects an unsafe or unrelated continuation: %s", (input) => {
    expect(validateReturnTo(input)).toBeNull();
    expect(authContinuationHref("/login", input)).toBe("/login");
  });
});

it("preserves a landing-page plan purchase through login without allowing arbitrary billing routes", () => {
  const destination = "/billing/plans?newServer=1&plan=starter&startCheckout=1&checkoutIntent=72e918ec-8d9c-4b81-bf43-7a5790ca239a";
  const login = authContinuationHref("/login", destination);
  const signup = buildAuthPageHref("/register", new URL(login, "https://app.openship.io").searchParams);
  expect(getPostAuthRedirect(new URL(signup, "https://app.openship.io").searchParams)).toBe(destination);
  for (const unsafe of ["//evil.test/billing/plans", "/billing/plans/../../settings", "/billing/plans\\evil.test", "/billing/plans%2fextra", "/billing/payment"])
    expect(validateReturnTo(unsafe)).toBeNull();
});

it.each(["monthly", "annual"] as const)("keeps a referral and %s plan through signup, verification and organization selection", (interval) => {
  const destination = newServerBillingHref("team", { planId: "starter", interval, startCheckout: true, referralCode: "AF-PARTNER" });
  let href = authContinuationHref("/login", destination);
  for (const route of ["/register", "/two-factor", "/select-organization"] as const) {
    href = buildAuthPageHref(route, new URL(href, "https://app.openship.io").searchParams);
    expect(getPostAuthRedirect(new URL(href, "https://app.openship.io").searchParams)).toBe(destination);
  }
  href = emailVerificationHref("customer@example.test", new URL(href, "https://app.openship.io").searchParams);
  expect(getPostAuthRedirect(new URL(href, "https://app.openship.io").searchParams)).toBe(destination);
  expect(new URL(destination, "https://app.openship.io").searchParams.get("ref")).toBe("AF-PARTNER");
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
