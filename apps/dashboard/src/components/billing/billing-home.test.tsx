// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PRICING } from "@repo/core";
import type { ManagementState, ServerDetail } from "@repo/contracts";
import { I18nProvider } from "@/components/i18n-provider";
import { baseDictionary } from "@/i18n";
import { BillingHome } from "./BillingHome";

const h = vi.hoisted(() => ({
  user: "owner-a",
  org: "org-a",
  cloud: "cloud-a",
  list: vi.fn(),
  management: vi.fn(),
  replace: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: h.replace }) }));
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: h.user }, session: { activeOrganizationId: h.org } } }),
}));
vi.mock("@/context/CloudResourceContext", () => ({ useCloudResourceKey: () => h.cloud }));
vi.mock("@/lib/api/system", () => ({ systemApi: { listServerDestinations: h.list } }));
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
  expect(production.textContent).toContain("Production");
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
  h.list.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
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
  expect(host.textContent).toContain("New account space");
  expect(
    host.querySelector('a[href="/billing/plans?newServer=1&organizationId=org-b"]'),
  ).not.toBeNull();
  expect(h.replace).not.toHaveBeenCalled();
});
