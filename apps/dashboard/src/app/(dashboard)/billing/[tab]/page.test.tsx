import { errorReporter, type ErrorEvent } from "@repo/core/diagnostics";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const mocks = vi.hoisted(() => ({ get: vi.fn(), getDeploymentInfo: vi.fn(), getSession: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/session", () => ({
  getDeploymentInfo: mocks.getDeploymentInfo,
  getSession: mocks.getSession,
}));
vi.mock("@/lib/server/api", () => ({
  serverApi: { get: mocks.get },
  ServerApiError: class extends Error {
    constructor(
      public status: number,
      public statusText: string,
      public body: unknown,
    ) {
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
import { BillingUnavailable } from "../_components/BillingUnavailable";
import { CloudBillingLink } from "@/components/billing/CloudBillingLink";
import BillingPage from "../page";
import { BillingHome } from "@/components/billing/BillingHome";
import { ManagedServerPurchase } from "@/components/servers/managed/ManagedServerPurchase";
import ResourcesPage from "../../resources/page";

function findElement<P>(node: ReactNode, type: unknown): ReactElement<P> | undefined {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<{ children?: ReactNode }>(child)) continue;
    if (child.type === type) return child as ReactElement<P>;
    const match = findElement<P>(child.props.children, type);
    if (match) return match;
  }
}
const load = (tab = "overview", query: Record<string, string> = { workspaceId: "cws-a" }) =>
  BillingTabPage({ params: Promise.resolve({ tab }), searchParams: Promise.resolve(query) });
const diagnostics: ErrorEvent[] = [];
beforeEach(async () => {
  await errorReporter.flush();
  diagnostics.length = 0;
  errorReporter.setEnabled(true);
  errorReporter.setSink((events) => {
    diagnostics.push(...events);
  });
  vi.clearAllMocks();
  mocks.getDeploymentInfo.mockResolvedValue({ selfHosted: false });
  mocks.getSession.mockResolvedValue({
    user: { id: "user-a" },
    session: { activeOrganizationId: "org-a" },
  });
  mocks.get.mockResolvedValue({
    data: { workspace: { id: "cws-a", serverId: "server-a" }, tier: "starter" },
  });
});
afterEach(async () => {
  await errorReporter.flush();
  errorReporter.setEnabled(false);
  vi.restoreAllMocks();
});

it.each([
  [500, undefined, "billing-unreachable"],
  [404, undefined, "billing-unreachable"],
  [502, "OBLIEN_ENTITLEMENT_MISMATCH", "billing-unreachable"],
  [503, "BILLING_NOT_CONFIGURED", "billing-not-configured"],
  [503, "OBLIEN_WEBHOOK_NOT_CONFIGURED", "billing-not-configured"],
  [503, "OBLIEN_DEFAULT_POLICY_REQUIRED", "billing-not-configured"],
  [503, "OBLIEN_NAMESPACE_POLICY_REQUIRED", "billing-not-configured"],
  [403, "BILLING_NOT_ENABLED", "saas-not-enabled"],
  [403, "FORBIDDEN", "billing-forbidden"],
  [401, undefined, "billing-sign-in-required"],
  [400, "CLOUD_WORKSPACE_REQUIRED", "workspace-required"],
])("keeps scoped failure recovery for HTTP %s / %s", async (status, code, reason) => {
  mocks.get.mockRejectedValue(new ServerApiError(status as number, "Request failed", { code }));
  const page = await load();
  expect(findElement<{ reason: string }>(page, BillingUnavailable)?.props.reason).toBe(reason);
  expect(mocks.get).toHaveBeenCalledOnce();
});
it.each([
  [403, "cloud_not_connected", "cloud-not-connected"],
  [401, "cloud_session_expired", "cloud-session-expired"],
])("preserves local Cloud recovery for %s / %s", async (status, code, reason) => {
  mocks.getDeploymentInfo.mockResolvedValue({ selfHosted: true });
  mocks.get.mockRejectedValue(new ServerApiError(status as number, "Failure", { code }));
  expect(findElement<{ reason: string }>(await load(), BillingUnavailable)?.props.reason).toBe(
    reason,
  );
});
it.each([true, false])(
  "checks local connection after a provider failure (connected=%s)",
  async (connected) => {
    mocks.getDeploymentInfo.mockResolvedValue({ selfHosted: true });
    mocks.get
      .mockRejectedValueOnce(new ServerApiError(502, "Failure", {}))
      .mockResolvedValueOnce({ connected });
    expect(findElement<{ reason: string }>(await load(), BillingUnavailable)?.props.reason).toBe(
      connected ? "cloud-unreachable" : "cloud-not-connected",
    );
  },
);
it("logs normalized failure metadata without provider credentials", async () => {
  mocks.get.mockRejectedValue(
    new ServerApiError(503, "private-provider-message", {
      code: "BILLING_NOT_CONFIGURED",
      token: "private-token",
    }),
  );
  await load();
  await errorReporter.flush();
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({
    context: { statusCode: 503, code: "BILLING_NOT_CONFIGURED" },
  });
  expect(JSON.stringify(diagnostics)).not.toMatch(/private-token|private-provider-message/);
});
it.each(["overview", "usage", "payment", "invoices", "topups"])(
  "resolves scoped %s into that plan, without another billing layout",
  async (tab) => {
    const expectedTab = tab === "invoices" ? "payment" : tab;
    await expect(load(tab)).rejects.toMatchObject({
      digest: `NEXT_REDIRECT;replace;/resources?pool=server-a${expectedTab === "overview" ? "" : `&tab=${expectedTab}`};307;`,
    });
    expect(mocks.get).toHaveBeenCalledExactlyOnceWith("billing/state?workspaceId=cws-a", {
      cache: "no-store",
      timeout: 45_000,
    });
  },
);
it.each(["overview", "usage", "payment", "invoices", "topups"])(
  "returns unscoped %s to plan cards without guessing a subscription",
  async (tab) => {
    await expect(load(tab, { organizationId: "org-a" })).rejects.toMatchObject({
      digest: "NEXT_REDIRECT;replace;/billing?organizationId=org-a;307;",
    });
    expect(mocks.get).not.toHaveBeenCalled();
  },
);
it("opens an existing plan comparison as a modal on its page", async () => {
  await expect(load("plans")).rejects.toMatchObject({
    digest: "NEXT_REDIRECT;replace;/resources?changePlan=1&pool=server-a;307;",
  });
});
it("does not redirect a mismatched billing response into another subscription", async () => {
  mocks.get.mockResolvedValue({
    data: { workspace: { id: "cws-other", serverId: "private-other" } },
  });
  expect(findElement(await load(), BillingUnavailable)).toBeDefined();
});
it.each(["overview", "usage", "payment", "plans", "invoices"])(
  "clears removed draft selections on %s without replaying purchase",
  async (tab) => {
    mocks.get.mockRejectedValue(
      new ServerApiError(404, "Removed", { code: "CLOUD_WORKSPACE_NOT_FOUND" }),
    );
    await expect(
      load(tab, {
        workspaceId: "cws-removed",
        checkout: "success",
        session_id: "old",
        startCheckout: "1",
      }),
    ).rejects.toMatchObject({ digest: "NEXT_REDIRECT;replace;/billing;307;" });
  },
);
it.each(["overview", "plans", "invoices"])(
  "preserves receipt reconciliation through the %s alias",
  async (tab) => {
    const query = {
      workspaceId: "cws-a",
      organizationId: "org-a",
      checkout: "success",
      session_id: "receipt-a",
      tier: "starter",
      offer: "saved-offer",
      interval: "monthly",
      newServer: "1",
    };
    const params = new URLSearchParams(query);
    params.delete("workspaceId");
    params.delete("newServer");
    params.set("pool", "server-a");
    if (tab === "invoices") params.set("tab", "payment");
    await expect(load(tab, query)).rejects.toMatchObject({
      digest: `NEXT_REDIRECT;replace;/resources?${params};307;`,
    });
    expect(mocks.get).toHaveBeenCalledOnce();
  },
);
it("keeps earlier paid plans accessible while new purchases are disabled", async () => {
  mocks.get.mockResolvedValue({
    data: { workspace: { id: "cws-a", serverId: "server-a" }, billing: { enabled: false } },
  });
  await expect(load()).rejects.toMatchObject({
    digest: "NEXT_REDIRECT;replace;/resources?pool=server-a;307;",
  });
});
it("opens new plan purchases without loading an existing subscription", async () => {
  const page = await load("plans", {
    newServer: "1",
    workspaceId: "cws-existing",
    plan: "starter",
    startCheckout: "1",
    checkoutIntent: "72e918ec-8d9c-4b81-bf43-7a5790ca239a",
  });
  expect(findElement<Record<string, unknown>>(page, ManagedServerPurchase)?.props).toMatchObject({
    requestedPlanId: "starter",
    autoCheckout: true,
  });
  expect(mocks.get).not.toHaveBeenCalled();
});
it("rejects malformed automatic purchase identities", async () => {
  const page = await load("plans", {
    newServer: "1",
    startCheckout: "1",
    checkoutIntent: "invalid",
  });
  expect(
    findElement<{ autoCheckout: boolean }>(page, ManagedServerPurchase)?.props.autoCheckout,
  ).toBe(false);
});
it("requires organization activation before reading or returning to another plan", async () => {
  const query = {
    organizationId: "org-b",
    workspaceId: "cws-b",
    checkout: "success",
    session_id: "receipt-b",
  };
  const page = await load("overview", query);
  expect(findElement<{ returnQuery: unknown }>(page, CloudBillingLink)?.props.returnQuery).toEqual(
    query,
  );
  expect(mocks.get).not.toHaveBeenCalled();
});
it("opens the account plan hub and preserves old receipt entry links", async () => {
  expect(
    findElement(await BillingPage({ searchParams: Promise.resolve({}) }), BillingHome),
  ).toBeDefined();
  const query = { workspaceId: "cws-a", topup: "success", session_id: "receipt" };
  await expect(BillingPage({ searchParams: Promise.resolve(query) })).rejects.toMatchObject({
    digest: `NEXT_REDIRECT;replace;/billing/overview?${new URLSearchParams(query)};307;`,
  });
});
it("authorizes direct plan links before mounting the plan", async () => {
  const query = {
    pool: "server-b",
    tab: "payment",
    organizationId: "org-b",
    checkout: "success",
    session_id: "receipt-b",
  };
  const page = await ResourcesPage({ searchParams: Promise.resolve(query) });
  expect(findElement<Record<string, unknown>>(page, CloudBillingLink)?.props).toMatchObject({
    serverId: "server-b",
    planTab: "payment",
    returnQuery: query,
  });
});

describe("billing recovery messages", () => {
  it("offers retry for a temporary failure without inventing an organization switch", () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <BillingUnavailable reason="billing-unreachable" />
      </I18nProvider>,
    );

    expect(html).toContain("temporarily unavailable");
    expect(html).toContain("Try again");
    expect(html).not.toContain("Contact your administrator to enable it");
    expect(html).not.toContain("Reconnect");
  });

  it("provides a sign-in link when the session cannot be verified", () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <BillingUnavailable reason="billing-sign-in-required" />
      </I18nProvider>,
    );

    expect(html).toContain('href="/login"');
    expect(html).toContain("Sign in to view billing");
  });
});
