// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { baseDictionary } from "@/i18n";
import { BillingLayout } from "./BillingLayout";
const h = vi.hoisted(() => ({ path: "/billing/plans", query: "", billing: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => h.path,
  useSearchParams: () => new URLSearchParams(h.query),
}));
vi.mock("@/hooks/use-scoped-resource", () => ({ useResourceScope: () => "owner:org:cloud" }));
vi.mock("@/components/billing/ManagementPlan", () => ({
  ManagementBilling: () => <p>Manage purchase</p>,
}));
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.path = "/billing/plans";
  h.query = "";
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const render = () =>
  act(async () =>
    root.render(
      <I18nProvider>
        <BillingLayout>
          <p>Plan content</p>
        </BillingLayout>
      </I18nProvider>,
    ),
  );
it("offers only new-plan purchase choices, with Support and no global payment or usage navigation", async () => {
  await render();
  expect(host.querySelector("header h1")?.textContent).toBe(
    baseDictionary.billing.onboarding.compareTitle,
  );
  expect(host.querySelector('a[href="/support"]')).not.toBeNull();
  expect(host.textContent).not.toContain(baseDictionary.billing.tabs.payment);
  expect(host.textContent).not.toContain(baseDictionary.billing.tabs.usage);
  expect(host.querySelector('a[href*="/billing/payment"]')).toBeNull();
  expect(host.querySelectorAll('[role="tab"]')).toHaveLength(2);
  const manage = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (b) => b.textContent === baseDictionary.billing.purchase.manage,
  )!;
  await act(async () => manage.click());
  expect(host.textContent).toContain("Manage purchase");
});
it.each(["/billing", "/billing/manage", "/billing/overview", "/billing/usage", "/billing/payment"])(
  "adds no second billing shell at %s",
  async (path) => {
    h.path = path;
    await render();
    expect(host.textContent).toBe("Plan content");
    expect(host.querySelector("header")).toBeNull();
  },
);
it("does not wrap a scoped plan link or checkout return with new-purchase UI", async () => {
  h.query = "workspaceId=plan-a";
  await render();
  expect(host.textContent).toBe("Plan content");
  h.query = "workspaceId=plan-a&newServer=1&checkout=success";
  await render();
  expect(host.textContent).toBe("Plan content");
});
