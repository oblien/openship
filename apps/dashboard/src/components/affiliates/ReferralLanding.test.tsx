// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { pricingUi, resolvePlan } from "@repo/core";
import type { AffiliatePublicOffer } from "@repo/contracts";
import type { ApiPlan } from "@/components/billing/PricingCards";
import { baseDictionary } from "@/i18n";
import { validateReturnTo } from "@/lib/cloud-auth";
import { ReferralLanding } from "./ReferralLanding";

const h = vi.hoisted(() => ({ offer: vi.fn(), push: vi.fn(), catalog: vi.fn() }));
vi.mock("@/lib/api/affiliates", () => ({ getReferralOffer: h.offer }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push }) }));
vi.mock("@/components/i18n-provider", async (original) => ({
  ...(await original<typeof import("@/components/i18n-provider")>()),
  useI18n: () => ({ t: baseDictionary, locale: "en" }),
}));
vi.mock("@/components/billing/useCloudBilling", () => ({ useCloudPlans: h.catalog }));

const code = "AF-PARTNER";
const offer: AffiliatePublicOffer = {
  code,
  name: "Partner",
  productId: "workspace_vm",
  planId: null,
  discountBps: 500,
  durationMonths: 12,
  expiresAt: null,
  minimumMonthlyCents: 1000,
};
const plans: ApiPlan[] = (["hobby", "starter", "pro", "team", "enterprise"] as const).map((id) => {
  const source = resolvePlan(id);
  return {
    ...source,
    features: [...source.features],
    resourceLimits: source.oblienLimits,
    listPrice: { monthly: source.price.monthly },
    effectivePrice: { monthly: source.price.monthly },
    campaign: null,
  };
});
let root: Root, host: HTMLDivElement;
const render = () => act(async () => root.render(<ReferralLanding code={code} />));
const titles = () => [...host.querySelectorAll("article h3")].map((node) => node.textContent);
const button = (label: string) =>
  [...host.querySelectorAll("button")].find((node) => node.textContent?.trim() === label)!;
const click = (label: string) => act(async () => button(label).click());
const target = () => new URL(h.push.mock.calls.at(-1)![0], "https://app.openship.io");
function catalog(offers = plans, annual = true) {
  h.catalog.mockReturnValue({
    loading: false,
    error: null,
    retry: vi.fn(),
    payload: {
      plans: offers,
      ui: pricingUi("en"),
      annual: { enabled: annual, monthsFree: 0 },
    },
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.offer.mockResolvedValue(offer);
  catalog();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("shows the live Cloud cards, defaults to annual and continues the selected plan with its referral", async () => {
  await render();
  expect(titles()).toEqual(["Hobby", "Starter", "Pro", "Scale"]);
  expect(button("Yearly").getAttribute("aria-pressed")).toBe("true");
  expect(host.textContent).toContain("Save 5% for 12 months");
  expect(h.push).not.toHaveBeenCalled();
  await click("Choose Hobby");
  expect(target().pathname).toBe("/billing/plans");
  expect(Object.fromEntries(target().searchParams)).toEqual({
    newServer: "1",
    plan: "hobby",
    interval: "annual",
    startCheckout: "1",
    ref: code,
  });
  expect(validateReturnTo(`${target().pathname}${target().search}`)).not.toBeNull();
});

it("preserves monthly selection and keeps generic sign-in browse-only", async () => {
  await render();
  const signIn = host.querySelector<HTMLAnchorElement>('a[href^="/login?"]')!;
  const destination = new URL(signIn.href).searchParams.get("returnTo")!;
  expect(validateReturnTo(destination)).toBe(destination);
  expect(destination).toBe(`/billing/plans?newServer=1&ref=${code}`);
  await click("Monthly");
  expect(h.push).not.toHaveBeenCalled();
  await click("Choose Starter");
  expect(target().searchParams.get("interval")).toBe("monthly");
  expect(target().searchParams.get("ref")).toBe(code);
});

it("offers only the referral's eligible VM capacity and respects the minimum for each interval", async () => {
  h.offer.mockResolvedValue({ ...offer, planId: "vm:2:8192:128" });
  const starter = plans.find((plan) => plan.id === "starter")!;
  catalog([
    ...plans.filter((plan) => plan.id !== "starter"),
    { ...starter, price: { monthly: 2400, annual: 11999 } },
  ]);
  await render();
  expect(titles()).toEqual(["Starter"]);
  expect(button("Yearly")).toBeUndefined();
  await click("Choose Starter");
  expect(target().searchParams.get("interval")).toBe("monthly");
});

it("excludes unavailable, metered and non-compute offers", async () => {
  catalog(
    plans.map((plan) =>
      plan.id === "hobby"
        ? { ...plan, availableForPurchase: false }
        : plan.id === "starter"
          ? { ...plan, billingMode: "metered" }
          : plan.id === "pro"
            ? { ...plan, resourceLimits: undefined }
            : plan,
    ),
  );
  await render();
  expect(titles()).toEqual(["Scale"]);
});

it("waits for referral validation without exposing an unverified checkout or sign-in link", async () => {
  let resolve!: (offer: AffiliatePublicOffer) => void;
  h.offer.mockReturnValue(
    new Promise<AffiliatePublicOffer>((r) => {
      resolve = r;
    }),
  );
  await render();
  expect(titles()).toEqual([]);
  expect(host.querySelector('a[href^="/login?"]')).toBeNull();
  expect(button(baseDictionary.auth.login.submit).disabled).toBe(true);
  expect(h.push).not.toHaveBeenCalled();
  await act(async () => resolve(offer));
  expect(titles()).toHaveLength(4);
});

it("preserves an unavailable referral through selection and sign-in so checkout requires explicit removal", async () => {
  h.offer.mockRejectedValue(new Error("Referral expired"));
  await render();
  expect(host.textContent).toContain(baseDictionary.affiliates.referralUnavailable);
  expect(h.push).not.toHaveBeenCalled();
  await click("Choose Starter");
  expect(target().searchParams.get("ref")).toBe(code);
  const signIn = host.querySelector<HTMLAnchorElement>('a[href^="/login?"]')!;
  expect(new URL(signIn.href).searchParams.get("returnTo")).toBe(
    `/billing/plans?newServer=1&ref=${code}`,
  );
});

it("uses monthly when annual checkout is unavailable", async () => {
  catalog(plans, false);
  await render();
  expect(button("Yearly")).toBeUndefined();
  await click("Choose Hobby");
  expect(target().searchParams.get("interval")).toBe("monthly");
});

it("limits public cards to the selected plan and billing combinations and chooses the only eligible interval", async () => {
  h.offer.mockResolvedValue({
    ...offer,
    eligiblePlans: [{ planId: "vm:1:4096:50", intervals: ["annual"] }],
  });
  await render();
  expect(titles()).toEqual(["Hobby"]);
  expect(button("Monthly")).toBeUndefined();
  await click("Choose Hobby");
  expect(target().searchParams.get("interval")).toBe("annual");
});
