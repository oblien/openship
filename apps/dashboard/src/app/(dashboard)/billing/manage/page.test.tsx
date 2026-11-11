// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PRICING } from "@repo/core";
import type { ManagementState } from "@repo/contracts";
import ManagePage from "./page";
import { I18nProvider } from "@/components/i18n-provider";
import { baseDictionary } from "@/i18n";
import { PlatformProvider } from "@/context/PlatformContext";

const h = vi.hoisted(() => ({
  org: "org-one",
  query: "",
  get: vi.fn(),
  purchase: vi.fn(),
  confirm: vi.fn(),
  cancel: vi.fn(),
  resumeCheckout: vi.fn(),
  portal: vi.fn(),
  setActive: vi.fn(),
  setOrg: vi.fn(),
  destinations: vi.fn(),
  replace: vi.fn(),
}));
vi.mock("@/lib/api/system", () => ({ systemApi: { listServerDestinations: h.destinations } }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: h.replace }),
  useSearchParams: () => new URLSearchParams(h.query),
  usePathname: () => "/billing/manage",
}));
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: "owner" }, session: { activeOrganizationId: h.org } } }),
  authClient: { organization: { setActive: h.setActive } },
}));
vi.mock("@/lib/api/client", async (original) => ({
  ...(await original<typeof import("@/lib/api/client")>()),
  setActiveOrganizationId: h.setOrg,
}));
vi.mock("@/context/CloudResourceContext", () => ({ useCloudResourceKey: () => "cloud" }));
vi.mock("@/lib/api/management", () => ({ managementApi: h }));
let root: Root, host: HTMLDivElement;
let state: ManagementState;
const render = () =>
  act(async () =>
    root.render(
      <I18nProvider>
        <PlatformProvider selfHosted={false}>
          <ManagePage />
        </PlatformProvider>
      </I18nProvider>,
    ),
  );
