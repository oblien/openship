// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRICING, actionCreditUnits } from "@repo/core";
import type { ActionBudget as Budget, ActionCreditPurchase } from "@repo/contracts";
import { I18nProvider } from "@/components/i18n-provider";
import { ActionBudget, ActionBudgetDialog } from "./ActionBudget";

const h = vi.hoisted(() => ({
  org: "org-a",
  query: "",
  budget: vi.fn(),
  purchase: vi.fn(),
  checkout: vi.fn(),
  resume: vi.fn(),
  navigate: vi.fn(),
  begin: vi.fn(),
  closeTab: vi.fn(),
  closeDialog: vi.fn(),
}));
vi.mock("@/lib/api/billing", () => ({
  billingApi: {
    getActionsBudget: h.budget,
    getActionsPurchase: h.purchase,
    createActionsCheckout: h.checkout,
    resumeActionsCheckout: h.resume,
  },
}));
vi.mock("@/lib/checkout-navigation", () => ({
  beginCheckoutNavigation: (preserve: boolean) => {
    h.begin(preserve);
    return { navigate: h.navigate, close: h.closeTab };
  },
}));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(h.query) }));
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({
    data: { user: { id: "user-a" }, session: { activeOrganizationId: h.org } },
  }),
}));
vi.mock("@/context/CloudResourceContext", () => ({ useCloudResourceKey: () => "cloud-a" }));

const initial = (): Budget => ({
  currency: "usd",
  unitsPerDollar: 60_000_000,
  purchasesAvailable: false,
  runnersReady: false,
  runnerSetupFailed: false,
  balance: {
    fundedUnits: 0,
    spentUnits: 0,
    availableUnits: 0,
    blocking: true,
    status: "unfunded",
    checkedAt: null,
  },
  pricing: {
    ...PRICING.actions,
    meter: {
      rateCardId: "live-meter",
      cpuUnitsPerMinute: 900000,
      memoryUnitsPerGiBMinute: 120000,
      networkUnitsPerGb: 90000,
      diskUnitsPerGb: 0,
    },
    runners: PRICING.actions.runners.map((r) => ({
      ...r,
      estimatedUnitsPerMinute: actionCreditUnits(r.cpuCores * 1.5 + (r.memoryMb / 1024) * 0.2),
    })),
  },
  purchases: [],
});
let root: Root;
let host: HTMLDivElement;
const render = (dialog = false) =>
  act(async () =>
    root.render(
      <I18nProvider>
        {dialog ? <ActionBudgetDialog onClose={h.closeDialog} /> : <ActionBudget />}
      </I18nProvider>,
    ),
  );
