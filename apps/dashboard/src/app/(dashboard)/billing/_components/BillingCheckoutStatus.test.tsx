// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { PLANS } from "@repo/core";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { baseDictionary } from "@/i18n";
import { BillingCheckoutStatus } from "./BillingCheckoutStatus";
import { BillingWorkspaceProvider } from "@/components/billing/BillingWorkspaceContext";
import { monthlyCompute } from "../../../../../test/helpers/monthly-billing";

const mocks = vi.hoisted(() => ({
  state: vi.fn(),
  checkout: vi.fn(),
  server: vi.fn(),
  router: { refresh: vi.fn() },
  platform: { selfHosted: false, deployMode: "docker" },
  session: { user: { id: "user_1" }, session: { activeOrganizationId: "org_1" } },
}));
vi.mock("next/navigation", () => ({ useRouter: () => mocks.router }));
vi.mock("@/context/PlatformContext", () => ({ usePlatform: () => mocks.platform }));
vi.mock("@/context/AuthContext", () => ({ useAuth: () => ({ user: mocks.session.user }) }));
vi.mock("@/lib/auth-client", () => ({ useSession: () => ({ data: mocks.session }) }));
vi.mock("@/lib/api/billing", () => ({
  billingApi: { getBillingState: mocks.state, getCheckoutStatus: mocks.checkout },
}));
vi.mock("@/lib/api/system", () => ({ systemApi: { getServerById: mocks.server } }));
const copy = baseDictionary.billing.checkout;
const paid = {
  id: "cs_selected",
  kind: "subscription",
  status: "complete",
  paymentStatus: "paid",
  fulfillmentStatus: "completed",
  fulfilled: true,
  creditsGranted: 1_200_000,
};
const state = {
  tier: "starter",
  status: "active",
  subscription: { interval: "monthly" },
  plan: {
    id: "starter",
    name: "Launch",
    monthlyCredits: 1_200_000,
    limits: {
      ...PLANS.starter.limits,
      maxProjects: 13,
      runningServices: 7,
      buildMinutesPerMonth: 321,
    },
  },
  capacity: { projects: { used: 0 } },
};
let container: HTMLDivElement;
let root: Root;
async function render(props: Parameters<typeof BillingCheckoutStatus>[0], workspaceId?: string, organizationId?: string) {
  await act(async () =>
    root.render(
      <I18nProvider>
        <BillingWorkspaceProvider workspaceId={workspaceId} organizationId={organizationId}><BillingCheckoutStatus {...props} /></BillingWorkspaceProvider>
      </I18nProvider>,
    ),
  );
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  mocks.platform.selfHosted = false;
  mocks.platform.deployMode = "docker";
  mocks.session.user.id = "user_1";
  mocks.session.session.activeOrganizationId = "org_1";
  mocks.state.mockResolvedValue(state);
  mocks.checkout.mockResolvedValue(paid);
  mocks.server.mockResolvedValue(readyServer);
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
const subscription = {
  kind: "subscription" as const,
  checkoutId: "cs_selected",
  expectedTier: "starter",
  expectedInterval: "monthly" as const,
};
const monthlyState = {
  ...state,
  workspace: { id: "cws_selected", serverId: "srv_selected", name: "Launch server", provisioned: true },
  subscription: { interval: "monthly", billingMode: "monthly", offerReference: "openship:starter:v9" },
  compute: monthlyCompute(),
  plan: { ...state.plan, billingMode: "monthly", monthlyCredits: null },
};
const readyServer = {
  id: "srv_selected",
  managed: { id: "cws_selected", serverId: "srv_selected", state: "running", operation: null },
};
describe("checkout return confirmation", () => {
  it("confirms a saved metered subscription only after its credits are delivered", async () => {
    await render(subscription);
    expect(container.textContent).toContain(copy.active);
    expect(mocks.checkout).toHaveBeenCalledExactlyOnceWith("cs_selected", undefined);
    expect(mocks.server).not.toHaveBeenCalled();
  });
  it.each(["paid", "no_payment_required"])("confirms monthly capacity with zero credits after verified fulfillment (%s)", async paymentStatus => {
    mocks.state.mockResolvedValue(monthlyState);
    mocks.checkout.mockResolvedValue({ ...paid, paymentStatus, creditsGranted: 0 });
    await render({ ...subscription, expectedOffer: "openship:starter:v9" });
    expect(container.textContent).toContain(copy.active);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(mocks.router.refresh).toHaveBeenCalledOnce();
  });
  it.each([
    undefined,
    monthlyCompute({ covered: false, status: "pending" }),
    monthlyCompute({ covered: false, status: "expired" }),
    monthlyCompute({ billingMode: "payg" }),
  ])("waits for committed monthly coverage before confirming zero-credit payment: %j", async compute => {
    mocks.state.mockResolvedValueOnce({ ...monthlyState, compute }).mockResolvedValue(monthlyState);
    mocks.checkout.mockResolvedValue({ ...paid, creditsGranted: 0 });
    await render({ ...subscription, expectedOffer: "openship:starter:v9" });
    expect(container.textContent).toContain(copy.checking);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(container.textContent).toContain(copy.active);
  });
  it("does not use unrelated monthly coverage or a return URL as payment proof", async () => {
    mocks.state.mockResolvedValue(monthlyState);
    mocks.checkout.mockResolvedValue({ ...paid, creditsGranted: 0 });
    await render({ ...subscription, expectedOffer: "openship:starter:custom-v2:other" });
    expect(container.textContent).toContain(copy.checking);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    mocks.checkout.mockResolvedValue({ ...paid, paymentStatus: "unpaid", creditsGranted: 0 });
    await render({ ...subscription, expectedOffer: "openship:starter:v9" });
    expect(container.textContent).toContain(copy.checking);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
  it("does not confirm a monthly refund or top-up from existing capacity coverage", async () => {
    mocks.state.mockResolvedValue(monthlyState);
    mocks.checkout.mockResolvedValue({ ...paid, creditsGranted: 0, fulfillmentStatus: "refunded" });
    await render({ ...subscription, expectedOffer: "openship:starter:v9" });
    expect(container.textContent).toContain(copy.reversed);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    mocks.checkout.mockResolvedValue({ ...paid, kind: "topup", creditsGranted: 0 });
    await render({ kind: "topup", checkoutId: "cs_selected" });
    expect(container.textContent).toContain(copy.checking);
    expect(container.textContent).not.toContain(copy.topupComplete);
  });
  it("scopes checkout verification to the selected subscription and discards a previous workspace's success", async () => {
    await render(subscription, "cws_production");
    expect(mocks.state).toHaveBeenLastCalledWith("cws_production");
    expect(mocks.checkout).toHaveBeenLastCalledWith("cs_selected", "cws_production");
    expect(container.textContent).toContain(copy.active);

    mocks.checkout.mockResolvedValue({ ...paid, paymentStatus: "unpaid", fulfilled: false });
    await render(subscription, "cws_staging");
    expect(mocks.state).toHaveBeenLastCalledWith("cws_staging");
    expect(mocks.checkout).toHaveBeenLastCalledWith("cs_selected", "cws_staging");
    expect(container.textContent).toContain(copy.checking);
    expect(container.textContent).not.toContain(copy.active);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
  it.each([undefined, "cs_selected"])(
    "does not reuse an existing active subscription to confirm unpaid checkout %s",
    async (checkoutId) => {
      mocks.checkout.mockResolvedValue({
        ...paid,
        paymentStatus: "unpaid",
        fulfilled: false,
        fulfillmentStatus: "pending",
        creditsGranted: 0,
      });
      await render({ ...subscription, checkoutId });
      expect(container.textContent).toContain(copy.checking);
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(container.textContent).toContain(copy.pending);
      expect(container.textContent).not.toContain(copy.active);
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    },
  );
  it("keeps a verified payment pending until fulfillment finishes", async () => {
    mocks.checkout.mockResolvedValueOnce({
      ...paid,
      fulfilled: false,
      fulfillmentStatus: "pending",
      creditsGranted: 0,
    });
    await render(subscription);
    expect(container.textContent).toContain(copy.checking);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(container.textContent).toContain(copy.active);
  });
  it("confirms top-ups from the specific credited payment", async () => {
    mocks.checkout.mockResolvedValue({ ...paid, kind: "topup", creditsGranted: 5_000_000 });
    await render({ kind: "topup", checkoutId: "cs_selected" });
    expect(container.textContent).toContain(copy.topupComplete);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(mocks.server).not.toHaveBeenCalled();
  });
  it.each(["refunded", "partially_refunded", "disputed", "reversed"])(
    "reports %s without showing successful credit delivery",
    async (fulfillmentStatus) => {
      mocks.checkout.mockResolvedValue({ ...paid, fulfillmentStatus });
      await render(subscription);
      expect(container.textContent).toContain(copy.reversed);
      expect(container.querySelector("a")?.href).toBe("mailto:support@openship.io");
    },
  );
  it("reports a superseded checkout without waiting for fulfillment or welcoming again", async () => {
    mocks.checkout.mockResolvedValue({ ...paid, fulfillmentStatus: "superseded", fulfilled: false });
    await render(subscription);
    expect(container.textContent).toContain(copy.paidFailed);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(mocks.checkout).toHaveBeenCalledOnce();
  });
  it("rejects a different kind of checkout", async () => {
    mocks.checkout.mockResolvedValue({ ...paid, kind: "topup" });
    await render(subscription);
    expect(container.textContent).toContain(copy.failed);
  });
  it("shows a useful provider failure after retrying instead of inventing payment success", async () => {
    mocks.checkout.mockRejectedValue(new Error("Billing is unavailable. Reference: support-123."));
    await render(subscription);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(container.textContent).toContain(copy.pending);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("support-123");
  });
});

describe("paid server delivery", () => {
  const setupLink = () => container.querySelector('a[href="/resources?pool=srv_selected&tab=activity"]');
  const recheck = async () => {
    const button = Array.from(container.querySelectorAll("button")).find(item => item.textContent === copy.checkAgain);
    expect(button).toBeDefined();
    await act(async () => button!.click());
  };

  beforeEach(() => {
    mocks.state.mockResolvedValue(monthlyState);
    mocks.checkout.mockResolvedValue({ ...paid, creditsGranted: 0 });
  });

  it("waits for setup to finish even when the provider VM is allocated and running", async () => {
    mocks.server.mockResolvedValueOnce({
      ...readyServer,
      managed: { ...readyServer.managed, operation: { status: "running" } },
    });
    await render(subscription, "cws_selected");
    expect(container.textContent).toContain(copy.provisioning);
    expect(setupLink()).not.toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(mocks.router.refresh).not.toHaveBeenCalled();
    expect(mocks.server).toHaveBeenCalledExactlyOnceWith("srv_selected");

    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(container.textContent).toContain(copy.active);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(mocks.state).toHaveBeenLastCalledWith("cws_selected");
    expect(mocks.checkout).toHaveBeenLastCalledWith("cs_selected", "cws_selected");
  });

  it.each(["creating", "unreachable", "stopped"])("does not treat a completed operation as proof the server is ready (%s)", async state => {
    mocks.server.mockResolvedValue({
      ...readyServer,
      managed: { ...readyServer.managed, state, operation: { status: "succeeded" } },
    });
    await render(subscription);
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(container.textContent).toContain(copy.setupPending);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    const calls = mocks.server.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(mocks.server).toHaveBeenCalledTimes(calls);
  });

  it.each([
    { state: "running", operation: { status: "failed" } },
    { state: "failed", operation: null },
    { state: "error", operation: null },
  ])("shows paid setup failure with the existing recovery page: %j", async failure => {
    mocks.server.mockResolvedValue({ ...readyServer, managed: { ...readyServer.managed, ...failure } });
    await render(subscription);
    expect(container.textContent).toContain(copy.setupFailed);
    expect(container.textContent).not.toContain(copy.failed);
    expect(setupLink()).not.toBeNull();
    expect(container.querySelector('a[href="mailto:support@openship.io"]')).not.toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(mocks.server).toHaveBeenCalledOnce();

    mocks.server.mockResolvedValue(readyServer);
    await recheck();
    expect(mocks.checkout).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain(copy.active);
  });

  it("keeps a paid order pending on a server outage and rechecks payment before recovery", async () => {
    mocks.server.mockRejectedValue(new Error("Server status unavailable. Reference: setup-123."));
    await render(subscription);
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(container.textContent).toContain(copy.setupPending);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("setup-123");
    expect(setupLink()).not.toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    mocks.server.mockResolvedValue(readyServer);
    mocks.checkout.mockResolvedValue({ ...paid, fulfillmentStatus: "refunded" });
    const serverCalls = mocks.server.mock.calls.length;
    await recheck();
    expect(container.textContent).toContain(copy.reversed);
    expect(mocks.server).toHaveBeenCalledTimes(serverCalls);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("stops readiness polling when the checkout is refunded", async () => {
    mocks.server.mockResolvedValue({ ...readyServer, managed: { ...readyServer.managed, state: "creating" } });
    await render(subscription);
    expect(container.textContent).toContain(copy.provisioning);
    mocks.checkout.mockResolvedValue({ ...paid, fulfillmentStatus: "refunded" });
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(container.textContent).toContain(copy.reversed);
    expect(mocks.server).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("does not confirm a ready server after its monthly coverage expires", async () => {
    mocks.server.mockResolvedValueOnce({ ...readyServer, managed: { ...readyServer.managed, state: "creating" } });
    await render(subscription);
    mocks.state.mockResolvedValue({ ...monthlyState, compute: monthlyCompute({ covered: false, status: "expired" }) });
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(container.textContent).toContain(copy.paidPending);
    expect(mocks.server).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it.each([
    undefined,
    { ...monthlyState.workspace, serverId: undefined },
    { ...monthlyState.workspace, id: "cws_other" },
  ])("requires the purchased workspace and server identity: %j", async workspace => {
    mocks.state.mockResolvedValue({ ...monthlyState, workspace });
    await render(subscription, "cws_selected");
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(container.textContent).toContain(copy.setupPending);
    expect(mocks.server).not.toHaveBeenCalled();
    expect(setupLink()).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it.each([
    { ...readyServer, id: "srv_other" },
    { ...readyServer, managed: null },
    { ...readyServer, managed: { ...readyServer.managed, id: "cws_other" } },
    { ...readyServer, managed: { ...readyServer.managed, serverId: "srv_other" } },
  ])("rejects a ready response for a different destination: %j", async server => {
    mocks.server.mockResolvedValue(server);
    await render(subscription);
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(container.textContent).toContain(copy.setupPending);
    expect(setupLink()).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it.each(["organization", "workspace", "checkout"])("discards an in-flight server response when the %s changes", async context => {
    let resolveServer!: (value: typeof readyServer) => void;
    mocks.server.mockReturnValueOnce(new Promise(resolve => { resolveServer = resolve; }));
    await render(subscription, "cws_selected");
    expect(container.textContent).toContain(copy.provisioning);

    mocks.checkout.mockResolvedValue({ ...paid, paymentStatus: "unpaid", fulfilled: false });
    if (context === "organization") mocks.session.session.activeOrganizationId = "org_other";
    await render(
      context === "checkout" ? { ...subscription, checkoutId: "cs_other" } : subscription,
      context === "workspace" ? "cws_other" : "cws_selected",
    );
    await act(async () => resolveServer(readyServer));
    expect(container.textContent).not.toContain(copy.active);
    expect(setupLink()).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("keeps verified payment distinct from a failed entitlement read", async () => {
    mocks.state.mockRejectedValue(new Error("Billing state unavailable"));
    await render(subscription);
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(container.textContent).toContain(copy.paidPending);
    expect(mocks.server).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("reports paid fulfillment failure without offering another checkout", async () => {
    mocks.checkout.mockResolvedValue({ ...paid, fulfillmentStatus: "failed", fulfilled: false });
    await render(subscription);
    expect(container.textContent).toContain(copy.paidFailed);
    expect(mocks.server).not.toHaveBeenCalled();
    expect(container.querySelectorAll("a")).toHaveLength(1);
    expect(container.querySelector("a")?.href).toBe("mailto:support@openship.io");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe("confirmed Cloud subscription welcome", () => {
  const welcome = baseDictionary.billing.welcome;
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
  const dismiss = () =>
    document.querySelector<HTMLButtonElement>(`button[aria-label="${welcome.dismiss}"]`)!;

  it("welcomes the purchased managed server with its saved custom capacity and scoped links", async () => {
    mocks.state.mockResolvedValue({ ...monthlyState, plan: { ...monthlyState.plan, name: "Custom",
      resourceLimits: { max_total_vcpus: 6, max_total_ram_mb: 24576, max_total_disk_gb: 180 } } });
    mocks.checkout.mockResolvedValue({ ...paid, creditsGranted: 0 });
    await render(subscription, "cws_selected", "org_1");
    expect(dialog()?.textContent).toContain("Launch server is ready");
    expect(dialog()?.textContent).toContain("Your Custom plan is active");
    const capacity = [...dialog()!.querySelectorAll("dl dd")].map(node => node.textContent);
    expect(capacity).toEqual(["6", "24 GB", "180 GB"]);
    expect(dialog()?.querySelector('a[href="/resources?pool=srv_selected"]')).not.toBeNull();
    expect(dialog()?.querySelector('a[href="/billing/overview?workspaceId=cws_selected&organizationId=org_1"]')).not.toBeNull();
    expect(dialog()?.querySelector('a[href="/library"]')).toBeNull();
  });

  it("shows a welcome for each purchased server, while remembering the first server's dismissal", async () => {
    mocks.state.mockResolvedValue(monthlyState);
    mocks.checkout.mockResolvedValue({ ...paid, creditsGranted: 0 });
    await render(subscription, "cws_selected");
    await act(async () => dismiss().click());
    expect(dialog()).toBeNull();
    mocks.state.mockResolvedValue({ ...monthlyState,
      workspace: { ...monthlyState.workspace, id: "cws_second", serverId: "srv_second", name: "Second server" } });
    mocks.checkout.mockResolvedValue({ ...paid, id: "cs_second", creditsGranted: 0 });
    mocks.server.mockResolvedValue({ id: "srv_second", managed: { ...readyServer.managed, id: "cws_second", serverId: "srv_second" } });
    await render({ ...subscription, checkoutId: "cs_second" }, "cws_second");
    expect(dialog()?.textContent).toContain("Second server is ready");
    expect(dialog()?.querySelector('a[href="/resources?pool=srv_second"]')).not.toBeNull();
    await act(async () => dismiss().click());
    mocks.state.mockResolvedValue(monthlyState);
    mocks.checkout.mockResolvedValue({ ...paid, creditsGranted: 0 });
    mocks.server.mockResolvedValue(readyServer);
    await render(subscription, "cws_selected");
    expect(dialog()).toBeNull();
  });

  it("welcomes the verified plan without inventing capacity from quota-only metadata", async () => {
    await render(subscription);
    expect(dialog()?.textContent).toContain("Welcome to Launch");
    expect(dialog()?.querySelector("dl")).toBeNull();
    expect(dialog()?.textContent).not.toContain("321 min / month");
    expect(dialog()?.querySelector('a[href="/library"]')).not.toBeNull();
    expect(dialog()?.querySelector('a[href="/billing/overview"]')).not.toBeNull();
    expect(mocks.router.refresh).toHaveBeenCalledOnce();
  });

  it("opens existing projects when the workspace already has them", async () => {
    mocks.state.mockResolvedValue({ ...state, capacity: { projects: { used: 2 } } });
    await render(subscription);
    expect(dialog()?.querySelector('a[href="/projects"]')).not.toBeNull();
  });

  it.each([
    { ...paid, status: "open" },
    { ...paid, fulfillmentStatus: "pending", fulfilled: false },
    { ...paid, creditsGranted: 0 },
    { ...paid, id: "cs_other" },
    { ...paid, status: "expired" },
  ])("does not congratulate an incomplete or mismatched checkout: %j", async (checkout) => {
    mocks.checkout.mockResolvedValue(checkout);
    await render(subscription);
    expect(dialog()).toBeNull();
    expect(container.textContent).not.toContain(copy.active);
  });

  it.each([
    { ...state, tier: "pro" },
    { ...state, status: "paused" },
    { ...state, subscription: { interval: "annual" } },
  ])("waits for the selected entitlement, then shows one welcome: %j", async (pendingState) => {
    mocks.state.mockResolvedValueOnce(pendingState);
    await render(subscription);
    expect(dialog()).toBeNull();
    expect(mocks.router.refresh).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(mocks.router.refresh).toHaveBeenCalledOnce();
  });

  it.each([
    { selfHosted: true, deployMode: "docker" },
    { selfHosted: false, deployMode: "desktop" },
  ])("keeps the welcome out of local and desktop dashboards: %j", async (platform) => {
    Object.assign(mocks.platform, platform);
    await render(subscription);
    expect(container.textContent).toContain(copy.active);
    expect(dialog()).toBeNull();
  });

  it("remembers dismissal across remounts, but allows a later checkout", async () => {
    await render(subscription);
    await act(async () => dismiss().click());
    expect(dialog()).toBeNull();
    await act(async () => root.render(null));
    await render(subscription);
    expect(dialog()).toBeNull();
    mocks.checkout.mockResolvedValue({ ...paid, id: "cs_next" });
    await render({ ...subscription, checkoutId: "cs_next" });
    expect(dialog()).not.toBeNull();
  });

  it("waits for a new checkout instead of reusing the previous confirmation", async () => {
    await render(subscription);
    expect(dialog()).not.toBeNull();
    mocks.checkout.mockReturnValue(new Promise(() => {}));
    await render({ ...subscription, checkoutId: "cs_next" });
    expect(dialog()).toBeNull();
    expect(container.textContent).toContain(copy.checking);
  });

  it("drops the previous workspace's confirmation on an organization switch", async () => {
    await render(subscription);
    mocks.session.session.activeOrganizationId = "org_other";
    mocks.checkout.mockReturnValue(new Promise(() => {}));
    await render(subscription);
    expect(dialog()).toBeNull();
    expect(container.textContent).toContain(copy.checking);
  });

  it("traps keyboard focus, closes on Escape, and restores the previous focus", async () => {
    const previous = document.createElement("button");
    document.body.append(previous);
    previous.focus();
    await render(subscription);
    expect(document.activeElement).toBe(dialog());
    const links = dialog()!.querySelectorAll<HTMLAnchorElement>("a");
    links[links.length - 1]!.focus();
    await act(async () =>
      links[links.length - 1]!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
      ),
    );
    expect(document.activeElement).toBe(dismiss());
    await act(async () =>
      dismiss().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(previous);
    previous.remove();
  });

  it("still dismisses when browser storage is blocked", async () => {
    await render(subscription);
    const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Blocked");
    });
    await act(async () => dismiss().click());
    expect(dialog()).toBeNull();
    storage.mockRestore();
  });

  it("shows only one welcome under React's effect replay", async () => {
    await act(async () =>
      root.render(
        <StrictMode>
          <I18nProvider>
            <BillingCheckoutStatus {...subscription} />
          </I18nProvider>
        </StrictMode>,
      ),
    );
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    await act(async () => dismiss().click());
    expect(dialog()).toBeNull();
  });
});
