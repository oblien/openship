import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api/urls", () => ({
  getCloudApiOrigin: () => "https://api.openship.io",
  getCloudDashboardUrl: () => "https://app.openship.io",
}));

import { computePkceChallenge } from "./cloud-auth";

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
