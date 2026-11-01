// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLANS, pricingUi } from "@repo/core";
import { I18nProvider } from "@/components/i18n-provider";
import { ModalProvider } from "@/context/ModalContext";
import { PlatformProvider } from "@/context/PlatformContext";
import { baseDictionary } from "@/i18n";
import type { BillingState } from "@/lib/api/billing";
import type { BillingPlanChange, BillingPlanChangeQuote } from "@repo/contracts";
import { ApiError } from "@/lib/api/client";
import { isNewCloudCustomer } from "@/lib/billing-presentation";
import { BillingPlanSummary, BillingSidebar, BillingPaymentsPanel } from "@/app/(dashboard)/billing/_components/billing-shared";
import { BillingOverview } from "./BillingOverview";
import { BillingCapacity } from "./BillingCapacity";
import { BillingComputeCoverage } from "./BillingComputeCoverage";
import { PlanResources } from "./PlanResources";
import { PlanUsageNote } from "./PlanUsageNote";
import { BillingResourceUsage } from "./BillingResourceUsage";
import { ResourceMeter } from "./ResourceMeter";
import { BillingTopups } from "./BillingTopups";
import { BillingUsage } from "./BillingUsage";
import { CloudPlanPicker } from "./CloudPlanPicker";
import { BillingWorkspaceProvider } from "./BillingWorkspaceContext";
import { SubscriptionChangeStatus } from "./SubscriptionChangeStatus";
import { CloudHomePlanCard } from "./CloudHomePlanCard";
import type { ApiPlan } from "./PricingCards";
import { monthlyCompute } from "../../../test/helpers/monthly-billing";

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), usage: vi.fn() }));
vi.mock("@/lib/api/system", () => ({ systemApi: { serverUsage: mocks.usage } }));
vi.mock("@/lib/api/client", async original => ({ ...await original<typeof import("@/lib/api/client")>(), api: { get: mocks.get, post: mocks.post } }));
vi.mock("@/lib/auth-client", () => ({ useSession: () => ({ data: { user: { id: "billing-viewer" }, session: { activeOrganizationId: "billing-org" } } }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

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
const scale: ApiPlan = {
  ...hobby, id: "team", name: "Scale", price: { monthly: 9900, annual: 99000 },
  monthlyCredits: 15_000_000, limits: PLANS.team.limits,
};
const payload = { data: { locale: "en", annual: { enabled: true, monthsFree: 0 }, ui: pricingUi("en"), plans: [
  { ...hobby, id: "pro", name: "Pro", price: { monthly: 2900, annual: 29000 } }, hobby, scale,
] } };
const paid: BillingState = {
  ...free, tier: "starter", status: "active", plan: hobby, overQuota: false,
  subscription: { tier: "starter", status: "active", interval: "monthly", currentPeriod: { start: "2026-09-01T00:00:00Z", end: "2026-10-01T00:00:00Z" }, cancelAtPeriodEnd: false, canceledAt: null },
  balance: { total: 900_000, quotaLimit: 1_200_000, quotaUsed: 300_000, quotaRemaining: 900_000, unlimited: false },
  capacity: { projects: { used: 1, max: 10 }, buildMinutes: { used: 5, max: 3000 }, services: { used: 1, max: 3 } },
};
const complimentary: BillingState = {
  ...paid, tier: "team", subscription: null,
  plan: { ...scale, price: { monthly: 0, annual: null }, effectivePrice: { monthly: 0 }, listPrice: { monthly: 0 } },
  complimentary: { id: "grant-scale", expiresAt: null },
  currentPeriod: { start: "2026-09-27T09:35:06Z", end: "2026-10-27T09:35:06Z" },
  monthlyCreditLimit: 15_000_000,
  balance: { total: 15_000_000, quotaLimit: 15_000_000, quotaUsed: 0, quotaRemaining: 15_000_000, unlimited: false },
  capabilities: { portal: false, cancellation: false, subscriptionChange: false },
  topups: { available: false, status: "unavailable" },
};
let root: Root;
let container: HTMLDivElement;
const render = async (node: React.ReactNode) => { await act(async () => root.render(<I18nProvider><PlatformProvider selfHosted={false}><ModalProvider>{node}</ModalProvider></PlatformProvider></I18nProvider>)); };
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
  mocks.get.mockImplementation(async (path: string) => path === "billing/checkouts" ? { data: { items: [] } } : payload);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Cloud billing before the first subscription", () => {
  it.each([0, null])("shows no included compute and a live subscription offer for quota %s", async quota => {
    const state = { ...free, balance: { ...free.balance, quotaLimit: quota, total: quota, quotaRemaining: quota } };
    await render(<><BillingOverview state={state} /><BillingSidebar state={state} /></>);
    expect(container.textContent).toContain(copy.onboarding.workspaceDescription);
    expect(container.querySelector('[role="meter"]')).toBeNull();
    expect(visibleText()).not.toMatch(/0 of 3|500 credits/i);
    expect(container.textContent).toContain("$15");
    expect(container.querySelector('a[href="/billing/plans"]')).not.toBeNull();
    expect(button("Subscribe to Hobby").disabled).toBe(false);
    expect(mocks.get).toHaveBeenCalledOnce();
    expect(mocks.get.mock.calls[0]![0]).toContain("billing/plans");
    expect(mocks.post).not.toHaveBeenCalled();
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
    await render(<><BillingPaymentsPanel portalAvailable hasHistory={false} /><BillingTopups state={free} /><BillingUsage state={free} /></>);
    for (const message of [copy.onboarding.paymentTitle, copy.onboarding.topupsTitle, copy.onboarding.usageTitle]) expect(container.textContent).toContain(message);
    expect(container.textContent).not.toContain(copy.portal.openButton);
    expect(container.querySelectorAll('a[href="/billing/plans"]')).toHaveLength(3);
    expect(container.textContent).toContain(copy.pendingPayments.empty);
    expect(mocks.get).toHaveBeenCalledExactlyOnceWith("billing/checkouts", { params: { workspaceId: undefined } });
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("preserves previously purchased credits without promising a free plan", async () => {
    const state = { ...free, balance: { total: 150_000, quotaLimit: 200_000, quotaUsed: 50_000, quotaRemaining: 150_000 } };
    expect(isNewCloudCustomer(state)).toBe(false);
    await render(<BillingCapacity state={state} />);
    expect(container.textContent).toContain(`${copy.onboarding.savedCredits}: 150`);
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
    expect(container.textContent).toContain(copy.sidebar.noActivePlan);
    expect(container.textContent).not.toContain("Subscribe to Hobby");
  });
});

describe("existing server billing", () => {
  it("confirms cancellation once for the selected server and shows when access ends", async () => {
    const state = {
      ...paid,
      workspace: { id: "cws-production", name: "Production", provisioned: true },
      capabilities: {
        ...paid.capabilities!,
        cancellation: true,
        resumption: true,
      },
    };
    let finish!: (value: unknown) => void;
    mocks.post.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await render(<BillingSidebar state={state} showSubscriptionControls />);
    await act(async () => button(copy.subscription.cancel).click());
    expect(mocks.post).not.toHaveBeenCalled();
    const confirm = button(copy.subscription.confirmCancel);
    await act(async () => {
      confirm.click();
      confirm.click();
    });
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith("billing/cancel", {
      workspaceId: "cws-production",
    });
    expect(confirm.disabled).toBe(true);
    await act(async () =>
      finish({
        data: {
          cancelAt: state.subscription!.currentPeriod.end,
          subscription: { ...state.subscription, cancelAtPeriodEnd: true },
        },
      }),
    );
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Renewal stopped",
    );
    expect(button(copy.subscription.resume).disabled).toBe(false);
  });

  it("does not report cancellation after a failed response and retries the same server", async () => {
    const state = {
      ...paid,
      workspace: { id: "cws-production", name: "Production", provisioned: true },
      capabilities: { ...paid.capabilities!, cancellation: true },
    };
    mocks.post.mockRejectedValueOnce(new Error("Cloud billing unavailable"));
    await render(<BillingSidebar state={state} showSubscriptionControls />);
    await act(async () => button(copy.subscription.cancel).click());
    await act(async () => button(copy.subscription.confirmCancel).click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Cloud billing unavailable",
    );
    expect(container.querySelector('[role="status"]')?.textContent).not.toContain(
      "Renewal stopped",
    );
    mocks.post.mockResolvedValueOnce({
      data: {
        cancelAt: state.subscription!.currentPeriod.end,
        subscription: { ...state.subscription, cancelAtPeriodEnd: true },
      },
    });
    await act(async () => button(copy.subscription.confirmCancel).click());
    expect(mocks.post.mock.calls).toEqual([
      ["billing/cancel", { workspaceId: "cws-production" }],
      ["billing/cancel", { workspaceId: "cws-production" }],
    ]);
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Renewal stopped",
    );
  });

  it("uses one Stripe portal action for payment methods and invoices in the selected server", async () => {
    mocks.post.mockRejectedValueOnce(new Error("Portal temporarily unavailable"));
    await render(<BillingWorkspaceProvider workspaceId="cws-production"><BillingPaymentsPanel portalAvailable /></BillingWorkspaceProvider>);
    expect(container.textContent).toContain(copy.paymentPanel.title);
    expect([...container.querySelectorAll("button")].filter(item => item.textContent === copy.paymentPanel.openStripe)).toHaveLength(1);
    expect(mocks.get).toHaveBeenCalledExactlyOnceWith("billing/checkouts", { params: { workspaceId: undefined } });
    await act(async () => button(copy.paymentPanel.openStripe).click());
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith("billing/portal", { workspaceId: "cws-production" });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Portal temporarily unavailable");
    expect(button(copy.paymentPanel.openStripe).disabled).toBe(false);
  });

  it("keeps an allocated server out of onboarding even with no remaining allowance or usage", async () => {
    const state = { ...free, capacity: { ...free.capacity, workspaces: { used: 1, max: 1 } } };
    expect(isNewCloudCustomer(state)).toBe(false);
    await render(<BillingSidebar state={state} />);
    expect(container.textContent).toContain(copy.sidebar.noActivePlan);
    expect(container.textContent).toContain(copy.sidebar.inactiveServer);
    expect(container.textContent).not.toContain("Start with Hobby");
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("does not turn an allocated server into a newcomer when provider capacity is unavailable", async () => {
    const state = { ...free, workspace: { id: "workspace", name: "Production", provisioned: true } };
    expect(isNewCloudCustomer(state)).toBe(false);
    await render(<BillingSidebar state={state} />);
    expect(container.textContent).toContain(copy.sidebar.noActivePlan);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("preserves a live paid subscription when the entitlement tier is free", async () => {
    await render(<BillingSidebar state={{ ...paid, tier: "free", status: "past_due", plan: null }} />);
    expect(container.textContent).toContain(PLANS.starter.name);
    expect(container.textContent).not.toContain(copy.sidebar.noActivePlan);
    expect(container.textContent).not.toContain("Start with");
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("shows the renewal date and preserves access through a scheduled cancellation", async () => {
    await render(<BillingSidebar state={paid} />);
    expect(container.textContent).toContain("Renews on Oct 1, 2026");
    await render(<BillingSidebar state={{ ...paid, subscription: { ...paid.subscription!, cancelAtPeriodEnd: true } }} />);
    expect(container.textContent).toContain("Access until Oct 1, 2026");
    expect(container.textContent).not.toContain("Renews on");
    expect(container.textContent).not.toContain("Start with");
  });

  it("does not describe an exhausted balance as prepaid credit", async () => {
    await render(<BillingCapacity state={{ ...free, balance: { ...free.balance, quotaUsed: 150_000, quotaRemaining: -150_000 } }} />);
    expect(container.textContent).toContain("Balance: -150");
    expect(container.textContent).not.toContain(copy.onboarding.savedCredits);
    expect(container.textContent).not.toContain(copy.onboarding.stepsTitle);
  });

  it.each(["active", "trialing", "past_due", "unpaid", "paused"] as const)("does not start a full-price checkout to replace a %s subscription", async status => {
    await render(<CloudPlanPicker currentPlan="starter" currentOffer={hobby} subscription={{ ...paid.subscription!, status }} billingEnabled canChangeSubscription />);
    const choices = [...container.querySelectorAll<HTMLButtonElement>("article button")];
    expect(choices.length).toBeGreaterThan(0);
    expect(choices.every(choice => choice.disabled)).toBe(true);
    expect(container.textContent).toContain(copy.plansRoute.changeViaSupport);
    expect(mocks.post).not.toHaveBeenCalled();
  });
});

describe("existing server plan-change review", () => {
  const planCopy = copy.planChange;
  const quote = (overrides: Partial<BillingPlanChangeQuote> = {}): BillingPlanChangeQuote => ({
    id: "quote_selected", direction: "upgrade", interval: "monthly", currency: "usd",
    expiresAt: new Date(Date.now() + 9 * 60_000).toISOString(), effectiveAt: new Date().toISOString(),
    current: { name: "Saved Hobby", priceCents: 1300 }, next: { name: "Pro", priceCents: 2900 },
    unusedTimeCredit: 321, remainingTimeCharge: 1234, amountDueNow: 913, nextInvoiceAmount: 2900,
    resize: { revision: "server_revision", before: { cpuCores: 1, memoryMb: 4096, diskMb: 25600 },
      after: { cpuCores: 4, memoryMb: 16384, diskMb: 51200 }, restartProjects: [{ id: "project_api", name: "Public API" }] },
    ...overrides,
  });
  const change = (overrides: Partial<BillingPlanChange> = {}): BillingPlanChange => ({
    id: "change_selected", direction: "upgrade", currency: "usd", effectiveAt: new Date().toISOString(),
    current: { name: "Saved Hobby", priceCents: 1300 }, next: { name: "Pro", priceCents: 2900 },
    amountDueNow: 913, status: "payment_pending", cancelable: true, appliedAt: null,
    errorCode: null, paymentUrl: "https://invoice.stripe.com/i/test", paymentExpiresAt: null,
    ...overrides,
  });
  const picker = (workspaceId = "server_billing_one", interval: "monthly" | "annual" = "monthly") =>
    <CloudPlanPicker workspaceId={workspaceId} currentPlan="starter" currentOffer={hobby}
      subscription={{ ...paid.subscription!, interval }} billingEnabled canChangeSubscription />;
  const choosePro = () => container.querySelector<HTMLButtonElement>('article[aria-label="Pro"] button')!;
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
  const dialogButton = (label: string) => {
    const result = [...dialog()!.querySelectorAll<HTMLButtonElement>("button")].find(item => (item.getAttribute("aria-label") ?? item.textContent?.trim()) === label);
    expect(result, label).toBeDefined();
    return result!;
  };
  const review = async () => {
    mocks.post.mockResolvedValueOnce({ data: quote() });
    await render(picker());
    expect(choosePro().textContent).toBe(planCopy.review);
    await act(async () => choosePro().click());
  };

  it("shows provider prices and affected projects before confirming a paid change", async () => {
    await review();
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith("billing/subscription/change/preview", {
      workspaceId: "server_billing_one", planTierId: "pro", custom: undefined, idempotencyKey: expect.any(String),
    });
    expect(dialog()?.textContent).toContain("Saved Hobby");
    for (const text of ["$13.00", "$9.13", "$3.21", "$12.34", "Public API", planCopy.restartAfterPayment])
      expect(dialog()?.textContent).toContain(text);
    let finish!: (value: unknown) => void;
    mocks.post.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    await act(async () => { dialogButton(planCopy.confirmUpgrade).click(); dialogButton(planCopy.confirmUpgrade).click(); });
    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(mocks.post).toHaveBeenLastCalledWith("billing/subscription/change", {
      workspaceId: "server_billing_one", quoteId: "quote_selected", confirmRestart: true,
    });
    await act(async () => finish({ data: change() }));
    expect(dialog()?.textContent).toContain(planCopy.paymentPending);
    expect(dialog()?.querySelector<HTMLAnchorElement>('a[href="https://invoice.stripe.com/i/test"]')?.textContent).toBe(planCopy.completePayment);
    expect(mocks.post.mock.calls.some(([path]) => path === "billing/subscription")).toBe(false);
  });

  it("retries an uncertain acceptance using the saved quote, even after its expiry", async () => {
    vi.useFakeTimers();
    await review();
    mocks.post.mockRejectedValueOnce(new Error("Connection interrupted"));
    await act(async () => dialogButton(planCopy.confirmUpgrade).click());
    const input = mocks.post.mock.calls[1];
    await act(async () => vi.advanceTimersByTimeAsync(10 * 60_000));
    expect(dialog()?.textContent).not.toContain(planCopy.expired);
    mocks.post.mockResolvedValueOnce({ data: change() });
    await act(async () => dialogButton(planCopy.retry).click());
    expect(mocks.post.mock.calls[2]).toEqual(input);
    expect(mocks.post.mock.calls.filter(([path]) => path === "billing/subscription/change/preview")).toHaveLength(1);
  });

  it("requires a fresh quote after a definite stale-price rejection", async () => {
    await review();
    mocks.post.mockRejectedValueOnce(new ApiError(409, "Conflict", {
      code: "OBLIEN_BILLING_ERROR", error: "Review the changed price", details: { providerCode: "billing_quote_changed" },
    }));
    await act(async () => dialogButton(planCopy.confirmUpgrade).click());
    mocks.post.mockResolvedValueOnce({ data: quote({ id: "quote_fresh", amountDueNow: 917 }) });
    await act(async () => dialogButton(planCopy.refreshQuote).click());
    expect(mocks.post.mock.calls[2]![0]).toBe("billing/subscription/change/preview");
    expect(mocks.post.mock.calls[2]![1].idempotencyKey).not.toBe(mocks.post.mock.calls[0]![1].idempotencyKey);
    expect(dialog()?.textContent).toContain("$9.17");
    mocks.post.mockResolvedValueOnce({ data: change({ amountDueNow: 917 }) });
    await act(async () => dialogButton(planCopy.confirmUpgrade).click());
    expect(mocks.post.mock.calls[3]![1].quoteId).toBe("quote_fresh");
  });

  it("discards a late quote on a server switch and displays the new server's billing interval", async () => {
    let finish!: (value: unknown) => void;
    mocks.post.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    await render(picker());
    await act(async () => choosePro().click());
    await render(picker("server_billing_two", "annual"));
    expect(container.querySelector('[role="group"][aria-label="Billing interval"]')).toBeNull();
    expect(container.querySelector('article[aria-label="Pro"]')?.textContent).toContain("$290");
    await act(async () => finish({ data: quote() }));
    expect(dialog()).toBeNull();
    mocks.post.mockResolvedValueOnce({ data: quote({ interval: "annual" }) });
    await act(async () => choosePro().click());
    expect(mocks.post).toHaveBeenLastCalledWith("billing/subscription/change/preview", expect.objectContaining({ workspaceId: "server_billing_two" }));
    expect(dialog()?.textContent).toContain(planCopy.yearly);
  });

  it("reviews a scheduled downgrade without requesting immediate payment", async () => {
    mocks.post.mockResolvedValueOnce({ data: quote({ direction: "downgrade", amountDueNow: 0, effectiveAt: "2026-11-01T00:00:00Z" }) });
    await render(picker());
    await act(async () => choosePro().click());
    expect(dialog()?.textContent).toContain("Nov 1, 2026");
    expect(dialog()?.textContent).not.toContain(planCopy.remainingCharge);
    mocks.post.mockResolvedValueOnce({ data: change({ direction: "downgrade", status: "scheduled", paymentUrl: null, effectiveAt: "2026-11-01T00:00:00Z" }) });
    await act(async () => dialogButton(planCopy.confirmDowngrade).click());
    expect(dialog()?.textContent).toContain("Pro starts on Nov 1, 2026, after renewal payment.");
    expect(dialog()?.querySelector('a[href*="stripe.com"]')).toBeNull();
    mocks.post.mockResolvedValueOnce({ data: change({ status: "canceled", cancelable: false, paymentUrl: null }) });
    await act(async () => dialogButton(planCopy.cancelChange).click());
    expect(mocks.post).toHaveBeenLastCalledWith("billing/subscription/change/cancel", { changeId: "change_selected", workspaceId: "server_billing_one" });
    expect(dialog()?.textContent).toContain(planCopy.canceled);
  });

  it("polls the same pending change and hides its recovery link after application", async () => {
    vi.useFakeTimers();
    const initial = change();
    mocks.get.mockResolvedValue({ data: change({ status: "applied", serverUpdate: "review_required", cancelable: false }) });
    await render(<SubscriptionChangeStatus initial={initial} workspaceId="server_billing_one" />);
    expect(container.querySelector('a[href*="stripe.com"]')).not.toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(mocks.get).toHaveBeenCalledExactlyOnceWith("billing/subscription/change", { params: { changeId: "change_selected", workspaceId: "server_billing_one" } });
    expect(container.textContent).toContain(planCopy.resizeReview);
    expect(container.querySelector('a[href*="stripe.com"]')).toBeNull();
    expect(container.querySelector('a[href="/billing/overview?workspaceId=server_billing_one"]')).not.toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(mocks.get).toHaveBeenCalledOnce();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("traps review focus and closes without purchasing on Escape", async () => {
    await review();
    expect(document.activeElement).toBe(dialog());
    dialogButton(planCopy.confirmUpgrade).focus();
    await act(async () => dialogButton(planCopy.confirmUpgrade).dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(dialogButton(planCopy.close));
    await act(async () => dialogButton(planCopy.close).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(dialog()).toBeNull();
    expect(mocks.post).toHaveBeenCalledOnce();
  });

  it("keeps keyboard focus in the dialog when payment and cancellation replace its actions", async () => {
    await review();
    dialogButton(planCopy.confirmUpgrade).focus();
    mocks.post.mockResolvedValueOnce({ data: change() });
    await act(async () => dialogButton(planCopy.confirmUpgrade).click());
    expect(dialog()?.contains(document.activeElement)).toBe(true);

    dialogButton(planCopy.cancelChange).focus();
    mocks.post.mockResolvedValueOnce({ data: change({ status: "canceled", cancelable: false, paymentUrl: null }) });
    await act(async () => dialogButton(planCopy.cancelChange).click());
    expect(dialog()?.contains(document.activeElement)).toBe(true);
    await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(dialog()).toBeNull();
    expect(mocks.post).toHaveBeenCalledTimes(3);
  });
});

describe("Cloud home plan card", () => {
  it("gives a new workspace a direct plan comparison without another catalog or checkout request", async () => {
    await render(<CloudHomePlanCard state={free} />);
    expect(container.textContent).toContain(copy.home.title);
    expect(container.querySelector('a[href="/billing/plans"]')?.textContent).toContain(copy.home.viewPlans);
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("removes the offer after the workspace subscribes", async () => {
    await render(<CloudHomePlanCard state={free} />);
    expect(container.querySelector("section")).not.toBeNull();
    await render(<CloudHomePlanCard state={paid} />);
    expect(container.querySelector("section")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
  });

  it("recognizes complimentary access without prompting for another subscription", async () => {
    await render(<CloudHomePlanCard state={complimentary} />);
    expect(container.querySelector("section")).toBeNull();
  });

  it("does not advertise an available subscription while purchases are disabled", async () => {
    await render(<CloudHomePlanCard state={{ ...free, billing: { enabled: false } }} />);
    expect(container.querySelector("section")).toBeNull();
  });

  it("does not invent a free or active plan when billing is unavailable", async () => {
    await render(<CloudHomePlanCard state={null} />);
    expect(container.querySelector("section")).toBeNull();
  });

  it.each(["credit_exhausted", "past_due", "paused"])("keeps the card hidden for an existing %s customer", async status => {
    await render(<CloudHomePlanCard state={{ ...paid, status }} />);
    expect(container.querySelector("section")).toBeNull();
  });

  it("does not treat a canceled subscriber or an account with saved credits as a new customer", async () => {
    await render(<CloudHomePlanCard state={{ ...free, subscription: { ...paid.subscription!, status: "canceled" } }} />);
    expect(container.querySelector("section")).toBeNull();
    await render(<CloudHomePlanCard state={{ ...free, balance: paid.balance }} />);
    expect(container.querySelector("section")).toBeNull();
  });
});

describe("complimentary Cloud plans", () => {
  it.each(["active", "credit_exhausted"])("shows the current Scale grant without a paid subscription when %s", async status => {
    await render(<BillingSidebar state={{ ...complimentary, status }} />);
    expect(container.querySelector("h2")?.textContent).toBe("Scale");
    expect(visibleText()).toContain(copy.pricing.currentPlan);
    expect(visibleText()).toContain(copy.complimentary.label);
    expect(visibleText()).toContain(copy.complimentary.untilRevoked);
    expect(visibleText()).toContain("Credits renew on Oct 27, 2026");
    expect(container.textContent).not.toContain(copy.subscription.billedMonthly);
    expect(container.textContent).not.toContain(copy.onboarding.offerDescription);
    expect(container.querySelector("button")).toBeNull();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("shows the grant expiry without promising credits after it ends", async () => {
    await render(<BillingSidebar state={{ ...complimentary, complimentary: { id: "grant-scale", expiresAt: "2026-10-10T12:00:00Z" } }} />);
    expect(visibleText()).toContain("Available until Oct 10, 2026");
    expect(visibleText()).not.toContain(copy.complimentary.untilRevoked);
    expect(visibleText()).not.toContain("Credits renew on");
  });

  it("shows the saved complimentary plan separately from paid offers and keeps checkout disabled", async () => {
    await render(<><BillingPlanSummary state={complimentary} compact /><CloudPlanPicker
      currentPlan={complimentary.tier}
      currentOffer={complimentary.plan}
      subscription={complimentary.subscription}
      complimentary={complimentary.complimentary}
      billingEnabled
      canChangeSubscription={false}
    /></>);
    const current = container.querySelector('section[aria-label="Current plan"]')!;
    expect(current.textContent).toContain("Scale");
    expect(current.textContent).toContain(copy.complimentary.label);
    expect(current.textContent).not.toContain("$99");
    expect(container.textContent).toContain(copy.complimentary.changeViaSupport);
    expect(container.textContent).not.toContain(copy.plansRoute.changeViaSupport);
    const choose = button("Choose Hobby");
    expect(choose.disabled).toBe(true);
    await act(async () => choose.click());
    expect(mocks.post).not.toHaveBeenCalled();
    expect(container.querySelector(`[aria-label="${copy.pricing.billingInterval}"]`)).toBeNull();
    expect(current.textContent).toContain(copy.complimentary.label);
  });

  it("explains complimentary top-up availability without asking for another subscription", async () => {
    await render(<BillingTopups state={complimentary} />);
    expect(container.textContent).toContain(copy.complimentary.topupsUnavailable);
    expect(container.querySelector('a[href="mailto:support@openship.io"]')).not.toBeNull();
    expect(container.textContent).not.toContain(copy.onboarding.topupsTitle);
    expect(container.textContent).not.toContain(copy.plansRoute.changeViaSupport);
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.post).not.toHaveBeenCalled();
  });
});

describe("customer credit limits", () => {
  it.each([false, true])("shows provider transfer usage with unlimited=%s", async unlimited => {
    const compute = monthlyCompute();
    compute.network = { ...compute.network, included: true, unlimited, status: "active",
      availableBytes: unlimited ? null : 193 * 1024 ** 3,
      periodConsumedBytes: 7 * 1024 ** 3, consumedBytes: 19 * 1024 ** 3 };
    await render(<BillingComputeCoverage state={{ ...paid, compute }} />);
    expect(container.textContent).toContain(unlimited ? copy.capacity.unlimited : "193 GiB available");
    expect(container.textContent).toContain("Used this period: 7 GiB");
    expect(container.textContent).not.toContain("19 GiB");
    expect(container.textContent).not.toContain(copy.compute.transferRecovery);
  });
  it.each(["active", "low", "grace", "blocked"] as const)("uses provider transfer status %s instead of guessing from zero bytes", async status => {
    const compute = monthlyCompute();
    compute.network = { ...compute.network, included: true, purchasedBytes: 1024, status, availableBytes: 0 };
    await render(<BillingComputeCoverage state={{ ...paid, compute }} />);
    expect(container.textContent).toContain(copy.compute.covered);
    expect(container.textContent?.includes(copy.compute.transferRecovery)).toBe(status === "blocked");
  });
  it("does not show unlimited access for expired monthly coverage", async () => {
    const compute = monthlyCompute({ covered: false, status: "expired" });
    compute.network = { ...compute.network, included: true, unlimited: true, status: "inactive", availableBytes: 0 };
    await render(<BillingComputeCoverage state={{ ...paid, compute }} />);
    expect(container.textContent).toContain("0 GiB available");
    expect(container.textContent).toContain(copy.compute.recovery);
    expect(container.textContent).not.toContain(copy.capacity.unlimited);
  });
  it("shows paid monthly coverage without a credit donut or exhausted-balance copy", async () => {
    const monthly = { ...paid, compute: monthlyCompute(), monthlyCreditLimit: null,
      balance: { total: null, quotaLimit: null, quotaUsed: 0, quotaRemaining: null },
      plan: { ...hobby, billingMode: "monthly" as const, monthlyCredits: null } };
    await render(<BillingOverview state={monthly} />);
    expect(visibleText()).toContain(copy.compute.covered);
    expect(visibleText()).toContain("Paid through Nov 1, 2026");
    expect(container.querySelector('[role="meter"][aria-label="Cloud usage"]')).toBeNull();
    expect(container.textContent).not.toContain(copy.creditAlert.exhaustedTitle);
    expect(container.textContent).not.toContain(copy.resourcesGuide.planUsageNote);
    expect(container.textContent).not.toContain("credits left");
    await render(<PlanUsageNote plans={[monthly.plan]} />);
    expect(container.textContent).toContain(copy.compute.features.capacity);
    expect(container.textContent).toContain(copy.compute.features.noCredits);
    expect(container.textContent).not.toContain(copy.resourcesGuide.creditAllowances);
  });
  it("separates retained storage charges from expired compute coverage", async () => {
    const compute = monthlyCompute({ covered: false, status: "storage_payment_required" });
    compute.retention.amountDue = 1.25;
    await render(<BillingOverview state={{ ...paid, compute }} />);
    expect(visibleText()).toContain(copy.compute.needsAttention);
    expect(visibleText()).toContain("Retained storage balance: $1.25");
    expect(visibleText()).not.toContain(copy.creditAlert.exhaustedTitle);
    const details = [...container.querySelectorAll("details")].find(item => item.querySelector("summary")?.textContent?.includes(copy.compute.details))!;
    await act(async () => { details.open = true; });
    expect(visibleText()).toContain("$0.05/GiB-month until deleted");
    expect(visibleText()).toContain("no automatic deletion");
  });
  it("charts CPU time for monthly servers while retaining usage units", async () => {
    mocks.get.mockResolvedValue({ data: { usage: { buckets: [], totals: { credits: 999,
      vcpu_hours: 12.5, gb_hours: 50, disk_io_gb: 1, network_gb: 0.5 } } } });
    await render(<BillingUsage state={{ ...paid, compute: monthlyCompute() }} />);
    expect(visibleText()).toContain(copy.resourceOverview.cpu);
    expect(visibleText()).toContain("12.5");
    expect(visibleText()).toContain(copy.compute.usageIncluded);
    expect(visibleText()).not.toContain(copy.resourcesGuide.selectedRange);
    expect(visibleText()).not.toContain("999");
  });
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
    expect(visibleText()).toContain("$10");
    expect(visibleText()).toContain(copy.topups.allowanceEquivalent);
    expect(visibleText()).not.toMatch(/credits/i);
    expect(container.textContent).toContain("617 credits");
    expect(button(copy.topups.buy).disabled).toBe(false);
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it("leads with resource meters and shows credit accounting only on request", async () => {
    await render(<BillingCapacity state={paid} />);
    expect(visibleText()).toContain(copy.resourcesGuide.includedTitle);
    expect(container.querySelector('[role="meter"][aria-label="Cloud usage"]')?.getAttribute("aria-valuenow")).toBe("25");
    expect(visibleText()).toContain("75% remaining");
    expect(visibleText()).toContain("9 remaining");
    expect(container.querySelector('[role="meter"][aria-label="Projects"]')?.getAttribute("aria-valuenow")).toBe("1");
    expect(visibleText()).not.toMatch(/credits|300 of 1,200/);
    const details = [...container.querySelectorAll("details")].find(item => item.querySelector("summary")?.textContent?.includes(copy.resourcesGuide.usageDetails))!;
    expect(details.open).toBe(false);
    await act(async () => { details.open = true; });
    expect(visibleText()).toContain("900 credits left");
  });
  it("links live usage to its Cloud space without repeating the host measurement in Billing", async () => {
    mocks.usage.mockResolvedValue({ available: true, measuredAt: "2026-10-01T00:00:00Z", reason: null,
      cpuPercent: 10, memoryUsedMb: 512, memoryAvailableMb: 3584,
      diskUsedMb: 2048, diskAvailableMb: 23552, diskTotalMb: 25600, projects: [], sharedDiskMb: null });
    await render(<BillingCapacity state={{ ...paid, workspace: { id: "workspace", name: "Production", serverId: "managed-server" }, capacity: { ...paid.capacity,
      vcpus: { used: 3, max: 4 }, ramMb: { used: 3072, max: 8192 }, diskGb: { used: 96, max: 128 },
      workspaces: { used: 3, max: 6 }, buildMinutes: { used: 14, max: null },
    } }} />);
    expect(mocks.usage).not.toHaveBeenCalled();
    expect(container.querySelector('a[href="/resources?pool=managed-server"]')).not.toBeNull();
    expect(visibleText()).not.toContain("96 GB");
    expect(visibleText()).toContain(copy.resourceOverview.measuredUsage);
    expect(visibleText()).not.toContain("3,000 min");
  });
  it("displays the supplied offer's total capacity without claiming unlimited build time", async () => {
    await render(<PlanResources plan={{ ...hobby, resourceLimits: { ...PLANS.pro.oblienLimits,
      max_total_vcpus: 7, max_total_ram_mb: 10240, max_total_disk_gb: 192 } }} />);
    const valueFor = (label: string) => [...container.querySelectorAll("dt")].find(item => item.textContent === label)?.parentElement?.querySelector("dd")?.textContent;
    expect(valueFor(copy.header.vcpus)).toBe("7");
    expect(valueFor(copy.resourcesGuide.projects)).toBe("10");
    expect(valueFor(copy.capacity.runningServices)).toBe("15");
    expect(visibleText()).not.toContain("No set limit");
    expect(valueFor(copy.header.ram)).toBe("10 GB");
    expect(valueFor(copy.resourcesGuide.storage)).toBe("192 GB");
    expect(valueFor(copy.resourcesGuide.buildTime)).toBeUndefined();
    expect(container.textContent).not.toContain(copy.resourcesGuide.poolHint);
    expect(container.textContent).not.toContain("3,000 min");
    expect(visibleText()).not.toMatch(/credits/i);
    expect(visibleText()).not.toContain(copy.resourcesGuide.perService);
  });
  it("keeps fixed build allowances but omits per-service ceilings from plan cards", async () => {
    await render(<PlanResources plan={{ ...hobby, limits: { ...hobby.limits,
      maxServiceResources: undefined, buildMinutesPerMonth: 3000 } }} />);
    expect(visibleText()).not.toContain("1 vCPU · 1 GB");
    expect(visibleText()).not.toContain("2 vCPU · 8 GB");
    expect(visibleText()).toContain("3,000 min / month");
    expect(visibleText()).not.toContain(copy.resourcesGuide.buildIncluded);
  });
  it("shows annual credits from the paid offer and leaves missing credit amounts unknown", async () => {
    await render(<PlanUsageNote plans={[hobby]} interval="annual" />);
    expect(container.querySelector<HTMLDetailsElement>("details")?.open).toBe(false);
    await act(async () => { container.querySelector<HTMLDetailsElement>("details")!.open = true; });
    expect(visibleText()).toContain("Hobby: 14,555");
    expect(visibleText()).not.toContain("1,234");
    await render(<PlanUsageNote plans={[{ ...hobby, annualCredits: null }]} interval="annual" />);
    expect(container.querySelector('[role="note"] li')?.textContent).toBe("Hobby: —");
  });
  it("uses the same explicit service ceiling in billing when no precomputed machine is supplied", async () => {
    await render(<BillingCapacity state={{ ...paid, plan: { ...hobby,
      limits: { ...hobby.limits, maxServiceResources: { cpuCores: 1, memoryMb: 3072 } } } }} />);
    expect(visibleText()).toContain("3 GB");
    await render(<BillingCapacity state={{ ...paid, plan: { ...hobby,
      limits: { ...hobby.limits, maxServiceResources: undefined } } }} />);
    expect(visibleText()).toContain("1 GB");
    expect(visibleText()).not.toContain("3 GB");
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
    expect(mocks.get).toHaveBeenCalledWith("billing/resources", { params: { workspaceId: undefined } });
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
