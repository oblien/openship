// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BillingPendingCheckout } from "@repo/contracts";
import { I18nProvider } from "@/components/i18n-provider";
import { baseDictionary } from "@/i18n";
import { ApiError } from "@/lib/api/client";
import { CloudResourceContext } from "@/context/CloudResourceContext";
import { BillingWorkspaceProvider } from "./BillingWorkspaceContext";
import { CheckoutRecoveryDialog } from "./CheckoutRecovery";
import { PendingCheckoutsProvider, usePendingCheckouts } from "./PendingCheckoutsContext";

const h = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  remove: vi.fn(),
  refresh: vi.fn(),
  cleared: vi.fn(),
  started: vi.fn(),
  removed: vi.fn(),
  close: vi.fn(),
  cloudKey: "cloud-account-a",
  user: "user-a",
  org: "org-a",
}));
vi.mock("@/lib/api/client", async (original) => ({
  ...(await original<typeof import("@/lib/api/client")>()),
  api: { get: h.get, post: h.post },
}));
vi.mock("@/lib/api/system", () => ({ systemApi: { removeManagedServer: h.remove } }));
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: h.user }, session: { activeOrganizationId: h.org } } }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: h.refresh }) }));

const copy = baseDictionary.billing.pendingPayments;
const server = {
  id: "cws-selected",
  serverId: "server-selected",
  name: "My new server",
  planTierId: "free",
  subscriptionStatus: "active",
  state: "needs_plan",
  projectCount: 0,
  operation: null,
  resources: null,
  createdAt: "2026-10-06T00:00:00Z",
};
const item: BillingPendingCheckout = {
  id: "a".repeat(64),
  checkoutId: "cs_pending",
  server,
  kind: "subscription",
  name: "Saved Starter offer",
  amountCents: 1700,
  currency: "usd",
  interval: "monthly",
  state: "open",
  canResume: true,
  canCancel: true,
};
const ready = {
  status: "ready",
  checkoutId: "cs_pending",
  checkoutUrl: "https://checkout.stripe.com/c/pay/original",
};
const expired = { status: "expired", checkoutId: "cs_pending", checkoutUrl: null };
let root: Root;
let host: HTMLDivElement;
let popup: {
  opener: object | null;
  closed: boolean;
  location: { href: string };
  close: ReturnType<typeof vi.fn>;
};
const recovery = () => (
  <CheckoutRecoveryDialog
    isOpen
    workspaceId={server.id}
    preserveProject
    onClose={h.close}
    onCleared={h.cleared}
    onCheckoutStarted={h.started}
    onServerRemoved={h.removed}
  />
);
const render = (node: ReactNode = recovery()) =>
  act(async () =>
    root.render(
      <I18nProvider>
        <CloudResourceContext.Provider value={h.cloudKey}>
          <BillingWorkspaceProvider>{node}</BillingWorkspaceProvider>
        </CloudResourceContext.Provider>
      </I18nProvider>,
    ),
  );
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent?.trim() === label,
  );
