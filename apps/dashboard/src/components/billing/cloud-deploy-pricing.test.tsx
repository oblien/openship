// @vitest-environment happy-dom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLANS, pricingUi } from "@repo/core";
import { I18nProvider } from "@/components/i18n-provider";
import { ModalProvider } from "@/context/ModalContext";
import { useCloudDeployPricing } from "@/hooks/useCloudDeployPricing";
import { ApiError } from "@/lib/api/client";
import type { BillingState } from "@/lib/api/billing";
import { baseDictionary } from "@/i18n";
import type { ApiPlan } from "./PricingCards";
import { BillingUsage } from "./BillingUsage";
import { BillingCapacity } from "./BillingCapacity";

const mocks = vi.hoisted(() => ({ state: vi.fn(), get: vi.fn(), post: vi.fn(), deploy: vi.fn(), toast: vi.fn() }));
vi.mock("@/lib/api/billing", () => ({ billingApi: { getBillingState: mocks.state } }));
vi.mock("@/lib/api/client", async (original) => ({ ...await original<typeof import("@/lib/api/client")>(), api: { get: mocks.get, post: mocks.post } }));
vi.mock("./UsageChart", () => ({ UsageChart: ({ buckets }: { buckets: unknown }) => <div data-testid="chart">{JSON.stringify(buckets)}</div> }));

const copy = baseDictionary.billing;
const free: BillingState = {
  tier: "free", status: "credit_exhausted", subscription: null,
  currentPeriod: { start: null, end: null },
  balance: { total: 0, quotaLimit: 0, quotaUsed: 0, quotaRemaining: 0 },
  monthlyCreditLimit: 0, overQuota: true, buildTimeMinutes: 0,
  capacity: { buildMinutes: { used: 0, max: 500 }, services: { used: 0, max: 0 }, projects: { used: 1, max: 3 } },
  billing: { enabled: true }, topups: { available: true },
  capabilities: { portal: true, cancellation: false, subscriptionChange: true },
};
const paid: BillingState = {
  ...free, tier: "starter", status: "active", overQuota: false,
  balance: { total: 900_000, quotaLimit: 1_200_000, quotaUsed: 300_000, quotaRemaining: 900_000 },
  monthlyCreditLimit: 1_200_000,
};
const plans: ApiPlan[] = [{
  id: "starter", name: "Hobby", description: "For your next project", popular: false,
  price: { monthly: 1500, annual: 15000 }, listPrice: { monthly: 1500 }, effectivePrice: { monthly: 1500 }, campaign: null,
  monthlyCredits: 1_234_000, annualCredits: 14_555_000, limits: PLANS.starter.limits, features: [], support: "",
}];

function Harness() {
  const showPricing = useCloudDeployPricing();
  const [name, setName] = useState("My configured project");
  const deploy = async () => {
    try { await mocks.deploy(); } catch (error) { if (!showPricing(error)) mocks.toast(error); }
  };
  return <>
    <input aria-label="Project name" value={name} onChange={(event) => setName(event.target.value)} />
    <button onClick={() => {}}>Save configuration</button>
    <button onClick={deploy}>Deploy</button>
  </>;
}