function button(text: string, target: ParentNode = host) {
  const result = [...target.querySelectorAll("button")].find(
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
  h.setActive.mockResolvedValue({ error: null });
  h.destinations.mockResolvedValue({ servers: [] });
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

it("activates the purchased organization's Manage page before reading billing", async () => {
  const navigate = vi.spyOn(window.location, "assign").mockImplementation(() => {});
  h.query = "organizationId=org-two&checkout=success&plan=priority&tab=payment";
  await render();
  expect(h.get).not.toHaveBeenCalled();
  expect(h.setActive).toHaveBeenCalledWith({ organizationId: "org-two" });
  expect(navigate).toHaveBeenCalledWith(
    "/billing/manage?checkout=success&plan=priority&tab=payment&organizationId=org-two",
  );
});

it("does not show another account's management state when organization activation is forbidden", async () => {
  const navigate = vi.spyOn(window.location, "assign").mockImplementation(() => {});
  h.setActive.mockResolvedValue({ error: { message: "forbidden" } });
  h.query = "organizationId=org-foreign&checkout=success";
  await render();
  expect(h.get).not.toHaveBeenCalled();
  expect(h.setOrg).not.toHaveBeenCalled();
  expect(navigate).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
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
  h.query = "tab=payment";
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
  expect(host.textContent).toContain("1 / 2");
  expect(button("Resume renewal").disabled).toBe(false);
});

function activateManagement(connectedServers = 2) {
  state = {
    ...state,
    active: true,
    connectedServers,
    serverLimit: 2,
    subscription: {
      plan: "priority",
      servers: 2,
      baseIncluded: false,
      priceCents: 2000,
      periodEnd: "2026-12-08T00:00:00Z",
      cancelAtPeriodEnd: false,
      status: "active",
    },
  };
}

it("adds slots without a plan picker and confirms the exact quoted price only once", async () => {
  activateManagement();
  const server = {
    id: "external",
    name: "Production server",
    isLocal: false,
    managed: null,
    sshHost: "192.0.2.10",
    sshUser: "root",
    sshPort: 22,
    projectCount: 3,
  };
  h.destinations.mockResolvedValue({
    servers: [
      server,
      { ...server, id: "cloud", name: "Cloud space", managed: { id: "cloud-plan" } },
      { ...server, id: "local", name: "Local host", isLocal: true },
      { ...server, id: "import", name: "Migration source", purpose: "migration_source" },
    ],
  });
  h.purchase.mockResolvedValue({
    kind: "quote",
    quoteId: "upgrade-four",
    monthlyCents: 2600,
    amountDueNow: 137,
    effectiveAt: null,
    url: null,
  });
  h.confirm.mockImplementation(async () => {
    state = {
      ...state,
      serverLimit: 4,
      subscription: { ...state.subscription!, servers: 4, priceCents: 2600 },
    };
    return state;
  });
  await render();
  expect(host.querySelector("h1")?.textContent).toBe("Openship Manage");
  expect(host.querySelector('a[href="/servers/external"]')?.textContent).toContain(
    "Production server",
  );
  expect(host.textContent).not.toMatch(/Cloud space|Local host|Migration source/);
  expect(host.querySelector('[role="radiogroup"]')).toBeNull();
  expect(h.get).toHaveBeenCalledOnce();
  expect(h.destinations).toHaveBeenCalledOnce();
  await click(baseDictionary.billing.managementDetail.addServer);
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog).not.toBeNull();
  const input = dialog.querySelector<HTMLInputElement>('input[type="number"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "2");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(dialog.querySelector('[role="radiogroup"]')).toBeNull();
  await act(async () => {
    await vi.waitFor(() => expect(h.purchase).toHaveBeenLastCalledWith(expect.objectContaining({ servers: 4 })));
  });
  expect(dialog.textContent).toContain("$1.37");
  expect(h.purchase).toHaveBeenLastCalledWith({
    plan: "priority",
    servers: 4,
    idempotencyKey: expect.any(String),
  });
  expect(h.confirm).not.toHaveBeenCalled();
  await act(async () => {
    const checkout = button(baseDictionary.billing.managementDetail.checkout, dialog);
    checkout.click();
    checkout.click();
  });
  expect(h.confirm).toHaveBeenCalledExactlyOnceWith("upgrade-four");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(host.textContent).toContain("2 / 4");
  expect(host.querySelector('a[href="/servers/new"]')?.textContent).toContain(
    baseDictionary.billing.managementDetail.addServer,
  );
});

it("keeps an empty paid plan on its detail page and offers the normal server connection form", async () => {
  activateManagement(0);
  await render();
  expect(host.querySelector("h1")?.textContent).toBe("Openship Manage");
  expect(host.textContent).toContain(baseDictionary.billing.managementDetail.empty);
  expect(host.textContent).toContain("0 / 2");
  expect(host.querySelector('a[href="/servers/new"]')?.textContent).toContain(
    baseDictionary.billing.managementDetail.addServer,
  );
  expect(host.querySelector('[role="radiogroup"]')).toBeNull();
  expect(h.purchase).not.toHaveBeenCalled();
});

it("compares a downgrade with the current plan and keeps paid access until its effective date", async () => {
  activateManagement();
  h.purchase.mockResolvedValue({
    kind: "quote",
    quoteId: "downgrade-basic",
    monthlyCents: 500,
    amountDueNow: 0,
    effectiveAt: "2026-12-08T00:00:00Z",
    url: null,
  });
  h.confirm.mockImplementation(async () => {
    state = {
      ...state,
      change: { status: "scheduled", effectiveAt: "2026-12-08T00:00:00Z", paymentUrl: null },
    };
    return state;
  });
  await render();
  await click(baseDictionary.billing.workspaces.changePlan);
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  await act(async () =>
    dialog.querySelector<HTMLInputElement>('input[aria-label="Basic"]')!.click(),
  );
  expect(dialog.textContent).toContain("Priority · $20");
  expect(dialog.textContent).toContain("Basic · $5");
  expect(dialog.textContent).toContain("-$15");
  await act(async () => button("Review change", dialog).click());
  expect(h.purchase).toHaveBeenCalledExactlyOnceWith({
    plan: "basic",
    servers: 2,
    idempotencyKey: expect.any(String),
  });
  expect(h.confirm).not.toHaveBeenCalled();
  await act(async () => button("Confirm change", dialog).click());
  expect(h.confirm).toHaveBeenCalledExactlyOnceWith("downgrade-basic");
  expect(host.textContent).toContain("2 / 2");
  expect(host.textContent).toContain("$20");
  expect(host.textContent).toContain("scheduled");
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
    h.query = "tab=payment";
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

it("keeps the Manage payment controls in its own payments tab", async () => {
  activateManagement();
  await render();
  expect(host.textContent).not.toContain("Payment details & invoices");
  h.query = "tab=payment";
  await render();
  expect(host.textContent).toContain("Payment details & invoices");
  expect(host.textContent).not.toContain(baseDictionary.billing.managementDetail.empty);
});
it("shows an unfinished Manage purchase as a named pending plan with recovery actions", async () => {
  state.pendingCheckout = true;
  await render();
  expect(host.querySelector("h1")?.textContent).toBe("Openship Manage");
  expect(host.textContent).toContain(baseDictionary.billing.hub.paymentRequired);
  expect(button("Resume checkout")).toBeDefined();
  expect(host.querySelector('[role="radiogroup"]')).toBeNull();
});
