// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PRICING } from "@repo/core";
import type { BillingPendingCheckout, ManagementState, ServerDetail } from "@repo/contracts";
import { I18nProvider } from "@/components/i18n-provider";
import { baseDictionary } from "@/i18n";
import { BillingHome } from "./BillingHome";

const h = vi.hoisted(() => ({
  user: "owner-a",
  org: "org-a",
  cloud: "cloud-a",
  list: vi.fn(),
  management: vi.fn(),
  checkouts: vi.fn(),
  replace: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: h.replace }) }));
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: h.user }, session: { activeOrganizationId: h.org } } }),
}));
vi.mock("@/context/CloudResourceContext", () => ({ useCloudResourceKey: () => h.cloud }));
vi.mock("@/lib/api/system", () => ({ systemApi: { listServerDestinations: h.list } }));
vi.mock("@/lib/api/billing", () => ({ billingApi: { listCheckouts: h.checkouts } }));
vi.mock("@/lib/api/management", () => ({ managementApi: { get: h.management } }));

const space = (id: string, name: string, tier = "starter") =>
  ({
    id,
    name,
    connection: "cloud",
    isLocal: false,
    projectCount: 2,
    managed: {
      id: `subscription-${id}`,
      serverId: id,
      name,
      planTierId: tier,
      subscriptionStatus: "active",
      projectCount: 2,
      state: tier === "free" ? "needs_plan" : "running",
      operation: null,
      resources: tier === "free" ? null : { cpuCores: 2, memoryMb: 8192, diskMb: 32768 },
      createdAt: "2026-10-01T00:00:00Z",
    },
  }) as ServerDetail;
const freeManagement = (): ManagementState => ({
  pricing: PRICING.management,
  purchasesAvailable: true,
  cloudIncluded: false,
  active: false,
  connectedServers: 0,
  serverLimit: 0,
  pendingCheckout: false,
  subscription: null,
  change: null,
});
const paidManagement = (): ManagementState => ({
  ...freeManagement(),
  active: true,
  connectedServers: 2,
  serverLimit: 3,
  subscription: {
    plan: "priority",
    servers: 3,
    baseIncluded: false,
    priceCents: 2300,
    status: "active",
    periodEnd: "2026-12-01T00:00:00Z",
    cancelAtPeriodEnd: false,
  },
});
let host: HTMLDivElement, root: Root;
const render = () =>
  act(async () =>
    root.render(
      <I18nProvider>
        <BillingHome />
      </I18nProvider>,
    ),
  );
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.user = "owner-a";
  h.org = "org-a";
  h.cloud = "cloud-a";
  h.list.mockResolvedValue({ servers: [] });
  h.management.mockResolvedValue(freeManagement());
  h.checkouts.mockResolvedValue({ items: [] });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("shows one card per Cloud space, a saved Manage subscription and an Add plan card", async () => {
  h.list.mockResolvedValue({
    servers: [
      space("production", "Production"),
      space("staging", "Staging"),
      { id: "customer-host", name: "External server" },
    ],
  });
  h.management.mockResolvedValue(paidManagement());
  await render();
  const production = host.querySelector('a[href="/resources?pool=production"]')!;
  expect(production.querySelector("h2")?.textContent).toBe("Starter");
  expect(production.textContent).toContain("8 GB");
  expect(production.textContent).toContain("2 projects");
  expect(host.querySelector('a[href="/resources?pool=staging"]')).not.toBeNull();
  const manage = host.querySelector('a[href="/billing/manage?organizationId=org-a"]')!;
  expect(manage.textContent).toContain("Priority");
  expect(manage.textContent).toContain("3 connected servers");
  expect(host.textContent).not.toContain("External server");
  expect(
    host.querySelector('a[href="/billing/plans?newServer=1&organizationId=org-a"]')?.textContent,
  ).toContain(baseDictionary.billing.hub.addPlan);
  expect(h.list).toHaveBeenCalledOnce();
  expect(h.management).toHaveBeenCalledOnce();
  expect(h.replace).not.toHaveBeenCalled();
});

it("does not invent a separate purchased subscription for included Basic management", async () => {
  h.list.mockResolvedValue({ servers: [space("production", "Production")] });
  h.management.mockResolvedValue({
    ...freeManagement(),
    cloudIncluded: true,
    active: true,
    serverLimit: 2,
  });
  await render();
  expect(host.querySelector('a[href*="/billing/manage"]')).toBeNull();
  expect(host.querySelector('a[href="/resources?pool=production"]')).not.toBeNull();
  expect(h.replace).not.toHaveBeenCalled();
});

it("replaces the empty billing overview with the plans route, including when only unpaid drafts exist", async () => {
  h.list.mockResolvedValue({ servers: [space("draft", "Unpaid draft", "free")] });
  await render();
  expect(h.replace).toHaveBeenCalledExactlyOnceWith(
    "/billing/plans?newServer=1&organizationId=org-a",
  );
  expect(host.textContent).not.toContain("Unpaid draft");
  expect(host.querySelector('[role="status"]')).not.toBeNull();
  expect(host.querySelector('a[href*="/billing/plans"]')).toBeNull();
});

it("waits for both inventories before deciding an account has no purchased plans", async () => {
  let finish!: (value: ManagementState) => void;
  h.management.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await render();
  expect(h.replace).not.toHaveBeenCalled();
  expect(host.querySelector('[role="status"]')).not.toBeNull();
  await act(async () => finish(paidManagement()));
  expect(host.textContent).toContain("Priority");
  expect(h.replace).not.toHaveBeenCalled();
});

