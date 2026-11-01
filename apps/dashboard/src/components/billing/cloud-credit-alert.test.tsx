// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { CloudCreditAlert } from "./CloudCreditAlert";
import { CloudBillingLink } from "./CloudBillingLink";
import { BillingWorkspaceProvider } from "./BillingWorkspaceContext";
import { I18nProvider } from "@/components/i18n-provider";
import { baseDictionary } from "@/i18n";
import type { BillingState } from "@/lib/api/billing";
import { monthlyCompute } from "../../../test/helpers/monthly-billing";

const h = vi.hoisted(() => ({
  read: vi.fn(),
  org: "org-a",
  setActive: vi.fn(),
  setOrg: vi.fn(),
}));
vi.mock("@/lib/api/billing", () => ({ billingApi: { getCreditAlerts: h.read } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/billing/topups" }));
vi.mock("@/lib/api/client", () => ({
  getActiveOrganizationId: () => h.org,
  setActiveOrganizationId: h.setOrg,
}));
vi.mock("@/lib/auth-client", () => ({ authClient: { organization: { setActive: h.setActive } } }));

const copy = baseDictionary.billing.creditAlert;
const state = (alertChanges = {}, changes = {}): BillingState => ({
  tier: "pro",
  status: "active",
  currentPeriod: { start: "2026-09-01", end: "2026-10-01" },
  balance: { total: 200_000, quotaLimit: 4_000_000, quotaUsed: 3_800_000, quotaRemaining: 200_000 },
  monthlyCreditLimit: 3_000_000,
  overQuota: false,
  buildTimeMinutes: 0,
  billing: { enabled: true },
  topups: { available: true },
  creditAlert: {
    namespace: "ns-a",
    state: "low",
    percent: 95,
    threshold: 95,
    thresholds: [80, 95],
    remaining: 200_000,
    balance: 200_000,
    limit: 4_000_000,
    ...alertChanges,
  },
  ...changes,
});

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.org = "org-a";
  h.read.mockReset();
  h.setActive.mockReset();
  h.setOrg.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});
const render = async (value: React.ReactNode) => {
  await act(async () => root.render(<I18nProvider>{value}</I18nProvider>));
};
const notice = (value: BillingState, organizationId = "org-a") => (
  <BillingWorkspaceProvider workspaceId={value.workspace?.id} organizationId={organizationId}>
    <CloudCreditAlert state={value} />
  </BillingWorkspaceProvider>
);

it("never shows stale credit warnings for monthly servers, including inactive coverage", async () => {
  for (const covered of [true, false]) {
    await render(notice(state({ state: "depleted", balance: 0 }, { compute: monthlyCompute({ covered }), overQuota: true })));
    expect(container.textContent).toBe("");
  }
  await render(notice(state({ state: "depleted" }, { plan: { billingMode: "monthly" } })));
  expect(container.textContent).toBe("");
});

it("shows the selected server's warning inline and keeps the top-up link in its billing scope", async () => {
  await render(notice(state({}, { workspace: { id: "server-a", name: "Server A" } })));
  expect(container.querySelector('[role="status"]')?.textContent).toContain(copy.lowTitle);
  expect(container.textContent).toContain("200 credits");
  const href = new URL(container.querySelector("a")!.href);
  expect(href.pathname).toBe("/billing/topups");
  expect(href.searchParams.get("workspaceId")).toBe("server-a");
  expect(href.searchParams.get("organizationId")).toBe("org-a");
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(container.querySelector("[aria-expanded]")).toBeNull();
  expect(h.read).not.toHaveBeenCalled();
});

it("distinguishes grace and exhaustion and clears recovered, disabled and unconfigured balances", async () => {
  await render(notice(state({ state: "grace", balance: 60_000 })));
  expect(container.textContent).toContain("60 grace credits");
  await render(notice(state({ state: "depleted", balance: 0 })));
  expect(container.textContent).toContain(copy.exhaustedTitle);
  for (const current of ["ok", "unlimited", "disabled"] as const) {
    await render(notice(state({ state: current })));
    expect(container.textContent).toBe("");
  }
  await render(notice(state({ limit: 0, state: "depleted" }, { tier: "free", balance: { quotaUsed: 0 } })));
  expect(container.textContent).toBe("");
  await render(notice(state({}, { tier: "free" })));
  expect(container.textContent).toContain(copy.lowTitle);
  await render(notice(state({}, { creditAlert: null })));
  expect(container.textContent).toBe("");
});

it("links to plans when top-ups are unavailable without starting a payment", async () => {
  await render(notice(state({}, { topups: { available: false } })));
  expect(container.querySelector("a")?.textContent).toBe(baseDictionary.billing.tabs.plans);
  expect(container.querySelector("a")?.getAttribute("href")).toBe("/billing/plans?organizationId=org-a");
  expect(h.setActive).not.toHaveBeenCalled();
});

it("replaces the notice with the currently selected server and organization without a separate polling loop", async () => {
  await render(notice(state({ state: "depleted" }, { workspace: { id: "server-a" } })));
  expect(container.textContent).toContain(copy.exhaustedTitle);
  await render(notice(state({ state: "ok" }, { workspace: { id: "server-b" } }), "org-b"));
  expect(container.textContent).toBe("");
  await render(notice(state({ state: "grace", balance: 30_000 }, { workspace: { id: "server-b" } }), "org-b"));
  expect(container.textContent).toContain("30 grace credits");
  const href = new URL(container.querySelector("a")!.href);
  expect(href.searchParams.get("workspaceId")).toBe("server-b");
  expect(href.searchParams.get("organizationId")).toBe("org-b");
  expect(container.textContent).not.toContain(copy.exhaustedTitle);
  expect(h.read).not.toHaveBeenCalled();
});

it("a billing link cannot fall back to the active org when the linked organization is forbidden", async () => {
  h.setActive.mockResolvedValue({ error: { message: "forbidden" } });
  await render(<CloudBillingLink organizationId="org-foreign" tab="topups" />);
  expect(h.setActive).toHaveBeenCalledWith({ organizationId: "org-foreign" });
  expect(h.setOrg).not.toHaveBeenCalled();
  expect(container.textContent).toContain(copy.wrongOrganization);
});

it("opens top-ups only after the server accepts the linked organization", async () => {
  const navigate = vi.spyOn(window.location, "assign").mockImplementation(() => {});
  h.setActive.mockResolvedValue({ error: null });
  await render(<CloudBillingLink organizationId="org-b" tab="topups" />);
  expect(h.setActive).toHaveBeenCalledWith({ organizationId: "org-b" });
  expect(h.setOrg).toHaveBeenCalledWith("org-b");
  expect(navigate).toHaveBeenCalledWith("/billing/topups?organizationId=org-b");
  expect(h.setOrg.mock.invocationCallOrder[0]).toBeLessThan(navigate.mock.invocationCallOrder[0]);
});
