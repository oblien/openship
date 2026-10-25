// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { baseDictionary } from "@/i18n";
import { PayoutDestinationForm } from "./PayoutDestinationForm";
const h = vi.hoisted(() => ({ request: vi.fn(), saved: vi.fn() }));
vi.mock("@/lib/api/affiliates", () => ({ affiliateRequest: h.request }));
vi.mock("@/components/i18n-provider", () => ({
  useI18n: () => ({ t: baseDictionary, locale: "en" }),
}));
let root: Root, host: HTMLDivElement;
const button = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.trim() === text,
  )!;
const input = (label: string) =>
  [...document.querySelectorAll<HTMLLabelElement>("label")]
    .find((el) => el.querySelector("span")?.textContent === label)
    ?.querySelector<HTMLInputElement>("input")!;
const render = () =>
  act(async () => root.render(<PayoutDestinationForm onClose={() => {}} onSaved={h.saved} />));
async function fill(label: string, value: string) {
  await act(async () => {
    const el = input(label);
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
      el,
      value,
    );
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const click = (text: string) => act(async () => button(text).click());
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.request.mockResolvedValue({ revision: "revision" });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
it("renders the country catalog safely and saves a valid PayPal account through the shared operation", async () => {
  await render();
  expect(button("Save account").disabled).toBe(true);
  await fill("Account holder name", "Example Partner");
  await fill("PayPal email or PayPal.Me link", "partner@example.com");
  expect(button("Save account").disabled).toBe(false);
  await click("Save account");
  expect(h.request).toHaveBeenCalledWith("setPayoutDestination", {
    destination: {
      method: "paypal",
      accountName: "Example Partner",
      identifier: "partner@example.com",
    },
  });
  expect(h.saved).toHaveBeenCalledOnce();
});
it("rejects card numbers and lookalike PayPal links", async () => {
  await render();
  await fill("Account holder name", "Example Partner");
  for (const value of [
    "4242424242424242",
    "https://paypal.me.evil.test/partner",
    "https://paypal.me/partner?amount=200",
  ]) {
    await fill("PayPal email or PayPal.Me link", value);
    expect(button("Save account").disabled).toBe(true);
  }
  expect(h.request).not.toHaveBeenCalled();
  await fill("PayPal email or PayPal.Me link", "https://paypal.me/examplepartner");
  expect(button("Save account").disabled).toBe(false);
});
it("requires the full bank destination and sends none of the previous wallet fields", async () => {
  await render();
  await fill("Account holder name", "Example Partner");
  await fill("PayPal email or PayPal.Me link", "partner@example.com");
  await act(async () =>
    document.querySelector<HTMLInputElement>('input[type="radio"][value="bank_transfer"]')!.click(),
  );
  expect(button("Save account").disabled).toBe(true);
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[aria-label="Bank country"]')!.click(),
  );
  await act(async () =>
    [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((el) => el.textContent?.trim() === "United States")!
      .click(),
  );
  for (const [label, value] of [
    ["Bank name", "Example Bank"],
    ["IBAN or account number", "000123456789"],
    ["Routing number / SWIFT / BIC", "021000021"],
    ["Account holder address", "100 Example Street, New York"],
  ])
    await fill(label, value);
  expect(button("Save account").disabled).toBe(false);
  await click("Save account");
  expect(h.request.mock.calls[0][1].destination).toEqual({
    method: "bank_transfer",
    accountName: "Example Partner",
    country: "US",
    bankName: "Example Bank",
    accountNumber: "000123456789",
    bankCode: "021000021",
    beneficiaryAddress: "100 Example Street, New York",
  });
});
it("shows a failed save without claiming the account was linked", async () => {
  h.request.mockRejectedValue(new Error("Storage not configured"));
  await render();
  await fill("Account holder name", "Example Partner");
  await fill("PayPal email or PayPal.Me link", "partner@example.com");
  await click("Save account");
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Storage not configured");
  expect(h.saved).not.toHaveBeenCalled();
  expect(input("PayPal email or PayPal.Me link").value).toBe("partner@example.com");
});
