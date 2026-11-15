import { afterEach, beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  env: { CLOUD_MODE: false, REFERRALS_ENABLED: false },
  provider: vi.fn(),
}));
vi.mock("../src/engine/config/env", () => ({
  env: h.env,
  cloudRuntimeTarget: { api: "https://cloud.example.test" },
}));
vi.mock("../src/engine/lib/oblien-client", () => ({
  getOblienBillingApi: () => ({ referralRequest: h.provider }),
}));
import { resolveReferralCode, referralCheckoutBinding } from "../src/engine/modules/referrals/referral-checkout";
import { referralParticipantKey } from "../src/engine/modules/referrals/referral-provider";
import { readReferralOffer } from "../src/engine/modules/referrals/referral-public";
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
  h.env.REFERRALS_ENABLED = false;
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllGlobals());

it("lets Desktop verify Cloud terms without forwarding local credentials or enabling a local program", async () => {
  const fetcher = vi.fn(async () => Response.json({ data: offer }));
  vi.stubGlobal("fetch", fetcher);
  expect(await readReferralOffer(code)).toEqual(offer);
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
  await expect(readReferralOffer("../billing/payouts")).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
  await expect(readReferralOffer(code)).rejects.toMatchObject({
    code: "AFFILIATE_PROVIDER_SCOPE_MISMATCH",
  });
});
it("keeps Cloud feature-off unavailable and does not recurse into its public endpoint", async () => {
  h.env.CLOUD_MODE = true;
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await expect(readReferralOffer(code)).rejects.toMatchObject({ code: "AFFILIATE_UNAVAILABLE" });
  expect(fetcher).not.toHaveBeenCalled();
  expect(h.provider).not.toHaveBeenCalled();
});

it("preserves existing participant ownership across the Referral rename", () => {
  expect(referralParticipantKey("alice")).toBe("9128fa57b97e7d6776411ffefba433b4e312abb60f221daedf2afec80a92d240");
});

it("normalizes the legacy checkout field to the same provider attribution", () => {
  const terms = { enabled: true, namespace: "openship", userId: "alice", memberIds: ["alice"],
    offer: { billingMode: "monthly", unitAmount: 2000 }, interval: "monthly" as const };
  const canonical = referralCheckoutBinding({ ...terms, referralCode: resolveReferralCode({ referralCode: code }) });
  const legacy = referralCheckoutBinding({ ...terms, referralCode: resolveReferralCode({ affiliateCode: code }) });
  expect(canonical).toEqual(legacy);
  expect(canonical).toMatchObject({ affiliateCode: code, affiliateBuyer: { buyerKey: referralParticipantKey("alice") } });
  expect(canonical).not.toHaveProperty("referralCode");
  expect(() => resolveReferralCode({ referralCode: code, affiliateCode: "AF-ABCDEFGHIJ" })).toThrow("Supply one referral code");
});
