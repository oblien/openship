// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AffiliateDashboard } from "./AffiliateDashboard";
import { payoutCents } from "./affiliate-presentation";
import { baseDictionary } from "@/i18n";
import type { AffiliateOverview } from "@repo/contracts";

const h = vi.hoisted(() => ({ request: vi.fn(), user: "alice" }));
vi.mock("@/lib/api/affiliates", () => ({ affiliateRequest: h.request }));
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: h.user }, session: { activeOrganizationId: "team" } } }),
}));
vi.mock("@/components/i18n-provider", () => ({
  useI18n: () => ({ t: baseDictionary, locale: "en" }),
}));
vi.mock("@/components/billing/useCloudBilling", () => ({
  useCloudPlans: () => ({ payload: { plans: [], annual: { enabled: true } } }),
}));
let root: Root, host: HTMLDivElement;
const state = () => ({
  available: true,
  program: { version: 1 as const, policies: [] },
  member: {
    enabled: true,
    payoutMinimumCents: 5000,
    payoutDestination: {
      revision: "10000000-0000-4000-8000-000000000001",
      method: "paypal" as const,
      accountName: "Example Partner",
      label: "p•••@example.com",
    },
  },
  summary: {
    currency: "usd" as const,
    available: 6500,
    earned: 10000,
    reversed: 500,
    credited: 9500,
    reserved: 2000,
    paid: 1000,
    referrals: 2,
    converted: 2,
  },
});
const button = (label: string) =>
  [...document.querySelectorAll("button")].reverse().find((b) => b.textContent?.trim() === label)!;
const render = () =>
  act(async () => {
    root.render(<AffiliateDashboard key={h.user} />);
  });