const button = (text: string) =>
  [...document.querySelectorAll("button")].find((node) => node.textContent === text)!;
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  h.org = "org-a";
  h.query = "";
  h.budget.mockResolvedValue(initial());
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("Actions funding UI", () => {
  it("keeps workflow setup open during hosted payment and retains a manual checkout link", async () => {
    h.budget.mockResolvedValue({ ...initial(), purchasesAvailable: true });
    h.checkout.mockResolvedValue({ purchaseId: "acredit_one", checkoutUrl: "https://checkout.stripe.com/saved" });
    h.navigate.mockImplementation((url: string) => url);
    await render(true);
    await act(async () => button("Add $5").click());
    expect(h.begin).toHaveBeenCalledWith(true);
    expect(h.begin.mock.invocationCallOrder[0]).toBeLessThan(h.checkout.mock.invocationCallOrder[0]!);
    expect(document.querySelector('a[href="https://checkout.stripe.com/saved"]')?.getAttribute("target")).toBe("_blank");
    expect(h.closeDialog).not.toHaveBeenCalled();
    await act(async () => button("Back to workflow").click());
    expect(h.closeDialog).toHaveBeenCalledOnce();
  });

  it("closes an unused payment tab on failure and does not expose an invalid payment link", async () => {
    h.budget.mockResolvedValue({ ...initial(), purchasesAvailable: true });
    h.checkout.mockRejectedValueOnce(new Error("Provider unavailable"));
    await render(true);
    await act(async () => button("Add $5").click());
    expect(h.closeTab).toHaveBeenCalledOnce();
    h.checkout.mockResolvedValue({ checkoutUrl: "javascript:invalid" });
    h.navigate.mockImplementationOnce(() => { throw new Error("Invalid checkout URL"); });
    await act(async () => button("Add $5").click());
    expect(document.querySelector('a[href="javascript:invalid"]')).toBeNull();
    expect(h.closeTab).toHaveBeenCalledTimes(2);
  });

  it("shows live VM estimates and one usage balance without a separate transfer allowance", async () => {
    h.budget.mockResolvedValue({
      ...initial(),
      balance: { ...initial().balance, spentUnits: 4000 },
    });
    await render();
    for (const amount of [
      "$0.038",
      "$0.076",
      "$0.152",
      "$0.000067",
      "$0.0015",
      "$0.015 / vCPU-minute",
      "131 min with $5",
    ])
      expect(host.textContent).toContain(amount);
    expect(host.textContent).not.toContain("GiB transfer");
    expect(host.textContent).toContain("including preparation and cleanup");
    await act(async () => button("$20").click());
    expect(host.textContent).toContain("526 min with $20");
    await act(async () => button("$5").click());
    expect(button("Add $5").disabled).toBe(true);
    await act(async () => button("Add $5").click());
    expect(h.checkout).not.toHaveBeenCalled();
    expect(h.purchase).not.toHaveBeenCalled();
  });

  it("reconciles a returned purchase and re-reads the balance without adding funds from URL parameters", async () => {
    let finish!: (value: ActionCreditPurchase) => void;
    h.query = "purchase=acredit_paid&amount=10000&success=true";
    h.purchase.mockReturnValue(
      new Promise<ActionCreditPurchase>((resolve) => {
        finish = resolve;
      }),
    );
    await render();
    expect(h.purchase).toHaveBeenCalledWith("acredit_paid");
    expect(h.budget).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role="status"]')).toBeNull();
    await act(async () =>
      finish({
        id: "acredit_paid",
        priceCents: 500,
        fundedUnits: 300_000_000,
        status: "completed",
        checkedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      }),
    );
    expect(h.budget).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
      "Funds added. Preparing your Cloud runners…",
    );
    const available = [...host.querySelectorAll("section")].find((node) =>
      node.textContent?.includes("Available balance"),
    )!;
    expect(available.textContent).toContain("$0.00");
    expect(available.textContent).not.toContain("$5.00");
  });

  it("does not display an unavailable provider balance as zero", async () => {
    h.budget.mockResolvedValue({
      ...initial(),
      balance: {
        ...initial().balance,
        availableUnits: null,
        spentUnits: null,
        status: "unavailable",
      },
      pricing: {
        ...initial().pricing,
        meter: null,
        runners: initial().pricing.runners.map((r) => ({ ...r, estimatedUnitsPerMinute: null })),
      },
    });
    await render();
    expect(host.textContent).toContain("Balance is temporarily unavailable");
    expect(host.textContent).toContain("Live rates are unavailable");
    expect(button("Add $5").disabled).toBe(true);
  });

  it("reuses the payment attempt after a lost response and shows the funded workflow entry", async () => {
    h.budget.mockResolvedValue({
      ...initial(),
      purchasesAvailable: true,
      runnersReady: true,
      balance: { ...initial().balance, blocking: false, availableUnits: 300000000 },
    });
    h.checkout.mockRejectedValueOnce(new Error("Temporary failure")).mockResolvedValueOnce({
      purchaseId: "acredit_one",
      checkoutUrl: "https://checkout.stripe.com/saved",
    });
    await render();
    expect(host.querySelector('a[href="/actions/new"]')?.textContent).toBe("Create workflow");
    await act(async () => button("Add $5").click());
    await act(async () => button("Add $5").click());
    expect(h.checkout.mock.calls[0]).toEqual(h.checkout.mock.calls[1]);
    expect(h.navigate).toHaveBeenCalledWith("https://checkout.stripe.com/saved");
  });

  it("distinguishes a funded but paused budget from a balance that needs topping up", async () => {
    h.budget.mockResolvedValue({
      ...initial(),
      runnersReady: true,
      balance: { ...initial().balance, blocking: true, availableUnits: 300000000 },
    });
    await render();
    expect(host.querySelector('[role="status"]')?.textContent).toContain(
      "Cloud Actions is paused. Your balance is saved",
    );
    expect(host.querySelector('a[href="/actions/new"]')).toBeNull();
    expect(host.textContent).toContain("$5.00");
  });

  it("does not navigate to a previous organization's checkout after switching accounts", async () => {
    let finish!: (value: { purchaseId: string; checkoutUrl: string }) => void;
    h.budget.mockResolvedValue({ ...initial(), purchasesAvailable: true });
    h.checkout.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await render();
    await act(async () => button("Add $5").click());
    expect(h.checkout).toHaveBeenCalledTimes(1);
    h.org = "org-b";
    await render();
    await act(async () =>
      finish({ purchaseId: "acredit_old", checkoutUrl: "https://checkout.stripe.com/old" }),
    );
    expect(h.navigate).not.toHaveBeenCalled();
  });
});
