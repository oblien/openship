// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PRICING } from "@repo/core";
import type { ManagementState } from "@repo/contracts";
import ManagePage from "./page";

const h = vi.hoisted(() => ({
  org: "org-one",
  query: "",
  get: vi.fn(),
  purchase: vi.fn(),
  confirm: vi.fn(),
  cancel: vi.fn(),
  resumeCheckout: vi.fn(),
  portal: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(h.query) }));
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: "owner" }, session: { activeOrganizationId: h.org } } }),
}));
vi.mock("@/context/CloudResourceContext", () => ({ useCloudResourceKey: () => "cloud" }));
vi.mock("@/lib/api/management", () => ({ managementApi: h }));
let root: Root, host: HTMLDivElement;
let state: ManagementState;
const render = () => act(async () => root.render(<ManagePage />));
function button(text: string) {
  const result = [...host.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === text,
  );
  expect(result, text).toBeDefined();
  return result!;
}
const click = (text: string) => act(async () => button(text).click());
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.org = "org-one";
  h.query = "";
  state = {
    pricing: PRICING.management,
    purchasesAvailable: true,
    cloudIncluded: false,
    active: false,
    serverLimit: 0,
    connectedServers: 0,
    pendingCheckout: false,
    subscription: null,
    change: null,
  };
  h.get.mockImplementation(async () => structuredClone(state));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keeps the purchase key after a lost response and waits for quote confirmation", async () => {
  h.purchase.mockRejectedValueOnce(new Error("Connection lost"));
  h.purchase.mockResolvedValueOnce({
    kind: "quote",
    quoteId: "quote-one",
    monthlyCents: 500,
    amountDueNow: 100,
    effectiveAt: new Date().toISOString(),
    url: null,
  });
  await render();
  await click("Continue to checkout");
  expect(host.textContent).toContain("Connection lost");
  await click("Continue to checkout");
  expect(h.purchase.mock.calls[1][0]).toEqual(h.purchase.mock.calls[0][0]);
  expect(host.textContent).toContain("$1 due now");
  expect(h.confirm).not.toHaveBeenCalled();
  let finish!: (value: ManagementState) => void;
  h.confirm.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () => {
    button("Confirm change").click();
    button("Confirm change").click();
  });
  expect(h.confirm).toHaveBeenCalledTimes(1);
  expect(button("Confirm change").disabled).toBe(true);
  await act(async () => finish(state));
  expect(host.textContent).not.toContain("Review your change");
});

it("requires confirmation before cancellation and keeps the paid allowance visible", async () => {
  state.active = true;
  state.serverLimit = 2;
  state.connectedServers = 1;
  state.subscription = {
    servers: 2,
    baseIncluded: false,
    priceCents: 500,
    periodEnd: new Date(Date.now() + 86400000).toISOString(),
    cancelAtPeriodEnd: false,
    status: "active",
  };
  h.cancel.mockImplementation(async () => {
    state.subscription!.cancelAtPeriodEnd = true;
    return state;
  });
  await render();
  await click("Cancel renewal");
  expect(h.cancel).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Your apps and data keep running");
  await click("Confirm cancellation");
  expect(h.cancel).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("1of 2 servers");
  expect(button("Resume renewal").disabled).toBe(false);
});

it("discards a previous organization's late checkout response", async () => {
  let finish!: (value: unknown) => void;
  h.purchase.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const redirect = vi.spyOn(window.location, "assign").mockImplementation(() => {});
  await render();
  await click("Continue to checkout");
  h.org = "org-two";
  await render();
  await act(async () =>
    finish({ kind: "checkout", url: "https://checkout.stripe.com/old-account" }),
  );
  expect(redirect).not.toHaveBeenCalled();
  expect(button("Continue to checkout").disabled).toBe(false);
});

it.each(["resumeCheckout", "portal"] as const)(
  "does not follow a stale %s link after switching organizations",
  async (method) => {
    state.pendingCheckout = method === "resumeCheckout";
    state.subscription = {
      servers: 2,
      baseIncluded: false,
      priceCents: 500,
      periodEnd: new Date(Date.now() + 86400000).toISOString(),
      cancelAtPeriodEnd: false,
      status: "active",
    };
    let finish!: (value: unknown) => void;
    h[method].mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const redirect = vi.spyOn(window.location, "assign").mockImplementation(() => {});
    await render();
    await click(method === "resumeCheckout" ? "Resume checkout" : "Payment details & invoices");
    h.org = "org-two";
    state.pendingCheckout = false;
    state.subscription = null;
    await render();
    await act(async () =>
      finish({
        url: "https://checkout.stripe.com/old-account",
        portalUrl: "https://billing.stripe.com/old-account",
      }),
    );
    expect(redirect).not.toHaveBeenCalled();
    expect(button("Continue to checkout").disabled).toBe(false);
  },
);

it("preserves the website's Priority choice and waits for checkout confirmation", async () => {
  h.query = "plan=priority";
  h.purchase.mockResolvedValue({
    kind: "quote",
    quoteId: "priority",
    monthlyCents: 2000,
    url: null,
  });
  await render();
  expect(host.querySelector<HTMLInputElement>('input[value="priority"]')?.checked).toBe(true);
  expect(h.purchase).not.toHaveBeenCalled();
  await click("Continue to checkout");
  expect(h.purchase).toHaveBeenCalledWith(expect.objectContaining({ plan: "priority" }));
});

it("requires another choice if the requested management plan is no longer offered", async () => {
  h.query = "plan=priority";
  state.pricing = { ...state.pricing, priorityMonthlyCents: undefined };
  await render();
  expect(host.textContent).toContain("The selected plan is no longer available");
  expect(button("Continue to checkout").disabled).toBe(true);
  await click("Continue to checkout");
  expect(h.purchase).not.toHaveBeenCalled();
  await act(async () => host.querySelector<HTMLInputElement>('input[value="basic"]')!.click());
  expect(button("Continue to checkout").disabled).toBe(false);
});