it("waits for the Cloud inventory before redirecting an empty account", async () => {
  let finish!: (value: { servers: ServerDetail[] }) => void;
  h.list.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await render();
  expect(h.replace).not.toHaveBeenCalled();
  await act(async () => finish({ servers: [] }));
  expect(h.replace).toHaveBeenCalledExactlyOnceWith(
    "/billing/plans?newServer=1&organizationId=org-a",
  );
});

it("keeps inventory failures distinct from an empty account and retries the same reads", async () => {
  h.list.mockRejectedValueOnce(new Error("Inventory unavailable"));
  await render();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Inventory unavailable");
  expect(h.replace).not.toHaveBeenCalled();
  await act(async () => host.querySelector<HTMLButtonElement>('[role="alert"] button')!.click());
  expect(h.list).toHaveBeenCalledTimes(2);
  expect(h.replace).toHaveBeenCalledExactlyOnceWith(
    "/billing/plans?newServer=1&organizationId=org-a",
  );
});

it("discards the previous account's cards immediately and ignores late inventory responses", async () => {
  let finishOld!: (value: { servers: ServerDetail[] }) => void;
  h.list.mockReturnValueOnce(
    new Promise((resolve) => {
      finishOld = resolve;
    }),
  );
  await render();
  h.user = "owner-b";
  h.org = "org-b";
  h.list.mockResolvedValue({ servers: [space("new", "New account space")] });
  await render();
  await act(async () => finishOld({ servers: [space("private-old", "Private old space")] }));
  expect(host.textContent).not.toContain("Private old space");
  expect(host.querySelector('a[href="/resources?pool=new"]')).not.toBeNull();
  expect(host.querySelector('a[href="/resources?pool=private-old"]')).toBeNull();
  expect(
    host.querySelector('a[href="/billing/plans?newServer=1&organizationId=org-b"]'),
  ).not.toBeNull();
  expect(h.replace).not.toHaveBeenCalled();
});

const pendingPayment = (
  server = space("draft", "Pending production", "free"),
): BillingPendingCheckout => ({
  id: "payment-one",
  checkoutId: "cs-one",
  server: server.managed!,
  kind: "subscription",
  name: "Pro monthly",
  amountCents: 4700,
  currency: "usd",
  interval: "monthly",
  state: "open",
  canResume: true,
  canCancel: true,
});
it("shows unpaid drafts as pending plan cards instead of redirecting to purchases", async () => {
  const pending = pendingPayment();
  h.checkouts.mockResolvedValue({ items: [pending] });
  await render();
  const card = host.querySelector('a[href="/resources?pool=draft&tab=payment"]')!;
  expect(card.querySelector("h2")?.textContent).toBe("Pro monthly");
  expect(card.textContent).toContain("$47.00");
  expect(card.textContent).toContain(baseDictionary.billing.hub.paymentRequired);
  expect(host.querySelector('a[href*="/billing/payment"]')).toBeNull();
  expect(h.replace).not.toHaveBeenCalled();
});
it("adds payment attention to the existing plan card without duplicating it", async () => {
  const server = space("production", "Production");
  h.list.mockResolvedValue({ servers: [server] });
  h.checkouts.mockResolvedValue({
    items: [pendingPayment(server), { ...pendingPayment(server), id: "payment-two" }],
  });
  await render();
  expect(host.querySelectorAll('a[href^="/resources?pool=production"]')).toHaveLength(1);
  expect(host.querySelector('a[href="/resources?pool=production&tab=payment"]')).not.toBeNull();
});
it("waits for unfinished-payment inventory before deciding an account is empty", async () => {
  let finish!: (value: { items: BillingPendingCheckout[] }) => void;
  h.checkouts.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await render();
  expect(h.replace).not.toHaveBeenCalled();
  await act(async () => finish({ items: [pendingPayment()] }));
  expect(h.replace).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Pro monthly");
});
it("keeps payment lookup failures distinct from an empty account", async () => {
  h.checkouts.mockRejectedValue(new Error("Payments unavailable"));
  await render();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Payments unavailable");
  expect(h.replace).not.toHaveBeenCalled();
});
it("keeps an unfinished Manage purchase as a plan card before a subscription exists", async () => {
  h.management.mockResolvedValue({ ...freeManagement(), pendingCheckout: true });
  await render();
  const card = host.querySelector('a[href="/billing/manage?tab=payment&organizationId=org-a"]')!;
  expect(card.textContent).toContain(baseDictionary.billing.hub.paymentRequired);
  expect(h.replace).not.toHaveBeenCalled();
});
it("keeps renewal payment recovery on the existing plan", async () => {
  const server = space("production", "Production");
  server.managed!.subscriptionStatus = "past_due";
  h.list.mockResolvedValue({ servers: [server] });
  await render();
  expect(
    host.querySelector('a[href="/resources?pool=production&tab=payment"]')?.textContent,
  ).toContain(baseDictionary.billing.hub.paymentRequired);
});

it("matches an existing linked plan through its canonical Cloud reference without adding another card", async () => {
  const local = space("local-production", "Production");
  local.cloudReference = {
    serverId: "remote-production",
    workspaceId: "subscription-remote-production",
  };
  h.list.mockResolvedValue({ servers: [local] });
  h.checkouts.mockResolvedValue({
    items: [pendingPayment(space("remote-production", "Cloud production"))],
  });
  await render();
  expect(host.querySelectorAll('a[href^="/resources?pool="]')).toHaveLength(1);
  expect(
    host.querySelector('a[href="/resources?pool=local-production&tab=payment"]')?.textContent,
  ).toContain(baseDictionary.billing.hub.paymentRequired);
});
