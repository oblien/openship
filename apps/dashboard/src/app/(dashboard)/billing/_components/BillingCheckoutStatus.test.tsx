// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { PLANS } from "@repo/core";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { baseDictionary } from "@/i18n";
import { BillingCheckoutStatus } from "./BillingCheckoutStatus";
import { BillingWorkspaceProvider } from "@/components/billing/BillingWorkspaceContext";

const mocks = vi.hoisted(() => ({
  state: vi.fn(),
  checkout: vi.fn(),
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
async function render(props: Parameters<typeof BillingCheckoutStatus>[0], workspaceId?: string) {
  await act(async () =>
    root.render(
      <I18nProvider>
        <BillingWorkspaceProvider workspaceId={workspaceId}><BillingCheckoutStatus {...props} /></BillingWorkspaceProvider>
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
describe("checkout return confirmation", () => {
  it("confirms the selected paid subscription only after its credits are delivered", async () => {
    await render(subscription);
    expect(container.textContent).toContain(copy.active);
    expect(mocks.checkout).toHaveBeenCalledExactlyOnceWith("cs_selected", undefined);
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
  });
  it.each(["refunded", "partially_refunded", "disputed"])(
    "reports %s without showing successful credit delivery",
    async (fulfillmentStatus) => {
      mocks.checkout.mockResolvedValue({ ...paid, fulfillmentStatus });
      await render(subscription);
      expect(container.textContent).toContain(copy.reversed);
      expect(container.querySelector("a")?.href).toBe("mailto:support@openship.io");
    },
  );
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

describe("confirmed Cloud subscription welcome", () => {
  const welcome = baseDictionary.billing.welcome;
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
  const dismiss = () =>
    document.querySelector<HTMLButtonElement>(`button[aria-label="${welcome.dismiss}"]`)!;

  it("celebrates the verified plan with its live allowances and a first-project action", async () => {
    await render(subscription);
    expect(dialog()?.textContent).toContain("Welcome to Launch");
    expect(dialog()?.querySelector("dl")?.textContent).toContain("13");
    expect(dialog()?.querySelector("dl")?.textContent).toContain("7");
    expect(dialog()?.querySelector("dl")?.textContent).toContain("321 min / month");
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
