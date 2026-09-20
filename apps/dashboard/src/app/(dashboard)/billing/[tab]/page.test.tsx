import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const mocks = vi.hoisted(() => ({ get: vi.fn(), getDeploymentInfo: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/session", () => ({ getDeploymentInfo: mocks.getDeploymentInfo }));
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

function loadPage() {
  return BillingTabPage({ params: Promise.resolve({ tab: "overview" }), searchParams: Promise.resolve({}) });
}

describe("billing page failure recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDeploymentInfo.mockResolvedValue({ selfHosted: false });
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
  ])("classifies HTTP %s / %s as %s", async (status, code, reason) => {
    mocks.get.mockRejectedValue(new ServerApiError(status, "Request failed", { code }));

    const page = await loadPage();

    expect(page.type).toBe(BillingUnavailable);
    expect(page.props.reason).toBe(reason);
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });

  it("does not call an empty response or transport failure disabled billing", async () => {
    mocks.get.mockResolvedValueOnce({});
    expect((await loadPage()).props.reason).toBe("billing-unreachable");

    mocks.get.mockRejectedValueOnce(new Error("fetch failed"));
    expect((await loadPage()).props.reason).toBe("billing-unreachable");
  });

  it("renders billing state when purchases are disabled", async () => {
    const state = { tier: "free", billing: { enabled: false, status: "coming_soon" } };
    mocks.get.mockResolvedValue({ data: state });

    const page = await loadPage();
    const overview = page.props.children.find((child: unknown) => isValidElement(child) && child.type === BillingOverview) as ReactElement<{ state: unknown }>;

    expect(overview.props.state).toBe(state);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it.each([
    [403, "cloud_not_connected", "cloud-not-connected"],
    [401, "cloud_session_expired", "cloud-session-expired"],
  ])("preserves the local Cloud connection recovery for %s / %s", async (status, code, reason) => {
    mocks.getDeploymentInfo.mockResolvedValue({ selfHosted: true });
    mocks.get.mockRejectedValue(new ServerApiError(status, "Request failed", { code }));

    expect((await loadPage()).props.reason).toBe(reason);
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])("checks local connection state after a provider failure (connected=%s)", async (connected) => {
    mocks.getDeploymentInfo.mockResolvedValue({ selfHosted: true });
    mocks.get.mockRejectedValueOnce(new ServerApiError(502, "Bad Gateway", {})).mockResolvedValueOnce({ connected });

    expect((await loadPage()).props.reason).toBe(connected ? "cloud-unreachable" : "cloud-not-connected");
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
