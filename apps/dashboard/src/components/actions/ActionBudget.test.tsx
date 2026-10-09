// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRICING } from "@repo/core";
import type { ActionBudget as Budget, ActionCreditPurchase } from "@repo/contracts";
import { I18nProvider } from "@/components/i18n-provider";
import { ActionBudget } from "./ActionBudget";

const h = vi.hoisted(() => ({
  org: "org-a",
  query: "",
  budget: vi.fn(),
  purchase: vi.fn(),
  checkout: vi.fn(),
  resume: vi.fn(),
  navigate: vi.fn(),
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
  beginCheckoutNavigation: () => ({ navigate: h.navigate }),
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
  balance: { fundedUnits: 0, spentUnits: 0, reservedUnits: 0, availableUnits: 0, balanceUnits: 0 },
  pricing: PRICING.actions,
  purchases: [],
});
let root: Root;
let host: HTMLDivElement;
const render = () =>
  act(async () =>
    root.render(
      <I18nProvider>
        <ActionBudget />
      </I18nProvider>,
    ),
  );
const button = (text: string) =>
  [...host.querySelectorAll("button")].find((node) => node.textContent === text)!;
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
  it("shows exact sub-cent rates and usage with included transfer while purchases are unavailable", async () => {
    h.budget.mockResolvedValue({
      ...initial(),
      balance: { ...initial().balance, spentUnits: 4000 },
    });
    await render();
    for (const amount of [
      "$0.004",
      "$0.008",
      "$0.016",
      "$0.000067",
      "25 GiB",
      "100 GiB",
      "250 GiB",
      "500 GiB",
    ])
      expect(host.textContent).toContain(amount);
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
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Funds added");
    const available = [...host.querySelectorAll("section")].find((node) =>
      node.textContent?.includes("Available for jobs"),
    )!;
    expect(available.textContent).toContain("$0.00");
    expect(available.textContent).not.toContain("$5.00");
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