const click = (label: string) =>
  act(async () => {
    expect(button(label), label).toBeDefined();
    button(label)!.click();
  });
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.cloudKey = "cloud-account-a";
  h.user = "user-a";
  h.org = "org-a";
  h.get.mockImplementation(async () => ({ data: { items: [structuredClone(item)] } }));
  h.post.mockResolvedValue({ data: ready });
  h.remove.mockResolvedValue({ ...server, state: "deleting" });
  popup = { opener: {}, closed: false, location: { href: "about:blank" }, close: vi.fn() };
  vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("unfinished checkout recovery", () => {
  it("shows saved offer terms and resumes the exact payment without selecting another plan", async () => {
    await render();
    expect(dialog()?.textContent).toContain(item.name);
    expect(dialog()?.textContent).toContain(server.name);
    expect(dialog()?.textContent).toContain("$17.00");
    expect(h.get).toHaveBeenCalledWith("billing/checkouts", { params: { workspaceId: server.id } });
    expect(h.post).not.toHaveBeenCalled();
    await click(copy.resume);
    expect(h.post).toHaveBeenCalledExactlyOnceWith("billing/checkout/resume", {
      workspaceId: server.id,
      id: item.id,
    });
    expect(popup.location.href).toBe(ready.checkoutUrl);
    expect(popup.opener).toBeNull();
    expect(h.started).toHaveBeenCalledExactlyOnceWith(ready.checkoutUrl);
    expect(dialog()?.querySelector('a[target="_blank"]')?.getAttribute("href")).toBe(
      ready.checkoutUrl,
    );
  });

  it("requires confirmed cancellation before offering deletion and uses the existing server action", async () => {
    let finish!: (value: unknown) => void;
    h.post.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await render();
    await click(copy.cancel);
    expect(dialog()?.textContent).toContain(copy.cancelHint);
    expect(h.post).not.toHaveBeenCalled();
    await click(copy.confirmCancel);
    expect(button(copy.deleteServer)).toBeUndefined();
    expect(h.remove).not.toHaveBeenCalled();
    expect(h.cleared).not.toHaveBeenCalled();
    await act(async () => finish({ data: expired }));
    expect(dialog()?.textContent).toContain(copy.canceled);
    expect(dialog()?.textContent).toContain(copy.count.replace("{count}", "0"));
    expect(h.cleared).toHaveBeenCalledOnce();
    expect(button(copy.resume)).toBeUndefined();
    await click(copy.deleteServer);
    expect(h.remove).not.toHaveBeenCalled();
    await click(baseDictionary.billing.workspaces.confirmDelete);
    expect(h.remove).toHaveBeenCalledExactlyOnceWith(server.serverId, {
      confirmDelete: true,
      idempotencyKey: expect.any(String),
    });
    expect(h.removed).toHaveBeenCalledExactlyOnceWith(server.id);
    expect(dialog()?.textContent).toContain(copy.removing);
  });

  it("returns to the existing plan picker without navigating away from a draft", async () => {
    h.post.mockResolvedValueOnce({ data: expired });
    await render();
    await click(copy.cancel);
    await click(copy.confirmCancel);
    await click(copy.choosePlan);
    expect(h.close).toHaveBeenCalledOnce();
    expect(dialog()?.querySelector('a[href^="/billing/plans"]')).toBeNull();
  });

  it("keeps an uncertain cancellation recoverable after its request fails", async () => {
    h.post.mockImplementationOnce(async () => {
      h.get.mockResolvedValue({
        data: { items: [{ ...item, state: "canceling", canResume: false }] },
      });
      throw new ApiError(503, "Try again", {});
    });
    await render();
    await click(copy.cancel);
    await click(copy.confirmCancel);
    expect(button(copy.resume)).toBeUndefined();
    expect(button(copy.deleteServer)).toBeUndefined();
    expect(button(copy.retryCancel)).toBeDefined();
    expect(h.cleared).not.toHaveBeenCalled();
    h.post.mockResolvedValueOnce({ data: expired });
    await click(copy.retryCancel);
    expect(h.post.mock.calls[1]).toEqual(h.post.mock.calls[0]);
    expect(h.cleared).toHaveBeenCalledOnce();
  });

  it("shows payment verification when payment completes during cancellation, without offering another purchase or deletion", async () => {
    h.post.mockResolvedValueOnce({ data: { ...expired, status: "processing" } });
    await render();
    await click(copy.cancel);
    await click(copy.confirmCancel);
    expect(dialog()?.textContent).toContain(copy.states.processing);
    expect(dialog()?.textContent).not.toContain(baseDictionary.billing.checkout.active);
    expect(button(copy.deleteServer)).toBeUndefined();
    expect(button(copy.resume)).toBeUndefined();
    expect(button(copy.retryCancel)).toBeUndefined();
    expect(dialog()?.querySelector('a[href*="session_id="]')?.getAttribute("href")).toBe(
      "/billing/overview?checkout=success&session_id=cs_pending&workspaceId=cws-selected",
    );
    expect(h.cleared).not.toHaveBeenCalled();
  });

  it("offers recovery for a lost checkout identity and an honest fallback when cancellation is unsupported", async () => {
    h.get.mockResolvedValueOnce({
      data: { items: [{ ...item, state: "unconfirmed", checkoutId: null, canCancel: false }] },
    });
    await render();
    expect(button(copy.cancel)).toBeUndefined();
    await click(copy.recover);
    expect(h.post).toHaveBeenCalledWith("billing/checkout/resume", {
      workspaceId: server.id,
      id: item.id,
    });
    h.get.mockResolvedValue({ data: { items: [{ ...item, canCancel: false }] } });
    await click(copy.refresh);
    expect(dialog()?.textContent).toContain(copy.cancelUnavailable);
    expect(dialog()?.querySelector('a[href="/support"]')).not.toBeNull();
    expect(button(copy.cancel)).toBeUndefined();
  });

  it("does not equate an unavailable provider response with an empty list or canceled payment", async () => {
    h.get.mockRejectedValueOnce(new ApiError(503, "Provider unavailable", {}));
    await render();
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain(
      "Provider unavailable",
    );
    expect(dialog()?.textContent).not.toContain(copy.empty);
    expect(h.cleared).not.toHaveBeenCalled();
    await click(copy.refresh);
    expect(button(copy.resume)).toBeDefined();
    expect(h.post).not.toHaveBeenCalled();
  });

  it("explains unsupported cancellation with one support link and preserves the payment", async () => {
    h.get.mockResolvedValue({ data: { items: [{ ...item, canCancel: false, cancelUnavailableReason: "unsupported" }] } });
    await render();
    expect(dialog()?.textContent).toContain(copy.cancelUnsupported);
    expect(dialog()?.textContent?.split(copy.support)).toHaveLength(2);
    expect(button(copy.cancel)).toBeUndefined();
    expect(button(copy.resume)).toBeDefined();
    expect(h.post).not.toHaveBeenCalled();
    expect(h.cleared).not.toHaveBeenCalled();
  });

  it("shows a temporary verification failure and restores the cancel flow after a read-only refresh", async () => {
    h.get.mockResolvedValueOnce({ data: { items: [{ ...item, canCancel: false, cancelUnavailableReason: "provider_unavailable" }] } });
    await render();
    expect(dialog()?.textContent).toContain(copy.cancelUnavailable);
    expect(dialog()?.textContent).not.toContain(copy.cancelUnsupported);
    expect(dialog()?.querySelector('a[href="/support"]')).toBeNull();
    expect(button(copy.cancel)).toBeUndefined();
    await click(copy.refresh);
    expect(button(copy.cancel)).toBeDefined();
    expect(h.post).not.toHaveBeenCalled();
    await click(copy.cancel);
    h.post.mockResolvedValueOnce({ data: expired });
    await click(copy.confirmCancel);
    expect(h.cleared).toHaveBeenCalledOnce();
    expect(dialog()?.textContent).toContain(copy.canceled);
  });

  it("keeps a manual payment link when the browser blocks its popup", async () => {
    vi.mocked(window.open).mockReturnValueOnce(null);
    await render();
    await click(copy.resume);
    expect(dialog()?.querySelector('a[target="_blank"]')?.getAttribute("href")).toBe(
      ready.checkoutUrl,
    );
    expect(h.started).toHaveBeenCalledWith(ready.checkoutUrl);
  });

  it("keeps the last confirmed list when a refresh returns a malformed response", async () => {
    await render();
    h.get.mockResolvedValueOnce({ data: { unexpected: true } });
    await click(copy.refresh);
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain(copy.loadError);
    expect(dialog()?.textContent).toContain(item.name);
    expect(dialog()?.textContent).not.toContain(copy.empty);
    expect(h.cleared).not.toHaveBeenCalled();
    expect(h.post).not.toHaveBeenCalled();
  });

  it("clears the previous Cloud payments when the linked account changes but the local session stays the same", async () => {
    await render();
    expect(dialog()?.textContent).toContain(item.name);
    h.get.mockResolvedValue({ data: { items: [] } });
    h.cloudKey = "cloud-account-b";
    await render();
    expect(dialog()?.textContent).not.toContain(item.name);
    expect(h.get).toHaveBeenCalledTimes(2);
  });

  it.each(["local", "cloud"])("ignores earlier payment results after switching the %s account and closes its reserved tab", async (account) => {
    let finish!: (value: unknown) => void;
    h.post.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await render();
    await click(copy.resume);
    if (account === "local") {
      h.user = "user-b";
      h.org = "org-b";
    } else {
      h.cloudKey = "cloud-account-b";
    }
    h.get.mockResolvedValueOnce({ data: { items: [] } });
    await render();
    await act(async () => finish({ data: ready }));
    expect(popup.location.href).toBe("about:blank");
    expect(popup.close).toHaveBeenCalled();
    expect(h.started).not.toHaveBeenCalled();
    expect(dialog()?.textContent).not.toContain(item.name);
  });

  it("does not fetch a closed dialog and supports keyboard dismissal of all Cloud payments", async () => {
    await render(<CheckoutRecoveryDialog isOpen={false} onClose={h.close} />);
    expect(h.get).not.toHaveBeenCalled();
    await render(<CheckoutRecoveryDialog isOpen onClose={h.close} />);
    expect(h.get).toHaveBeenCalledWith("billing/checkouts", { params: { workspaceId: undefined } });
    expect(dialog()?.textContent).toContain(copy.allServers);
    await act(async () =>
      dialog()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(h.close).toHaveBeenCalledOnce();
    expect(h.post).not.toHaveBeenCalled();
  });

  it("clears the shared count only when a scoped recovery dialog confirms cancellation", async () => {
    function Count() { return <output>{usePendingCheckouts()?.count}</output>; }
    await render(<PendingCheckoutsProvider><Count />{recovery()}</PendingCheckoutsProvider>);
    expect(host.querySelector("output")?.textContent).toBe("1");
    await click(copy.cancel);
    h.post.mockResolvedValueOnce({ data: expired });
    await click(copy.confirmCancel);
    expect(host.querySelector("output")?.textContent).toBe("0");
    expect(dialog()?.textContent).toContain(copy.canceled);
  });
});
