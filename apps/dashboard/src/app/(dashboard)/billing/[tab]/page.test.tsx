import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const mocks = vi.hoisted(() => ({ get: vi.fn(), getDeploymentInfo: vi.fn(), getSession: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/session", () => ({ getDeploymentInfo: mocks.getDeploymentInfo, getSession: mocks.getSession }));
vi.mock("@/lib/server/api", () => ({
  serverApi: { get: mocks.get },
  ServerApiError: class extends Error {
    constructor(public status: number, public statusText: string, public body: unknown) {
      super(statusText);
    }
  },
}));
vi.mock("@/context/CloudContext", () => ({
  useCloud: () => ({ startConnect: vi.fn(), connecting: false, refresh: vi.fn() }),
}));

import BillingTabPage from "./page";
import { ServerApiError } from "@/lib/server/api";
import { I18nProvider } from "@/components/i18n-provider";
import { BillingOverview } from "@/components/billing/BillingOverview";
import { BillingUnavailable } from "../_components/BillingUnavailable";
import { BillingPlansRoute } from "../_components/BillingPlansRoute";
import { BillingPageView, type BillingView } from "../_components/BillingViewContext";
import { BillingCheckoutStatus } from "../_components/BillingCheckoutStatus";
import { CloudBillingLink } from "@/components/billing/CloudBillingLink";
import BillingPage from "../page";

const free = {
  tier: "free", subscription: null, billing: { enabled: true },
  balance: { total: 0, quotaLimit: 0, quotaUsed: 0, quotaRemaining: 0 },
};

function loadPage() {
  return BillingTabPage({ params: Promise.resolve({ tab: "overview" }), searchParams: Promise.resolve({}) });
}

async function unavailablePage() {
  const page = await loadPage();
  const unavailable = findElement<{ reason: string }>(page, BillingUnavailable)!;
  expect(unavailable).toBeDefined();
  return unavailable;
}

function findElement<P>(node: ReactNode, type: unknown): ReactElement<P> | undefined {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<{ children?: ReactNode }>(child)) continue;
    if (child.type === type) return child as ReactElement<P>;
    const match = findElement<P>(child.props.children, type);
    if (match) return match;
  }
}

describe("billing page failure recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDeploymentInfo.mockResolvedValue({ selfHosted: false });
    mocks.getSession.mockResolvedValue({ user: { id: "user-a" }, session: { activeOrganizationId: "org-a" } });
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it.each([
    [500, undefined, "billing-unreachable"],
    [404, undefined, "billing-unreachable"],
    [501, undefined, "billing-unreachable"],
    [502, "OBLIEN_ENTITLEMENT_MISMATCH", "billing-unreachable"],
    [503, "OBLIEN_BILLING_UNAVAILABLE", "billing-unreachable"],
    [503, "BILLING_NOT_CONFIGURED", "billing-not-configured"],
    [503, "OBLIEN_WEBHOOK_NOT_CONFIGURED", "billing-not-configured"],
    [503, "OBLIEN_DEFAULT_POLICY_REQUIRED", "billing-not-configured"],
    [503, "OBLIEN_NAMESPACE_POLICY_REQUIRED", "billing-not-configured"],
    [403, "BILLING_NOT_ENABLED", "saas-not-enabled"],
    [403, "FORBIDDEN", "billing-forbidden"],
    [401, undefined, "billing-sign-in-required"],
    [429, undefined, "billing-unreachable"],
    [400, "CLOUD_WORKSPACE_REQUIRED", "workspace-required"],
  ])("classifies HTTP %s / %s as %s", async (status, code, reason) => {
    mocks.get.mockRejectedValue(new ServerApiError(status, "Request failed", { code }));

    const page = await unavailablePage();

    expect(page.type).toBe(BillingUnavailable);
    expect(page.props.reason).toBe(reason);
    expect(mocks.get).toHaveBeenCalledTimes(code === "CLOUD_WORKSPACE_REQUIRED" ? 2 : 1);
  });

  it("does not call an empty response or transport failure disabled billing", async () => {
    mocks.get.mockResolvedValueOnce({});
    expect((await unavailablePage()).props.reason).toBe("billing-unreachable");

    mocks.get.mockRejectedValueOnce(new Error("fetch failed"));
    expect((await unavailablePage()).props.reason).toBe("billing-unreachable");
  });

  it("renders billing state when purchases are disabled", async () => {
    const state = { ...free, tier: "starter", billing: { enabled: false, status: "coming_soon" } };
    mocks.get.mockResolvedValue({ data: state });

    const page = await loadPage();
    const overview = findElement<{ state: unknown }>(page, BillingOverview)!;

    expect(overview.props.state).toBe(state);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("passes the complimentary entitlement through to the plan comparison", async () => {
    const complimentary = { id: "grant-scale", expiresAt: null };
    mocks.get.mockResolvedValue({ data: { tier: "team", subscription: null, complimentary, billing: { enabled: true }, capabilities: { subscriptionChange: false } } });

    const page = await BillingTabPage({ params: Promise.resolve({ tab: "plans" }), searchParams: Promise.resolve({}) });
    const plans = findElement<Record<string, unknown>>(page, BillingPlansRoute)!;

    expect(plans.props).toMatchObject({ currentPlan: "team", subscription: null, complimentary, canChangeSubscription: false });
  });

  it.each([
    [403, "cloud_not_connected", "cloud-not-connected"],
    [401, "cloud_session_expired", "cloud-session-expired"],
  ])("preserves the local Cloud connection recovery for %s / %s", async (status, code, reason) => {
    mocks.getDeploymentInfo.mockResolvedValue({ selfHosted: true });
    mocks.get.mockRejectedValue(new ServerApiError(status, "Request failed", { code }));

    expect((await unavailablePage()).props.reason).toBe(reason);
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])("checks local connection state after a provider failure (connected=%s)", async (connected) => {
    mocks.getDeploymentInfo.mockResolvedValue({ selfHosted: true });
    mocks.get.mockRejectedValueOnce(new ServerApiError(502, "Bad Gateway", {})).mockResolvedValueOnce({ connected });

    expect((await unavailablePage()).props.reason).toBe(connected ? "cloud-unreachable" : "cloud-not-connected");
    expect(mocks.get).toHaveBeenLastCalledWith("cloud/status", { cache: "no-store" });
  });

  it("logs only the HTTP status and code, without serializing provider or session data", async () => {
    mocks.get.mockRejectedValue(new ServerApiError(503, "private message", {
      code: "BILLING_NOT_CONFIGURED", token: "private-token", error: "private-provider-body",
    }));

    await loadPage();

    expect(console.warn).toHaveBeenCalledExactlyOnceWith("[billing] GET /billing/state failed", {
      status: 503, code: "BILLING_NOT_CONFIGURED",
    });
  });

  it("keeps the selected workspace available during billing recovery", async () => {
    mocks.get.mockRejectedValue(new ServerApiError(503, "Unavailable", {}));
    const page = await BillingTabPage({ params: Promise.resolve({ tab: "overview" }), searchParams: Promise.resolve({ workspaceId: "cws_production" }) });
    expect(findElement<{ reason: string }>(page, BillingUnavailable)?.props.reason).toBe("billing-unreachable");
    expect(mocks.get).toHaveBeenCalledExactlyOnceWith("billing/state?workspaceId=cws_production", { cache: "no-store", timeout: 45_000 });
  });

  it.each(["overview", "usage", "topups", "payment", "invoices"])("takes new customers from %s directly to plans", async tab => {
    mocks.get.mockResolvedValue({ data: free });
    await expect(BillingTabPage({ params: Promise.resolve({ tab }), searchParams: Promise.resolve({}) }))
      .rejects.toMatchObject({ digest: "NEXT_REDIRECT;replace;/billing/plans;307;" });
  });

  it("shows only the plan comparison before the first subscription", async () => {
    mocks.get.mockResolvedValue({ data: free });
    const page = await BillingTabPage({ params: Promise.resolve({ tab: "plans" }), searchParams: Promise.resolve({}) });
    expect(findElement(page, BillingPlansRoute)).toBeDefined();
    expect(findElement(page, BillingOverview)).toBeUndefined();
    expect(findElement<{ view: BillingView }>(page, BillingPageView)?.props.view).toMatchObject({
      contextKey: "user-a:org-a", plansOnly: true,
    });
    expect(mocks.get).toHaveBeenCalledExactlyOnceWith("billing/state", { cache: "no-store", timeout: 45_000 });
  });

  it.each([
    { subscription: { status: "canceled" } },
    { tier: "team", subscription: null, complimentary: { id: "grant", expiresAt: null } },
    { balance: { ...free.balance, quotaUsed: 10 } },
    { balance: { ...free.balance, quotaLimit: 20, quotaRemaining: 20 } },
    { capacity: { workspaces: { used: 1, max: 1 } } },
    { workspace: { id: "cws-existing", name: "Production", provisioned: true } },
  ])("keeps billing history accessible for earlier customers: %j", async history => {
    mocks.get.mockResolvedValue({ data: { ...free, ...history } });
    const page = await loadPage();
    expect(findElement(page, BillingOverview)).toBeDefined();
    expect(findElement<{ view: BillingView }>(page, BillingPageView)?.props.view.plansOnly).toBe(false);
  });

  it("preserves checkout and organization parameters when redirecting a new customer", async () => {
    const query = { organizationId: "org-a", workspaceId: "cws-a", checkout: "success", session_id: "checkout-a", tier: "starter", offer: "offer-a", interval: "monthly" };
    mocks.get.mockResolvedValue({ data: { ...free, workspace: { id: "cws-a" } } });
    const href = `/billing/plans?${new URLSearchParams(query)}`;
    await expect(BillingTabPage({ params: Promise.resolve({ tab: "overview" }), searchParams: Promise.resolve(query) }))
      .rejects.toMatchObject({ digest: `NEXT_REDIRECT;replace;${href};307;` });

    const page = await BillingTabPage({ params: Promise.resolve({ tab: "plans" }), searchParams: Promise.resolve(query) });
    expect(findElement<Record<string, unknown>>(page, BillingCheckoutStatus)?.props).toMatchObject({
      kind: "subscription", checkoutId: "checkout-a", expectedTier: "starter", expectedOffer: "offer-a", expectedInterval: "monthly",
    });
  });

  it("preserves scope and checkout details at the billing entry point", async () => {
    const query = { organizationId: "org-a", workspaceId: "cws-a", topup: "success", session_id: "checkout-a" };
    await expect(BillingPage({ searchParams: Promise.resolve(query) }))
      .rejects.toMatchObject({ digest: `NEXT_REDIRECT;replace;/billing/overview?${new URLSearchParams(query)};307;` });
  });

  it("waits for the requested organization instead of reading another organization's billing", async () => {
    const page = await BillingTabPage({ params: Promise.resolve({ tab: "usage" }), searchParams: Promise.resolve({ organizationId: "org-b" }) });
    expect(findElement<Record<string, unknown>>(page, CloudBillingLink)?.props.organizationId).toBe("org-b");
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it.each(["starter", "free"])("opens an allocated server before a draft when multiple subscriptions need selection (saved tier=%s)", async planTierId => {
    const state = { ...free, tier: "starter", workspace: { id: "cws-production" } };
    mocks.get.mockRejectedValueOnce(new ServerApiError(400, "Choose server", { code: "CLOUD_WORKSPACE_REQUIRED" }))
      .mockResolvedValueOnce({ servers: [
        { id: "migration-source", managed: null },
        { id: "draft", managed: { id: "cws-draft", planTierId: "free", resources: null } },
        { id: "production", managed: { id: "cws-production", planTierId, resources: { cpuCores: 2, memoryMb: 8192, diskMb: 25600 } } },
      ] }).mockResolvedValueOnce({ data: state });
    const page = await BillingTabPage({ params: Promise.resolve({ tab: "overview" }), searchParams: Promise.resolve({ organizationId: "org-a" }) });
    expect(findElement<{ state: unknown }>(page, BillingOverview)?.props.state).toBe(state);
    expect(findElement<{ view: BillingView }>(page, BillingPageView)?.props.view).toMatchObject({ workspaceId: "cws-production", organizationId: "org-a" });
    expect(mocks.get).toHaveBeenNthCalledWith(2, "system/servers/destinations", { cache: "no-store" });
    expect(mocks.get).toHaveBeenLastCalledWith("billing/state?workspaceId=cws-production", { cache: "no-store", timeout: 45_000 });
    expect(mocks.get).toHaveBeenCalledTimes(3);
  });

  it("opens the first draft for plan selection if no server has been purchased", async () => {
    mocks.get.mockRejectedValueOnce(new ServerApiError(400, "Choose server", { code: "CLOUD_WORKSPACE_REQUIRED" }))
      .mockResolvedValueOnce({ servers: [
        { managed: { id: "cws-draft", planTierId: "free", resources: null } },
        { managed: { id: "cws-second", planTierId: "free", resources: null } },
      ] }).mockResolvedValueOnce({ data: { ...free, workspace: { id: "cws-draft" } } });
    await expect(loadPage()).rejects.toMatchObject({ digest: "NEXT_REDIRECT;replace;/billing/plans?workspaceId=cws-draft;307;" });
  });

  it.each([
    { workspaceId: "cws-missing" },
    { checkout: "success", session_id: "checkout-a" },
    { topup: "success" },
  ])("never guesses another scope for explicit selections or checkout reconciliation: %j", async query => {
    mocks.get.mockRejectedValueOnce(new ServerApiError(400, "Choose server", { code: "CLOUD_WORKSPACE_REQUIRED" }));
    const page = await BillingTabPage({ params: Promise.resolve({ tab: "overview" }), searchParams: Promise.resolve(query) });
    expect(findElement<{ reason: string }>(page, BillingUnavailable)?.props.reason).toBe("workspace-required");
    expect(mocks.get).toHaveBeenCalledOnce();
  });

  it("leaves self-hosted Cloud scope resolution with its connected account", async () => {
    mocks.getDeploymentInfo.mockResolvedValue({ selfHosted: true });
    mocks.get.mockRejectedValueOnce(new ServerApiError(400, "Choose server", { code: "CLOUD_WORKSPACE_REQUIRED" }));
    expect((await unavailablePage()).props.reason).toBe("workspace-required");
    expect(mocks.get).toHaveBeenCalledOnce();
  });

  it("does not copy malformed error codes into logs", async () => {
    mocks.get.mockRejectedValue(new ServerApiError(500, "Error", { code: "invalid\nprivate-data" }));

    await loadPage();

    expect(console.warn).toHaveBeenCalledExactlyOnceWith("[billing] GET /billing/state failed", {
      status: 500, code: "BILLING_API_ERROR",
    });
  });
});

describe("billing recovery messages", () => {
  it("offers retry for a temporary failure without inventing an organization switch", () => {
    const html = renderToStaticMarkup(<I18nProvider><BillingUnavailable reason="billing-unreachable" /></I18nProvider>);

    expect(html).toContain("temporarily unavailable");
    expect(html).toContain("Try again");
    expect(html).not.toContain("Contact your administrator to enable it");
    expect(html).not.toContain("Reconnect");
  });

  it("provides a sign-in link when the session cannot be verified", () => {
    const html = renderToStaticMarkup(<I18nProvider><BillingUnavailable reason="billing-sign-in-required" /></I18nProvider>);

    expect(html).toContain('href="/login"');
    expect(html).toContain("Sign in to view billing");
  });
});