let root: Root;
let container: HTMLDivElement;
let checkoutTab: { opener: unknown; closed: boolean; location: { href: string }; close: ReturnType<typeof vi.fn> };
let open: ReturnType<typeof vi.spyOn>;
const restriction = () => new ApiError(402, "Payment Required", { code: "CLOUD_BILLING_BLOCKED" });
function button(label: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label);
  expect(found, label).toBeDefined();
  return found!;
}
const click = async (label: string) => { await act(async () => button(label).click()); };
const render = async (node = <Harness />) => {
  await act(async () => root.render(<I18nProvider><ModalProvider>{node}</ModalProvider></I18nProvider>));
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.state.mockResolvedValue(free);
  mocks.get.mockResolvedValue({ data: { locale: "en", annual: { enabled: true, monthsFree: 0 }, ui: pricingUi("en"), plans } });
  mocks.deploy.mockRejectedValue(restriction());
  mocks.post.mockResolvedValue({ data: { checkoutUrl: "https://checkout.example.test/session" } });
  checkoutTab = { opener: window, closed: false, location: { href: "about:blank" }, close: vi.fn() };
  open = vi.spyOn(window, "open").mockReturnValue(checkoutTab as unknown as Window);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("deployment plan selection", () => {
  it("waits for Deploy, preserves project settings on dismissal, and allows a later retry", async () => {
    await render();
    await click("Save configuration");
    expect(mocks.state).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await click("Deploy");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(copy.deployGate.description);
    expect(mocks.state).toHaveBeenCalledOnce();
    expect(mocks.post).not.toHaveBeenCalled();
    await click(copy.deployGate.close);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector("input")?.value).toBe("My configured project");
    await click("Deploy");
    expect(mocks.state).toHaveBeenCalledTimes(2);
  });

  it("starts one checkout in a separate tab and waits for an authoritative plan refresh", async () => {
    await render();
    await click("Deploy");
    let resolveCheckout!: (value: unknown) => void;
    mocks.post.mockReturnValueOnce(new Promise((resolve) => { resolveCheckout = resolve; }));
    await act(async () => { button("Choose Hobby").click(); button("Choose Hobby").click(); });
    expect(open).toHaveBeenCalledOnce();
    expect(checkoutTab.opener).toBeNull();
    expect(checkoutTab.location.href).toBe("about:blank");
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.post).toHaveBeenCalledWith("billing/subscription", expect.objectContaining({ planTierId: "starter", interval: "monthly", idempotencyKey: expect.any(String) }));
    await act(async () => resolveCheckout({ data: { checkoutUrl: "https://checkout.example.test/session" } }));
    expect(checkoutTab.location.href).toBe("https://checkout.example.test/session");
    expect(container.querySelector("input")?.value).toBe("My configured project");
    expect(mocks.deploy).toHaveBeenCalledTimes(1);
    await click(copy.deployGate.checkPlan);
    expect(document.body.textContent).toContain(copy.deployGate.pending);
    mocks.state.mockResolvedValue(paid);
    await click(copy.deployGate.checkPlan);
    expect(document.body.textContent).toContain(copy.deployGate.ready);
    await click(copy.deployGate.close);
    mocks.deploy.mockResolvedValueOnce({ deploymentId: "paid-deploy" });
    await click("Deploy");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(mocks.deploy).toHaveBeenCalledTimes(2);
  });

  it("offers a secure checkout link when popups are blocked, without navigating the project", async () => {
    open.mockReturnValue(null);
    const before = window.location.href;
    await render();
    await click("Deploy");
    await click("Choose Hobby");
    const link = document.querySelector<HTMLAnchorElement>('a[href="https://checkout.example.test/session"]');
    expect(link?.target).toBe("_blank");
    expect(link?.rel).toBe("noopener noreferrer");
    expect(window.location.href).toBe(before);
  });

  it("waits for the refreshed entitlement before saying payment is still pending", async () => {
    await render();
    await click("Deploy");
    await click("Choose Hobby");
    let resolveState!: (state: BillingState) => void;
    mocks.state.mockReturnValueOnce(new Promise<BillingState>((resolve) => { resolveState = resolve; }));
    await click(copy.deployGate.checkPlan);
    expect(button(copy.deployGate.checkPlan).disabled).toBe(true);
    expect(document.body.textContent).not.toContain(copy.deployGate.pending);
    await act(async () => resolveState(free));
    expect(document.body.textContent).toContain(copy.deployGate.pending);
  });

  it("retries checkout with the same idempotency key and displays the provider's error", async () => {
    mocks.post.mockRejectedValueOnce(new ApiError(503, "Unavailable", { error: "Checkout temporarily unavailable" }));
    await render();
    await click("Deploy");
    await click("Choose Hobby");
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Checkout temporarily unavailable");
    expect(checkoutTab.close).toHaveBeenCalledOnce();
    await click("Choose Hobby");
    expect(mocks.post.mock.calls[1]![1].idempotencyKey).toBe(mocks.post.mock.calls[0]![1].idempotencyKey);
  });

  it("keeps purchases disabled when billing is not enabled", async () => {
    mocks.state.mockResolvedValue({ ...free, billing: { enabled: false } });
    await render();
    await click("Deploy");
    expect(button("Choose Hobby").disabled).toBe(true);
    expect(document.body.textContent).toContain(copy.plansRoute.billingUnavailable);
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("uses the selected interval's live price and credits while build limits stay monthly", async () => {
    await render();
    await click("Deploy");
    expect(document.body.textContent).toContain("1,234 credits / billing cycle");
    await click(copy.pricing.annual);
    expect(document.body.textContent).toContain("$150");
    expect(document.body.textContent).toContain("14,555 credits / billing cycle");
    expect(document.body.textContent).toContain("3,000 min / month");
    await click("Choose Hobby");
    expect(mocks.post.mock.calls[0]![1].interval).toBe("annual");
  });

  it("allows a permitted deployment without requiring billing-read access", async () => {
    mocks.state.mockRejectedValue(new ApiError(403, "Forbidden", {}));
    mocks.deploy.mockResolvedValue({ deploymentId: "allowed" });
    await render();
    await click("Deploy");
    expect(mocks.state).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("tells a member to ask the owner if the refused deployment needs billing access", async () => {
    mocks.state.mockRejectedValue(new ApiError(403, "Forbidden", {}));
    await render();
    await click("Deploy");
    expect(document.body.textContent).toContain(copy.deployGate.ownerRequired);
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("retains ordinary deployment errors and offers a retry for failed billing reads", async () => {
    mocks.deploy.mockRejectedValueOnce(new ApiError(503, "Unavailable", { code: "OBLIEN_BILLING_UNAVAILABLE" }));
    await render();
    await click("Deploy");
    expect(mocks.toast).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    mocks.state.mockRejectedValueOnce(new Error("Offline"));
    await click("Deploy");
    expect(document.body.textContent).toContain(copy.deployGate.loadError);
    await click(copy.plansRoute.tryAgain);
    expect(button("Choose Hobby").disabled).toBe(false);
  });

  it("closes with Escape and returns keyboard focus to the project", async () => {
    await render();
    button("Deploy").focus();
    await click("Deploy");
    const dialog = document.querySelector<HTMLDivElement>('[role="dialog"]')!;
    expect(document.activeElement).toBe(dialog);
    await act(async () => dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(button("Deploy"));
  });
});

describe("readable Cloud usage", () => {
  it("does not advertise the legacy free build limit as usable Cloud compute", async () => {
    await render(<BillingCapacity state={free} />);
    expect(container.textContent).toContain(copy.onboarding.workspaceDescription);
    expect(container.textContent).toContain(copy.onboarding.planRequired);
    expect(container.textContent).not.toContain("500");
  });
  it("shows actual resource measurements and whole credit totals without fabricated resource costs", async () => {
    mocks.get.mockResolvedValue({ data: { usage: {
      buckets: [{ timestamp: "2026-09-18T00:00:00Z", credits: 125.5 }],
      totals: { vcpu_hours: 2, gb_hours: 4, disk_io_gb: 0.25, network_gb: 1.5, credits: 125.5 },
    } } });
    await render(<BillingUsage state={paid} />);
    expect(container.textContent).not.toContain("125.5");
    expect(container.textContent).toContain("2 vCPU-hours");
    expect(container.textContent).toContain("4 GB-hours");
    expect(container.textContent).toContain("0.25 GB");
    expect(container.textContent).toContain(copy.resourcesGuide.diskHint);
    expect(container.querySelector("table")?.textContent).not.toContain("Credits");
    expect(container.querySelector("table")?.textContent).not.toContain("%");
    const accounting = container.querySelector("details")!;
    expect(accounting.open).toBe(false);
    await act(async () => { accounting.open = true; accounting.dispatchEvent(new Event("toggle")); });
    expect(container.textContent).toContain("125.5");
    const requestedEnd = new Date(mocks.get.mock.calls[0]![1].params.to).getTime();
    expect(requestedEnd).toBeLessThanOrEqual(Date.now());
    expect(requestedEnd).toBeGreaterThan(Date.now() - 10_000);
  });
});
