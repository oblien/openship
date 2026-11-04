// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AffiliateOverview } from "@repo/contracts";
import { resolvePlan } from "@repo/core";
import { baseDictionary } from "@/i18n";
import { CreateAffiliateLink } from "./CreateAffiliateLink";
import { discountBasisPoints } from "./affiliate-presentation";
import { affiliateEstimate } from "./AffiliatePlanPicker";
const h = vi.hoisted(() => ({ request: vi.fn(), catalog: vi.fn(), created: vi.fn() }));
vi.mock("@/lib/api/affiliates", () => ({ affiliateRequest: h.request }));
vi.mock("@/components/i18n-provider", () => ({
  useI18n: () => ({ t: baseDictionary, locale: "en" }),
}));
vi.mock("@/components/billing/useCloudBilling", () => ({ useCloudPlans: h.catalog }));
const policy = {
  id: "standard",
  name: "Standard",
  commissionBps: 2000,
  durationMonths: 12,
  minimumMonthlyCents: 1000,
  payoutMinimumCents: 5000,
  planId: null,
};
const data: AffiliateOverview = {
  available: true,
  program: { version: 1, policies: [policy] },
  member: { enabled: true, payoutMinimumCents: 5000 },
  summary: {
    currency: "usd",
    earned: 0,
    reversed: 0,
    credited: 0,
    available: 0,
    reserved: 0,
    paid: 0,
    referrals: 0,
    converted: 0,
  },
};
const plans = (["hobby", "starter"] as const).map((id) => {
  const p = resolvePlan(id);
  return { ...p, features: [...p.features], resourceLimits: p.oblienLimits };
});
const catalog = () => ({
  payload: { plans, annual: { enabled: true } },
  error: null,
  loading: false,
  retry: vi.fn(),
});
let root: Root, host: HTMLDivElement;
const render = (value = data) =>
  act(async () =>
    root.render(<CreateAffiliateLink data={value} onClose={() => {}} onCreated={h.created} />),
  );
const button = (text: string) =>
  [...document.querySelectorAll("button")].find((el) => el.textContent?.trim() === text)!;
