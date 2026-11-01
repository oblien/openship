// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pricingUi, resolvePlan } from "@repo/core";
import { CLOUD_SUPPORT_ACCOUNT_HEADER } from "@repo/contracts";
import { I18nProvider } from "@/components/i18n-provider";
import { PlatformProvider } from "@/context/PlatformContext";
import { baseDictionary } from "@/i18n";
import { ApiError } from "@/lib/api/client";
import type { BillingState } from "@/lib/api/billing";
import { checkoutFailureKind, type CheckoutFailure } from "@/lib/checkout-failure";
import { CloudCheckoutFeedback } from "./CloudCheckoutFeedback";
import { CloudPlanOffer } from "./CloudPlanOffer";
import { BillingWorkspaceProvider } from "./BillingWorkspaceContext";
import type { ApiPlan } from "./PricingCards";

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), fetch: vi.fn(), close: vi.fn(), retry: vi.fn() }));
vi.mock("@/lib/api/client", async original => ({
  ...await original<typeof import("@/lib/api/client")>(), api: { get: h.get, post: h.post },
}));
vi.mock("@/lib/auth-client", () => ({ useSession: () => ({ data: {
  user: { id: "customer", name: "Customer", email: "customer@example.test" },
  session: { activeOrganizationId: "org-selected" },
} }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const copy = baseDictionary.billing.checkoutUnavailable;
const receipt = { id: "SUP-0123456789ABCDEF01234567", createdAt: "2026-10-06T00:00:00Z" };
const source = resolvePlan("starter");
const plan: ApiPlan = { ...source, features: [...source.features],
  resourceLimits: { ...source.oblienLimits, max_total_vcpus: 3, max_total_ram_mb: 6144, max_total_disk_gb: 77 },
  listPrice: { monthly: source.price.monthly }, effectivePrice: { monthly: source.price.monthly }, campaign: null };
const failure: CheckoutFailure = { kind: "capacity", requestId: "12345678-1234-1234-1234-123456789012",
  planTierId: "starter", interval: "monthly", workspaceId: "cws-selected" };
let root: Root;
let host: HTMLDivElement;
const render = (node: ReactNode = <CloudCheckoutFeedback failure={failure} plans={[plan]} onClose={h.close} onRetry={h.retry} />) => act(async () => root.render(
  <I18nProvider><PlatformProvider selfHosted={false} cloudApiUrl="https://cloud.example.test">
    <BillingWorkspaceProvider workspaceId="cws-selected">{node}</BillingWorkspaceProvider>
  </PlatformProvider></I18nProvider>,
));
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const click = (label: string) => act(async () => {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === label);
  expect(button, label).toBeDefined(); button!.click();
});
const submit = () => act(async () => {
  dialog()!.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", h.fetch);
  h.post.mockResolvedValue(receipt);
  h.get.mockResolvedValue({ data: { plans: [plan], ui: pricingUi("en"), annual: { enabled: false, monthsFree: 0 } } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals();
});

describe("checkout availability feedback", () => {
  it("opens payment recovery from the compact offer instead of showing the unresolved checkout error", async () => {
    h.get.mockImplementation(async path => path === "billing/checkouts" ? { data: { items: [] } } : {
      data: { plans: [plan], ui: pricingUi("en"), annual: { enabled: false, monthsFree: 0 } },
    });
    h.post.mockRejectedValueOnce(new ApiError(409, "Blocked", { code: "CLOUD_WORKSPACE_CHECKOUT_PENDING", error: "Raw blocked checkout" }));
    await render(<CloudPlanOffer state={{ tier: "free", status: "inactive", billing: { enabled: true },
      balance: { quotaUsed: 0, quotaRemaining: 0, quotaLimit: 0 } } as BillingState} />);
    const choose = [...document.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.includes("Starter"));
    expect(choose).toBeDefined();
    await act(async () => choose!.click());
    expect(dialog()?.textContent).toContain(baseDictionary.billing.pendingPayments.title);
    expect(dialog()?.textContent).toContain(baseDictionary.billing.pendingPayments.empty);
    expect(document.body.textContent).not.toContain("Raw blocked checkout");
    expect(h.get).toHaveBeenCalledWith("billing/checkouts", { params: { workspaceId: "cws-selected" } });
  });
  it("shows the chosen offer and asks before sending an availability request", async () => {
    await render();
    expect(dialog()?.textContent).toContain(copy.capacityTitle);
    expect([...dialog()!.querySelectorAll("dd")].map(node => node.textContent)).toEqual(["3", "6 GB", "77 GB"]);
    expect(dialog()?.querySelector<HTMLInputElement>('input[type="email"]')?.value).toBe("customer@example.test");
    expect(h.fetch).not.toHaveBeenCalled();
    await click(copy.retry);
    expect(h.retry).toHaveBeenCalledExactlyOnceWith(failure);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("confirms only a saved support receipt and prevents duplicate submissions", async () => {
    let complete!: (response: typeof receipt) => void;
    h.post.mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
    await render(); await submit(); await submit();
    expect(h.post).toHaveBeenCalledOnce();
    expect(dialog()?.textContent).not.toContain(copy.receivedTitle);
    const [url, body] = h.post.mock.calls[0]!;
    expect(url).toBe("cloud/support/mine");
    expect(body).toMatchObject({ requestId: failure.requestId, category: "billing", subject: "Cloud capacity availability" });
    expect(body).not.toHaveProperty("email");
    expect(body).not.toHaveProperty("ownerUserId");
    expect(h.post.mock.calls[0]![2].headers[CLOUD_SUPPORT_ACCOUNT_HEADER]).toBe("customer");
    expect(body.message).toContain("Server reference: cws-selected");
    expect(dialog()?.querySelector<HTMLInputElement>('input[type="email"]')?.readOnly).toBe(true);
    await act(async () => complete(receipt));
    expect(dialog()?.textContent).toContain(copy.receivedTitle);
    expect(dialog()?.textContent).toContain("customer@example.test");
    expect(dialog()?.querySelector("form")).toBeNull();
    expect(dialog()?.querySelector(`a[href="/support?ticket=${receipt.id}"]`)).not.toBeNull();
  });

  it("reuses the support request after a lost response without claiming it was saved", async () => {
    h.post.mockRejectedValueOnce(new TypeError("Connection lost"));
    await render(); await submit();
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe(copy.requestFailed);
    expect(dialog()?.textContent).not.toContain(copy.receivedTitle);
    await submit();
    expect(h.post.mock.calls[1]![1]).toEqual(h.post.mock.calls[0]![1]);
    expect(dialog()?.textContent).toContain(copy.receivedTitle);
  });

  it.each([200, 503])("does not accept a missing receipt from an HTTP %s response", async status => {
    if (status === 503) h.post.mockRejectedValueOnce(new ApiError(status, "Unavailable", { error: "internal failure" }));
    else h.post.mockResolvedValueOnce({ error: "internal failure" });
    await render(); await submit();
    expect(dialog()?.textContent).not.toContain(copy.receivedTitle);
    expect(dialog()?.textContent).not.toContain("internal failure");
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe(copy.requestFailed);
  });

  it("describes the custom request rather than its preset base plan", async () => {
    const custom = { resources: { cpuCores: 6, memoryMb: 24576, diskGb: 180 }, quoteReference: "private-quote" };
    await render(<CloudCheckoutFeedback failure={{ ...failure, custom }} plans={[plan]} onClose={h.close} onRetry={h.retry} />);
    expect([...dialog()!.querySelectorAll("dd")].map(node => node.textContent)).toEqual(["6", "24 GB", "180 GB"]);
    await submit();
    const body = h.post.mock.calls[0]![1];
    expect(body.message).toContain("Plan: custom");
    expect(body.message).toContain("6 vCPU, 24576 MB RAM, 180 GB storage");
    expect(body.message).not.toContain("private-quote");
  });

  it("ignores a support response from the previously selected server", async () => {
    let complete!: (response: typeof receipt) => void;
    h.post.mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
    await render(); await submit();
    await render(<CloudCheckoutFeedback failure={{ ...failure, workspaceId: "cws-other" }} plans={[plan]} onClose={h.close} onRetry={h.retry} />);
    await act(async () => complete(receipt));
    expect(dialog()?.textContent).not.toContain(copy.receivedTitle);
    expect(dialog()?.querySelector("form")).not.toBeNull();
  });

  it("uses the same unavailable dialog from the compact starting offer and retries the same purchase", async () => {
    h.post.mockRejectedValue(new ApiError(503, "Unavailable", { code: "OBLIEN_CHECKOUT_UNAVAILABLE", error: "raw failure" }));
    await render(<CloudPlanOffer state={{ tier: "free", billing: { enabled: true },
      balance: { quotaUsed: 0, quotaRemaining: 0, quotaLimit: 0 } } as BillingState} />);
    await click("Subscribe to Starter");
    expect(dialog()?.textContent).toContain(copy.checkoutTitle);
    expect(document.body.textContent).not.toContain("raw failure");
    await click(copy.retry);
    expect(h.post.mock.calls[1]).toEqual(h.post.mock.calls[0]);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("offers direct support contact on a connected installation without a cross-origin intake request", async () => {
    await render(<PlatformProvider selfHosted cloudApiUrl="https://cloud.example.test">
      <CloudCheckoutFeedback failure={failure} plans={[plan]} onClose={h.close} onRetry={h.retry} />
    </PlatformProvider>);
    const contact = dialog()?.querySelector<HTMLAnchorElement>('a[href^="mailto:support@openship.io"]');
    expect(contact?.textContent).toBe(baseDictionary.billing.checkout.support);
    expect(decodeURIComponent(contact!.href)).toContain("Server reference: cws-selected");
    expect(dialog()?.querySelector("form")).toBeNull();
    expect(h.fetch).not.toHaveBeenCalled();
  });
});

describe("checkout failure classification", () => {
  it.each(["capacity_unavailable", "billing_capacity_unavailable"])("recognizes safe provider capacity code %s", code => {
    expect(checkoutFailureKind(new ApiError(503, "Unavailable", { code: "CLOUD_CAPACITY_UNAVAILABLE" }))).toBe("capacity");
    expect(checkoutFailureKind(new ApiError(409, "Conflict", { code: "OBLIEN_BILLING_ERROR", providerCode: code }))).toBe("capacity");
    expect(checkoutFailureKind(new ApiError(409, "Conflict", { code: "OBLIEN_BILLING_ERROR", details: { providerCode: code } }))).toBe("capacity");
  });
  it("keeps outage feedback distinct from plan, access and payment errors", () => {
    expect(checkoutFailureKind(new ApiError(503, "Unavailable", { code: "OBLIEN_CHECKOUT_UNAVAILABLE" }))).toBe("checkout");
    for (const code of ["BILLING_QUOTE_CHANGED", "TOKEN_READ_ONLY", "BILLING_CHECKOUT_PENDING"])
      expect(checkoutFailureKind(new ApiError(409, "Conflict", { code }))).toBeNull();
    expect(checkoutFailureKind(new Error("capacity_unavailable"))).toBeNull();
  });
});
