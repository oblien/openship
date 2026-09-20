// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLANS, pricingUi } from "@repo/core";
import { I18nProvider } from "@/components/i18n-provider";
import { baseDictionary } from "@/i18n";
import type { BillingState } from "@/lib/api/billing";
import { isNewCloudCustomer } from "@/lib/billing-presentation";
import { BillingSidebar, InvoicesPanel, PaymentMethodPanel } from "@/app/(dashboard)/billing/_components/billing-shared";
import { BillingOverview } from "./BillingOverview";
import { BillingCapacity } from "./BillingCapacity";
import { BillingResourceUsage } from "./BillingResourceUsage";
import { ResourceMeter } from "./ResourceMeter";
import { BillingTopups } from "./BillingTopups";
import { BillingUsage } from "./BillingUsage";
import type { ApiPlan } from "./PricingCards";

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("@/lib/api/client", async original => ({ ...await original<typeof import("@/lib/api/client")>(), api: { get: mocks.get, post: mocks.post } }));

const copy = baseDictionary.billing;
const free: BillingState = {
  tier: "free", status: "credit_exhausted", subscription: null, plan: null,
  currentPeriod: { start: null, end: null },
  balance: { total: 0, quotaLimit: 0, quotaUsed: 0, quotaRemaining: 0, unlimited: false },
  monthlyCreditLimit: 0, overQuota: true, buildTimeMinutes: 0,
  capacity: { projects: { used: 0, max: 0 }, buildMinutes: { used: 0, max: 0 }, services: { used: 0, max: 0 } },
  billing: { enabled: true }, topups: { available: false, status: "unavailable" },
  capabilities: { portal: true, cancellation: false, subscriptionChange: true },
};
// Deliberately different from both catalog files: the offer must use API values.
const hobby: ApiPlan = {
  id: "starter", name: "Hobby", description: "A live plan", popular: false,
  price: { monthly: 1500, annual: 15000 }, listPrice: { monthly: 1500 }, effectivePrice: { monthly: 1500 }, campaign: null,
  monthlyCredits: 1_234_000, annualCredits: 14_555_000, limits: PLANS.starter.limits, features: ["Email support"], support: "",
};
const payload = { data: { locale: "en", annual: { enabled: true, monthsFree: 0 }, ui: pricingUi("en"), plans: [
  { ...hobby, id: "pro", name: "Pro", price: { monthly: 2900, annual: 29000 } }, hobby,
] } };
const paid: BillingState = {
  ...free, tier: "starter", status: "active", plan: hobby, overQuota: false,
  subscription: { tier: "starter", status: "active", interval: "monthly", currentPeriod: { start: "2026-09-01T00:00:00Z", end: "2026-10-01T00:00:00Z" }, cancelAtPeriodEnd: false, canceledAt: null },
  balance: { total: 900_000, quotaLimit: 1_200_000, quotaUsed: 300_000, quotaRemaining: 900_000, unlimited: false },
  capacity: { projects: { used: 1, max: 10 }, buildMinutes: { used: 5, max: 3000 }, services: { used: 1, max: 3 } },
};
let root: Root;
let container: HTMLDivElement;
const render = async (node: React.ReactNode) => { await act(async () => root.render(<I18nProvider>{node}</I18nProvider>)); };
function visibleText() {
  const visible = container.cloneNode(true) as HTMLElement;
  for (const details of visible.querySelectorAll("details:not([open])")) details.replaceChildren(details.querySelector("summary")!.cloneNode(true));
  return visible.textContent ?? "";
}
function button(label: string) {
  const result = [...container.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === label);
  expect(result, label).toBeDefined();
  return result!;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.get.mockResolvedValue(payload);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("Cloud billing before the first subscription", () => {
  it.each([0, null])("shows no included compute and a live subscription offer for quota %s", async quota => {
    const state = { ...free, balance: { ...free.balance, quotaLimit: quota, total: quota, quotaRemaining: quota } };
    await render(<><BillingOverview state={state} /><BillingSidebar state={state} /></>);
    expect(container.textContent).toContain(copy.resourcesGuide.noPlan);
    for (const label of [copy.resourcesGuide.projects, copy.resourcesGuide.apps, copy.resourcesGuide.buildTime]) {
      const card = container.querySelector(`div[aria-label="${label}"]`);
      expect(card?.querySelector("[data-resource-value]")?.textContent).toMatch(/^0/);
      expect(card?.textContent).toContain(copy.onboarding.planRequired);
    }
    expect(visibleText()).not.toMatch(/credits|0 of 3|500/i);
    expect(container.textContent).not.toMatch(/Unlimited|No set limit|∞/);
    expect(container.textContent).toContain("$15");
    expect(container.textContent).toContain("1,234 credits / billing cycle");
    expect(container.querySelector("dl")?.textContent).not.toMatch(/credits/i);
    expect(button("Subscribe to Hobby").disabled).toBe(false);
    expect(mocks.get).toHaveBeenCalledOnce();
    expect(mocks.get.mock.calls[0]![0]).toContain("billing/plans");
    expect(mocks.post).not.toHaveBeenCalled();
    expect(container.querySelector("details")?.open).toBe(false);
  });

  it("keeps a usable pricing link during catalog failures and recovers on retry", async () => {
    mocks.get.mockRejectedValueOnce(new Error("Offline"));
    await render(<BillingSidebar state={free} />);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(copy.plansRoute.loadError);
    expect(container.querySelector('a[href="/billing/plans"]')).not.toBeNull();
    expect(container.textContent).not.toContain("$10");
    await act(async () => button(copy.plansRoute.tryAgain).click());
    expect(button("Subscribe to Hobby").disabled).toBe(false);
  });

  it("uses one checkout attempt for duplicate clicks and uncertain retries", async () => {
    let reject!: (reason: Error) => void;
    mocks.post.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
    await render(<BillingSidebar state={free} />);
    await act(async () => { button("Subscribe to Hobby").click(); container.querySelector("button")!.click(); });
    expect(mocks.post).toHaveBeenCalledOnce();
    await act(async () => reject(new Error("Checkout temporarily unavailable")));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Checkout temporarily unavailable");
    mocks.post.mockRejectedValueOnce(new Error("Still offline"));
    await act(async () => button("Subscribe to Hobby").click());
    expect(mocks.post.mock.calls[1]![1]).toEqual(mocks.post.mock.calls[0]![1]);
    expect(mocks.post.mock.calls[0]).toEqual(["billing/subscription", { planTierId: "starter", interval: "monthly", idempotencyKey: expect.any(String) }]);
  });

  it("keeps checkout disabled when purchases are disabled", async () => {
    await render(<BillingSidebar state={{ ...free, billing: { enabled: false } }} />);
    expect(button("Subscribe to Hobby").disabled).toBe(true);
    expect(container.textContent).toContain(copy.plansRoute.billingUnavailable);
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("offers useful empty states without a nonexistent payment portal or credit purchase", async () => {
    await render(<><PaymentMethodPanel portalAvailable hasHistory={false} /><InvoicesPanel portalAvailable hasHistory={false} /><BillingTopups state={free} /><BillingUsage state={free} /></>);
    for (const message of [copy.onboarding.paymentTitle, copy.onboarding.invoicesTitle, copy.onboarding.topupsTitle, copy.onboarding.usageTitle]) expect(container.textContent).toContain(message);
    expect(container.textContent).not.toContain(copy.portal.openButton);
    expect(container.querySelectorAll('a[href="/billing/plans"]')).toHaveLength(4);
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("preserves previously purchased credits without promising a free plan", async () => {
    const state = { ...free, balance: { total: 150_000, quotaLimit: 200_000, quotaUsed: 50_000, quotaRemaining: 150_000 } };
    expect(isNewCloudCustomer(state)).toBe(false);
    await render(<BillingCapacity state={state} />);
    expect(container.textContent).toContain(copy.resourcesGuide.noPlan);
    expect(container.textContent).toContain("150 credits left");
    expect(container.textContent).toContain(copy.onboarding.savedCreditsHint);
    expect(visibleText()).not.toContain("150 credits");
  });

  it("replaces the offer with the paid plan after verified state refresh", async () => {
    await render(<BillingSidebar state={free} />);
    expect(button("Subscribe to Hobby")).toBeDefined();
    await render(<BillingSidebar state={paid} />);
    expect(container.textContent).toContain(copy.pricing.currentPlan);
    expect(container.textContent).toContain("Hobby");
    expect(container.textContent).not.toContain("Subscribe to Hobby");
    await render(<BillingSidebar state={{ ...paid, subscription: { ...paid.subscription!, cancelAtPeriodEnd: true } }} />);
    expect(container.textContent).toContain(copy.pricing.currentPlan);
    await render(<BillingSidebar state={{ ...paid, subscription: { ...paid.subscription!, status: "canceled" } }} />);
    expect(button("Subscribe to Hobby").disabled).toBe(false);
  });
});

describe("customer credit limits", () => {
  it("reuses a top-up key after an uncertain response and prevents duplicate clicks", async () => {
    mocks.get.mockResolvedValue({ data: [{ id: "extra", name: "Extra", credits_milli: 617_000, price_cents: 1000, sortOrder: 0 }] });
    let reject!: (reason: Error) => void;
    mocks.post.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
    await render(<BillingTopups state={{ ...paid, topups: { available: true, status: "available" } }} />);
    await act(async () => { const buy = button(copy.topups.buy); buy.click(); buy.click(); });
    expect(mocks.post).toHaveBeenCalledOnce();
    await act(async () => reject(new Error("Checkout response was interrupted")));
    mocks.post.mockRejectedValueOnce(new Error("Checkout still unavailable"));
    await act(async () => button(copy.topups.buy).click());
    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(mocks.post.mock.calls[1]).toEqual(mocks.post.mock.calls[0]);
    expect(mocks.post.mock.calls[0]).toEqual(["billing/topup", { packId: "extra", idempotencyKey: expect.any(String) }]);
  });
  it.each([["monthly", "50%"], ["annual", "4.2%"]] as const)("explains a top-up against the actual %s plan allowance", async (interval, percent) => {
    mocks.get.mockResolvedValue({ data: [{ id: "extra", name: "Extra", credits_milli: 617_000, price_cents: 1000, sortOrder: 0 }] });
    await render(<BillingTopups state={{ ...paid, subscription: { ...paid.subscription!, interval }, topups: { available: true, status: "available" } }} />);
    expect(visibleText()).toContain(percent);
    expect(visibleText()).toContain("$10.00");
    expect(visibleText()).toContain(copy.topups.allowanceEquivalent);
    expect(visibleText()).not.toMatch(/credits/i);
    expect(container.textContent).toContain("617 credits");
    expect(button(copy.topups.buy).disabled).toBe(false);
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it("leads with resource meters and shows credit accounting only on request", async () => {
    await render(<BillingCapacity state={paid} />);
    expect(visibleText()).toContain(copy.resourcesGuide.includedTitle);
    expect(visibleText()).toContain("25% used");
    expect(visibleText()).toContain("75% remaining");
    expect(visibleText()).toContain("9 remaining");
    expect(container.querySelector('[role="meter"][aria-label="Projects"]')?.getAttribute("aria-valuenow")).toBe("1");
    expect(visibleText()).not.toMatch(/credits|300 of 1,200/);
    const details = [...container.querySelectorAll("details")].find(item => item.querySelector("summary")?.textContent?.includes(copy.resourcesGuide.usageDetails))!;
    expect(details.open).toBe(false);
    await act(async () => { details.open = true; });
    expect(visibleText()).toContain("900 credits left");
  });
  it("does not turn an unknown paid balance into unlimited credits", async () => {
    await render(<BillingCapacity state={{ ...paid, balance: { total: null, quotaLimit: null, quotaUsed: 300_000, quotaRemaining: null, unlimited: false } }} />);
    expect(container.textContent).not.toMatch(/Unlimited|No set limit|∞/);
    expect(container.textContent).toContain("— credits left");
  });

  it("shows uncapped credits only for an explicitly verified Enterprise entitlement", async () => {
    await render(<BillingCapacity state={{ ...paid, tier: "enterprise", balance: { total: null, quotaLimit: null, quotaUsed: 300_000, quotaRemaining: null, unlimited: true } }} />);
    expect(container.textContent).toContain(copy.resourcesGuide.unlimited);
    await render(<BillingCapacity state={{ ...paid, tier: "enterprise", subscription: { ...paid.subscription!, tier: "enterprise", status: "canceled" }, balance: { total: null, quotaLimit: null, quotaUsed: 300_000, quotaRemaining: null, unlimited: true } }} />);
    expect(container.textContent).not.toMatch(/Unlimited|No set limit|∞/);
    await render(<BillingCapacity state={{ ...paid, balance: { total: null, quotaLimit: null, quotaUsed: 300_000, quotaRemaining: null, unlimited: true } }} />);
    expect(container.textContent).not.toMatch(/Unlimited|No set limit|∞/);
  });
});

describe("resource usage overview", () => {
  const resourceCopy = copy.resourceOverview;
  const usage = {
    measuredAt: "2026-09-19T00:00:00Z",
    compute: { status: "available", period: { start: "2026-09-01", end: "2026-10-01" }, cpuHours: 2, memoryGbHours: 4, diskIoGb: .25, networkGb: 1.5 },
    edge: { status: "available", period: { start: "2026-09-01", end: "2026-10-01" }, limits: { bandwidthGb: 50 }, requests: 130, bandwidthGb: 3.5, inboundGb: 1, outboundGb: 2.5 },
  };
  it("renders real usage, traffic remaining and request counts without inventing CPU-hour allowances", async () => {
    mocks.get.mockResolvedValue({ data: usage });
    await render(<BillingResourceUsage state={paid} />);
    expect(mocks.get).toHaveBeenCalledWith("billing/resources");
    expect(visibleText()).toContain("2vCPU-h");
    expect(visibleText()).toContain("46.5 GB remaining");
    expect(visibleText()).toContain("130");
    expect(visibleText()).toContain(resourceCopy.requestsIncluded);
    expect(visibleText()).not.toMatch(/Unlimited|credits|NaN|Infinity/);
    const meter = container.querySelector('[role="meter"]');
    expect(meter?.getAttribute("aria-label")).toBe(resourceCopy.bandwidth);
    expect(meter?.getAttribute("aria-valuenow")).toBe("3.5");
    expect(meter?.getAttribute("aria-valuemax")).toBe("50");
    expect(container.querySelectorAll('[role="meter"]')).toHaveLength(1);
  });
  it("shows unavailable edge metrics without erasing measured compute and can refresh", async () => {
    mocks.get.mockResolvedValueOnce({ data: { ...usage, edge: { ...usage.edge, status: "unavailable", bandwidthGb: null, requests: null } } });
    await render(<BillingResourceUsage state={paid} />);
    expect(visibleText()).toContain(resourceCopy.partialError);
    expect(visibleText()).toContain("2vCPU-h");
    expect(container.querySelector('[role="meter"]')).toBeNull();
    mocks.get.mockResolvedValueOnce({ data: usage });
    await act(async () => container.querySelector<HTMLButtonElement>(`button[aria-label="${resourceCopy.refresh}"]`)!.click());
    expect(visibleText()).not.toContain(resourceCopy.partialError);
    expect(visibleText()).toContain("46.5 GB remaining");
  });
  it("keeps zero usage as an empty circle and clamps an exhausted meter without hiding overuse", async () => {
    await render(<ResourceMeter label="Traffic" hint="Traffic used" used={0} max={50} icon={null} unit="GB" />);
    expect(container.querySelector('[role="meter"]')?.getAttribute("aria-valuenow")).toBe("0");
    expect(container.querySelectorAll('[role="meter"] circle')).toHaveLength(1);
    expect(visibleText()).toContain("50 GB remaining");
    await render(<ResourceMeter label="Traffic" hint="Traffic used" used={60} max={50} icon={null} unit="GB" />);
    expect(container.querySelector('[role="meter"]')?.getAttribute("aria-valuenow")).toBe("50");
    expect(visibleText()).toContain("60GB/ 50 GB");
    expect(visibleText()).toContain("0 GB remaining");
  });
});
