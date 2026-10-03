// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { CloudCreditAlert, CreditAlertTray } from "./CloudCreditAlert";
import { CloudBillingLink } from "./CloudBillingLink";
import { I18nProvider } from "@/components/i18n-provider";
import { baseDictionary } from "@/i18n";
import type { BillingState } from "@/lib/api/billing";

const h = vi.hoisted(() => ({
  read: vi.fn(),
  org: "org-a",
  user: "user-a",
  setActive: vi.fn(),
  setOrg: vi.fn(),
  listeners: new Set<() => void>(),
}));
vi.mock("@/context/AuthContext", () => ({ useAuth: () => ({ user: { id: h.user } }) }));
vi.mock("@/context/PlatformContext", () => ({ usePlatform: () => ({ selfHosted: false }) }));
vi.mock("@/context/CloudContext", () => ({ useCloud: () => ({ connected: false }) }));
vi.mock("@/lib/api/billing", () => ({ billingApi: { getCreditAlerts: h.read } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/billing/topups" }));
vi.mock("@/lib/api/client", () => ({
  getActiveOrganizationId: () => h.org,
  setActiveOrganizationId: h.setOrg,
  subscribeActiveOrganization: (listener: () => void) => {
    h.listeners.add(listener);
    return () => {
      h.listeners.delete(listener);
    };
  },
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
  vi.useFakeTimers();
  sessionStorage.clear();
  h.org = "org-a";
  h.user = "user-a";
  h.listeners.clear();
  h.read.mockReset().mockResolvedValue({ items: [state()] });
  h.setActive.mockReset();
  h.setOrg.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const render = async (value: React.ReactNode) => {
  await act(async () => root.render(<I18nProvider>{value}</I18nProvider>));
};
const notice = (value: BillingState) => (
  <CreditAlertTray states={[value]} organizationId="org-a" userId="user-a" />
);
const expanded = () => container.querySelector('button[aria-expanded="true"]');

it("keeps the 80% warning collapsed and opens the 95% warning once with a scoped top-up action", async () => {
  await render(notice(state({ percent: 80, threshold: 80, remaining: 800_000 })));
  expect(container.textContent).toContain(copy.title);
  expect(expanded()).toBeNull();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await render(notice(state()));
  expect(expanded()).not.toBeNull();
  expect(container.textContent).toContain("200 credits");
  expect(container.querySelector("a")?.getAttribute("href")).toBe(
    "/billing/topups?organizationId=org-a",
  );
  await act(async () =>
    [...document.querySelectorAll("button")]
      .find((button) => button.getAttribute("aria-label") === copy.hideWarnings)!
      .click(),
  );
  await render(notice(state()));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(expanded()).toBeNull();
});

it("distinguishes grace/exhaustion, rearms on renewal, and hides recovered, disabled and unconfigured customers", async () => {
  await render(notice(state({ state: "grace", balance: 60_000 })));
  expect(container.textContent).toContain("60 grace credits");
  await render(notice(state({ state: "depleted", balance: 0 })));
  expect(container.textContent).toContain(copy.exhaustedTitle);
  for (const current of ["ok", "unlimited", "disabled"] as const) {
    await render(notice(state({ state: current })));
    expect(container.textContent).toBe("");
  }
  await render(
    notice(state({ limit: 0, state: "depleted" }, { tier: "free", balance: { quotaUsed: 0 } })),
  );
  expect(container.textContent).toBe("");
  await render(notice(state({}, { tier: "free" })));
  expect(container.textContent).toContain(copy.lowTitle);
  await render(notice(state({}, { creditAlert: null })));
  expect(container.textContent).toBe("");
  await render(notice(state({}, { currentPeriod: { start: "2026-10-01", end: "2026-11-01" } })));
  expect(expanded()).not.toBeNull();
});

it("offers billing management when top-ups are disabled and never initiates a purchase itself", async () => {
  await render(notice(state({}, { topups: { available: false } })));
  expect(container.querySelector("a")?.textContent).toBe(copy.openBilling);
  expect(container.querySelector("a")?.getAttribute("href")).toBe("/billing/overview?organizationId=org-a");
  expect(h.setActive).not.toHaveBeenCalled();
});

it("does not steal focus and lets Escape collapse the warning without reopening it", async () => {
  const previous = document.createElement("button");
  previous.textContent = "Previous control";
  document.body.append(previous);
  previous.focus();
  try {
    await render(notice(state()));
    const tray = container.querySelector<HTMLElement>("section")!;
    expect(document.activeElement).toBe(previous);
    await act(async () =>
      tray.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(container.querySelector("button"));
    await render(notice(state()));
    expect(expanded()).toBeNull();
  } finally {
    previous.remove();
  }
});

it("removes an open warning when the selected organization changes", async () => {
  await render(<CloudCreditAlert />);
  expect(expanded()).not.toBeNull();
  h.read.mockResolvedValue({ items: [state({ state: "ok" })] });
  await act(async () => {
    h.org = "org-b";
    h.listeners.forEach((listener) => listener());
  });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(container.textContent).toBe("");
});

it("hides the old organization immediately and rejects its delayed balance response", async () => {
  let complete!: (value: { items: BillingState[] }) => void;
  h.read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  await render(<CloudCreditAlert />);
  h.read.mockResolvedValue({ items: [state({ state: "ok" })] });
  await act(async () => {
    h.org = "org-b";
    h.listeners.forEach((listener) => listener());
  });
  await act(async () => {
    complete({ items: [state()] });
  });
  expect(container.textContent).toBe("");
  h.read.mockRejectedValue(new Error("forbidden"));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(container.textContent).toBe("");
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