async function amount(value: string) {
  await act(async () => {
    const input = document.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!;
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
      input,
      value,
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.user = "alice";
  h.request.mockReset();
  h.request.mockImplementation(async (name) =>
    name === "overview" ? state() : { total: 0, items: [] },
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
it("opens the payout form on demand and preserves an uncertain request across reopening", async () => {
  await render();
  expect(host.textContent).toContain("$65.00");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.querySelector('input[inputmode="decimal"]')).toBeNull();
  await act(async () => button("Request payout").click());
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("$50.00");
  expect(document.querySelector<HTMLInputElement>('input[inputmode="decimal"]')?.value).toBe(
    "65.00",
  );
  await amount("49.99");
  expect(button("Request payout").disabled).toBe(true);
  await amount("65.01");
  expect(button("Request payout").disabled).toBe(true);
  await amount("50");
  expect(button("Request payout").disabled).toBe(false);
  h.request.mockImplementation(async (name) => {
    if (name === "requestPayout") throw new Error("Connection interrupted");
    return name === "overview" ? state() : { total: 0, items: [] };
  });
  await act(async () => button("Request payout").click());
  await act(async () =>
    document.querySelector<HTMLButtonElement>("[data-modal-surface] > button")!.click(),
  );
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => button("Request payout").click());
  await act(async () => button("Request payout").click());
  const calls = h.request.mock.calls.filter(([name]) => name === "requestPayout");
  expect(calls).toHaveLength(2);
  expect(calls[0][1]).toEqual(calls[1][1]);
  expect(calls[0][1].amountCents).toBe(5000);
});
it.each([
  { balance: 4999, enabled: true },
  { balance: 6500, enabled: false },
  { balance: 0, enabled: true },
])(
  "keeps history and cancellation available without offering an ineligible payout: %j",
  async ({ balance, enabled }) => {
    const overview = state();
    overview.summary.available = balance;
    overview.member.enabled = enabled;
    h.request.mockImplementation(async (name) =>
      name === "overview"
        ? overview
        : name === "payouts"
          ? {
              total: 1,
              items: [
                {
                  id: "pending-payout",
                  amountCents: 5000,
                  status: "pending",
                  createdAt: "2026-10-25T00:00:00Z",
                },
              ],
            }
          : { total: 0, items: [] },
    );
    await render();
    expect(button("Request payout")).toBeUndefined();
    expect(document.querySelector('input[inputmode="decimal"]')).toBeNull();
    await act(async () => button("Payouts").click());
    expect(host.textContent).toContain("$50.00");
    await act(async () => button("Cancel request").click());
    expect(h.request).toHaveBeenCalledWith("cancelPayout", { id: "pending-payout" });
  },
);
it("closes a successful request, opens its history, and hides the action when the balance is reserved", async () => {
  let overview = state();
  overview.summary.available = 5000;
  h.request.mockImplementation(async (name) => {
    if (name === "requestPayout") {
      overview = { ...overview, summary: { ...overview.summary, available: 0, reserved: 7000 } };
      return { id: "new-payout" };
    }
    return name === "overview" ? overview : { total: 0, items: [] };
  });
  await render();
  await act(async () => button("Request payout").click());
  await act(async () => button("Request payout").click());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(button("Request payout")).toBeUndefined();
  expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Payouts");
});
it("keeps private results and drafts out of a different account", async () => {
  let resolve!: (value: unknown) => void;
  h.request.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  await render();
  h.user = "bob";
  h.request.mockResolvedValue({ ...state(), available: false });
  await render();
  await act(async () => resolve(state()));
  expect(host.textContent).toContain("not available yet");
  expect(host.textContent).not.toContain("$65.00");
});
it("shows an unavailable state instead of fabricated earnings when the provider fails", async () => {
  h.request.mockRejectedValue(new Error("Provider unavailable"));
  await render();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Provider unavailable");
  expect(host.textContent).not.toContain("$0.00");
  expect(button("Try again")).toBeDefined();
});
it("handles money as decimal cents and rejects exponent, fractional-cent and unsafe inputs", () => {
  expect(payoutCents("50.01")).toBe(5001);
  expect(payoutCents("50")).toBe(5000);
  for (const input of ["5e3", "50.001", "-1", "Infinity", "999999999999999999", "", "0.99"])
    expect(payoutCents(input)).toBeNull();
});

it("offers illustrated first-link and customer guidance without inventing records", async () => {
  const overview: AffiliateOverview = state();
  overview.program.policies = [
    {
      id: "program",
      name: "Cloud",
      commissionBps: 2000,
      durationMonths: 12,
      minimumMonthlyCents: 1000,
      payoutMinimumCents: 5000,
      planId: null,
    },
  ];
  h.request.mockImplementation(async (name) =>
    name === "overview" ? overview : { total: 0, items: [] },
  );
  await render();
  expect(host.textContent).toContain("Your next referral starts here");
  await act(async () => button("Create link").click());
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Choose a discount");
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click());
  await act(async () => button("Referred customers2").click());
  expect(host.textContent).toContain("Your referrals, all in one place");
  await act(async () => button("View your links").click());
  expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Links");
});

it("shows each program's own terms and the member's individual payout minimum", async () => {
  const overview: AffiliateOverview = state();
  overview.member!.payoutMinimumCents = 7500;
  overview.program.policies = [
    {
      id: "short",
      name: "Short program",
      commissionBps: 2000,
      durationMonths: 6,
      minimumMonthlyCents: 1000,
      payoutMinimumCents: 5000,
      planId: null,
    },
    {
      id: "long",
      name: "Long program",
      commissionBps: 1000,
      durationMonths: 24,
      minimumMonthlyCents: 1000,
      payoutMinimumCents: 5000,
      planId: null,
    },
  ];
  h.request.mockImplementation(async (name) =>
    name === "overview" ? overview : { total: 0, items: [] },
  );
  await render();
  const program = host.querySelector("aside section")!;
  const terms = [...program.querySelectorAll("h3")].map((el) => el.parentElement!.textContent);
  expect(terms[0]).toContain("20%");
  expect(terms[0]).toContain("6 months");
  expect(terms[1]).toContain("10%");
  expect(terms[1]).toContain("24 months");
  expect(program.textContent).toContain("$75.00");
  expect(button("Request payout")).toBeUndefined();
});

it("keeps earned funds requestable when there are no programs for new links", async () => {
  await render();
  expect(button("Create link")).toBeUndefined();
  expect(button("Request payout")).toBeDefined();
});

it("keeps enrollment distinct from an empty member account", async () => {
  h.request.mockResolvedValue({ ...state(), member: null });
  await render();
  expect(host.textContent).toContain("Share OpenShip. Earn on renewals.");
  expect(host.textContent).not.toContain("$65.00");
  expect(button("Join the program").disabled).toBe(true);
});