const click = (text: string) => act(async () => button(text).click());
const submit = () =>
  act(async () => {
    document
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
async function fill(selector: string, value: string) {
  await act(async () => {
    const input = document.querySelector<HTMLInputElement>(selector)!;
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
      input,
      value,
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const next = async () => {
  await click("Next");
  await fill('input[maxlength="100"]', "Newsletter readers");
};
const chooseOnlyAnnualHobby = async () => {
  await click("Selected plans");
  await click("Clear selection");
  await act(async () =>
    document
      .querySelector<HTMLButtonElement>('[role="checkbox"][aria-label="Hobby · Yearly"]')!
      .click(),
  );
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.catalog.mockReturnValue(catalog());
  h.request.mockResolvedValue({ id: "offer" });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
it("starts with discounts, then reviews earnings before creating through the existing operation", async () => {
  await render();
  expect(document.querySelector('input[maxlength="100"]')).toBeNull();
  expect(button("Create link")).toBeUndefined();
  await fill('input[inputmode="decimal"]', "0.29");
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("19.71%");
  await next();
  expect(button("Create link").disabled).toBe(false);
  await submit();
  expect(h.request).toHaveBeenCalledWith("createOffer", {
    policyId: "standard",
    name: "Newsletter readers",
    discountBps: 29,
    planId: null,
    eligiblePlans: null,
    idempotencyKey: expect.any(String),
  });
  expect(h.created).toHaveBeenCalledOnce();
});
it("rejects invalid discounts before allowing the second step", async () => {
  await render();
  for (const value of ["20.01", "-1", "5e1", "0.001", ""]) {
    await fill('input[inputmode="decimal"]', value);
    expect(button("Next").disabled).toBe(true);
    await submit();
    expect(document.querySelector('input[maxlength="100"]')).toBeNull();
  }
  expect(h.request).not.toHaveBeenCalled();
  await click("5%");
  await next();
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("15%");
});
it("creates a yearly Hobby-only link and keeps the draft when returning to discounts", async () => {
  await render();
  await click("5%");
  await next();
  await chooseOnlyAnnualHobby();
  await click("Previous");
  await click("Next");
  expect(document.querySelector<HTMLInputElement>('input[maxlength="100"]')?.value).toBe(
    "Newsletter readers",
  );
  await submit();
  expect(h.request.mock.calls[0][1].eligiblePlans).toEqual([
    { planId: "vm:1:4096:50", intervals: ["annual"] },
  ]);
});
it("blocks an empty selection and a selected interval that disappears from the catalog", async () => {
  await render();
  await next();
  await click("Selected plans");
  await click("Clear selection");
  expect(button("Create link").disabled).toBe(true);
  await submit();
  expect(h.request).not.toHaveBeenCalled();
  await act(async () =>
    document
      .querySelector<HTMLButtonElement>('[role="checkbox"][aria-label="Hobby · Yearly"]')!
      .click(),
  );
  h.catalog.mockReturnValue({ ...catalog(), payload: { plans, annual: { enabled: false } } });
  await render();
  expect(button("Create link").disabled).toBe(true);
  await submit();
  expect(h.request).not.toHaveBeenCalled();
});
it("requires a future expiration only when opted in and omits it when turned off", async () => {
  await render();
  await next();
  expect(document.querySelector('input[type="datetime-local"]')).toBeNull();
  await act(async () => document.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
  expect(button("Create link").disabled).toBe(true);
  await fill('input[type="datetime-local"]', "2000-01-01T12:00");
  await submit();
  expect(h.request).not.toHaveBeenCalled();
  await fill('input[type="datetime-local"]', "2099-01-01T12:00");
  await submit();
  expect(h.request.mock.calls[0][1].expiresAt).toBe(new Date("2099-01-01T12:00").toISOString());
  await act(async () => document.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
  await submit();
  expect(h.request.mock.calls[1][1]).not.toHaveProperty("expiresAt");
});
it("rechecks expiration on submission after time passes", async () => {
  await render();
  await next();
  await act(async () => document.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
  await fill('input[type="datetime-local"]', "2099-01-01T12:00");
  const now = vi.spyOn(Date, "now").mockReturnValue(+new Date("2100-01-01"));
  await submit();
  expect(h.request).not.toHaveBeenCalled();
  now.mockRestore();
});
it("reuses an uncertain request key across steps until terms change", async () => {
  h.request.mockRejectedValue(new Error("Connection interrupted"));
  await render();
  await next();
  await submit();
  await click("Previous");
  await click("Next");
  await submit();
  expect(h.request.mock.calls[0][1]).toEqual(h.request.mock.calls[1][1]);
  await chooseOnlyAnnualHobby();
  await submit();
  expect(h.request.mock.calls[2][1].idempotencyKey).not.toBe(
    h.request.mock.calls[0][1].idempotencyKey,
  );
});
it("resets eligibility and discount on a program change without leaking old terms", async () => {
  const two = {
    ...data,
    program: {
      version: 1 as const,
      policies: [policy, { ...policy, id: "small", name: "Small", commissionBps: 300 }],
    },
  };
  await render(two);
  await click("10%");
  await next();
  await chooseOnlyAnnualHobby();
  await click("Previous");
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[aria-label="Program"]')!.click(),
  );
  await act(async () =>
    [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((el) => el.textContent?.includes("Small"))!
      .click(),
  );
  expect(document.querySelector<HTMLInputElement>('input[inputmode="decimal"]')?.value).toBe("0");
  await click("Next");
  await submit();
  expect(h.request.mock.calls[0][1]).toMatchObject({
    policyId: "small",
    discountBps: 0,
    eligiblePlans: null,
  });
});
it("keeps preview rounding consistent with invoice splitting", () => {
  expect(affiliateEstimate(1200, 2000, 500)).toEqual({ paid: 1140, commission: 180 });
  expect(affiliateEstimate(12000, 2000, 500)).toEqual({ paid: 11400, commission: 1800 });
  expect(affiliateEstimate(1231, 2000, 500)).toEqual({ paid: 1169, commission: 184 });
  expect(discountBasisPoints("0.29")).toBe(29);
  for (const invalid of ["20.001", "-1", "5e1", "100.01", "Infinity", ""])
    expect(discountBasisPoints(invalid)).toBeNull();
});

it("distinguishes customer billing from earnings and only promises renewals inside the reward period", async () => {
  await render();
  await click("5%");
  await next();
  const option = (interval: string) =>
    document.querySelector<HTMLElement>(`[role="checkbox"][aria-label="Hobby · ${interval}"]`)!
      .textContent!;
  expect(option("Monthly")).toContain("Customer pays $11.40 / month");
  expect(option("Monthly")).toContain("$1.80per payment");
  expect(option("Monthly")).toContain("First payment + eligible renewals");
  expect(option("Yearly")).toContain("Customer pays $114.00 / year");
  expect(option("Yearly")).toContain("$18.00per payment");
  expect(option("Yearly")).toContain("First payment only");
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
    "the next yearly renewal is outside the earning window",
  );

  await render({ ...data, program: { version: 1, policies: [{ ...policy, durationMonths: 24 }] } });
  expect(option("Yearly")).toContain("First payment + eligible renewals");
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain(
    "the next yearly renewal is outside the earning window",
  );
  await render({ ...data, program: { version: 1, policies: [{ ...policy, durationMonths: 1 }] } });
  expect(option("Monthly")).toContain("First payment only");
});
