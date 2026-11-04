import { afterEach, beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  env: { CLOUD_MODE: false, AFFILIATES_ENABLED: false },
  provider: vi.fn(),
}));
vi.mock("../src/engine/config/env", () => ({
  env: h.env,
  cloudRuntimeTarget: { api: "https://cloud.example.test" },
}));
vi.mock("../src/engine/lib/oblien-client", () => ({
  getOblienBillingApi: () => ({ affiliateRequest: h.provider }),
}));
import { readAffiliateOffer } from "../src/engine/modules/affiliates/affiliate-public";
const code = "AF-0123456789";
const offer = {
  code,
  name: "Community",
  productId: "workspace_vm",
  planId: null,
  discountBps: 500,
  durationMonths: 12,
  expiresAt: null,
  minimumMonthlyCents: 1000,
};
beforeEach(() => {
  h.env.CLOUD_MODE = false;
  h.env.AFFILIATES_ENABLED = false;
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllGlobals());

it("lets Desktop verify Cloud terms without forwarding local credentials or enabling a local program", async () => {
  const fetcher = vi.fn(async () => Response.json({ data: offer }));
  vi.stubGlobal("fetch", fetcher);
  expect(await readAffiliateOffer(code)).toEqual(offer);
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    new URL(`https://cloud.example.test/api/referrals/${code}`),
    {
      credentials: "omit",
      redirect: "error",
      signal: expect.any(AbortSignal),
    },
  );
  expect(h.provider).not.toHaveBeenCalled();
});
it("rejects path injection and mismatched codes rather than applying other terms", async () => {
  const fetcher = vi.fn(async () => Response.json({ data: { ...offer, code: "AF-9876543210" } }));
  vi.stubGlobal("fetch", fetcher);
  await expect(readAffiliateOffer("../billing/payouts")).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
  await expect(readAffiliateOffer(code)).rejects.toMatchObject({
    code: "AFFILIATE_PROVIDER_SCOPE_MISMATCH",
  });
});
it("keeps Cloud feature-off unavailable and does not recurse into its public endpoint", async () => {
  h.env.CLOUD_MODE = true;
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await expect(readAffiliateOffer(code)).rejects.toMatchObject({ code: "AFFILIATE_UNAVAILABLE" });
  expect(fetcher).not.toHaveBeenCalled();
  expect(h.provider).not.toHaveBeenCalled();
});
