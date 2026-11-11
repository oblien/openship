// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolvePlan } from "@repo/core";
import type { BillingState } from "@/lib/api/billing";
import { I18nProvider } from "@/components/i18n-provider";
import { baseDictionary } from "@/i18n";
import { PlatformProvider } from "@/context/PlatformContext";
import { CloudResourceContext } from "@/context/CloudResourceContext";
import { ManagedResourcesPage } from "./ManagedResourcesPage";
import type { ServerInfo } from "@/lib/api/system";

const h = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  usage: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  params: new URLSearchParams(),
  monitor: vi.fn(),
  billing: vi.fn(),
  checkouts: vi.fn(),
  resources: vi.fn(),
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  cancelPayment: vi.fn(),
}));
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({
    data: { user: { id: "owner" }, session: { activeOrganizationId: "org-a" } },
  }),
}));
vi.mock("@/lib/api/billing", () => ({
  billingApi: {
    getBillingState: h.billing,
    listCheckouts: h.checkouts,
    getResources: h.resources,
    cancelCheckout: h.cancelPayment,
  },
}));
vi.mock("@/lib/api/client", async (original) => ({
  ...(await original<typeof import("@/lib/api/client")>()),
  api: { get: h.apiGet, post: h.apiPost },
}));
vi.mock("@/hooks/useMonitorStream", () => ({
  useMonitorStream: h.monitor,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: h.replace, refresh: h.refresh }),
  useSearchParams: () => h.params,
}));
vi.mock("@/lib/api/system", () => ({
  systemApi: { listServers: h.list, getServerById: h.get, serverUsage: h.usage },
}));
vi.mock("@/context/CloudContext", () => ({
  useCloud: () => ({ connected: true, startConnect: vi.fn() }),
}));
const pool = (id: string, name: string, cpu = 2): ServerInfo => ({
  id,
  name,
  isLocal: false,
  connection: "cloud",
  sshHost: null,
  sshUser: "",
  sshPort: 22,
  sshAuthMethod: null,
  sshKeyPath: null,
  hasStoredKeyMaterial: false,
  sshJumpHost: null,
  sshArgs: null,
  sshTransport: "direct",
  hostChannel: null,
  country: null,
  projectCount: 1,
  createdAt: "2026-10-01T00:00:00Z",
  capabilities: {
    monitor: false,
    terminal: false,
    exec: false,
    hostConfiguration: false,
    ssh: false,
    networkSettings: false,
  },
  managed: {
    id: `workspace-${id}`,
    serverId: id,
    name,
    state: "running",
    planTierId: "starter",
    subscriptionStatus: "active",
    projectCount: 1,
    operation: null,
    createdAt: "2026-10-01T00:00:00Z",
    resources: { cpuCores: cpu, memoryMb: 8192, diskMb: 32768 },
  },
});
const usage = (name = "Application A") => ({
  measuredAt: "2026-10-01T00:00:00Z",
  available: true,
  reason: null,
  cpuPercent: 23,
  memoryUsedMb: 1024,
  memoryAvailableMb: 7168,
  diskUsedMb: 4096,
  diskAvailableMb: 28672,
  diskTotalMb: 32768,
  sharedDiskMb: 1024,
  projects: [{ id: "project-a", name, diskMb: 512 }],
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function billingFixture(workspaceId: string): BillingState {
  const offer = resolvePlan("starter");
  return {
    workspace: {
      id: workspaceId,
      serverId: workspaceId.replace("workspace-", ""),
      name: "Test plan",
    },
    tier: "starter",
    status: "active",
    currentPeriod: { start: "2026-10-01T00:00:00Z", end: "2026-11-01T00:00:00Z" },
    balance: { total: null, quotaLimit: null, quotaUsed: 0, quotaRemaining: null },
    monthlyCreditLimit: null,
    overQuota: false,
    buildTimeMinutes: 0,
    plan: {
      ...offer,
      features: [...offer.features],
      resourceLimits: offer.oblienLimits,
      listPrice: { monthly: offer.price.monthly },
      effectivePrice: { monthly: offer.price.monthly },
      campaign: null,
    },
    subscription: {
      tier: "starter",
      configuration: "preset",
      status: "active",
      interval: "monthly",
      cancelAtPeriodEnd: false,
      canceledAt: null,
      currentPeriod: { start: "2026-10-01T00:00:00Z", end: "2026-11-01T00:00:00Z" },
    },
    capabilities: { portal: true, cancellation: true, subscriptionChange: true },
    billing: { enabled: true },
  };
}
let root: Root, host: HTMLDivElement;
const render = (children: ReactNode = <ManagedResourcesPage />, scope = "account-a:org-a") =>
  act(async () => {
    root.render(
      <I18nProvider>
        <PlatformProvider selfHosted={false}>
          <CloudResourceContext value={scope}>{children}</CloudResourceContext>
        </PlatformProvider>
      </I18nProvider>,
    );
  });
const button = (label: string) => {
  const node = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent?.trim() === label || node.getAttribute("aria-label") === label,
  );
  expect(node, label).toBeDefined();
  return node!;
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.params = new URLSearchParams();
  h.monitor.mockReturnValue({
    usage: null,
    history: [],
    error: null,
    isConnected: false,
    paused: false,
    reconnect: vi.fn(),
  });
  h.list.mockResolvedValue([pool("a", "Production")]);
  h.get.mockResolvedValue(pool("a", "Production"));
  h.usage.mockResolvedValue(usage());
  h.billing.mockImplementation(async (id: string) => billingFixture(id));
  h.checkouts.mockResolvedValue({ items: [] });
  h.resources.mockResolvedValue({
    compute: { status: "unavailable" },
    edge: { status: "unavailable", limits: {} },
  });
  h.apiGet.mockResolvedValue({ data: { usage: null } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("shows plan capacity and assigned projects without live metrics or host controls", async () => {
  await render();
  expect(host.querySelector("h1")?.textContent).toBe("Starter");
  expect(host.textContent).not.toContain(baseDictionary.servers.resources.usageTitle);
  expect(h.monitor).toHaveBeenLastCalledWith(null, false, "usage");
  expect(h.resources).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Application A");
  expect(host.querySelector('a[href="/projects/project-a"]')).not.toBeNull();
  expect(host.textContent).not.toMatch(/SSH|Terminal|Runtime API|Networking|Workloads/);
  expect(h.usage).toHaveBeenCalledExactlyOnceWith("a");
});
it("uses only the selected pool allocation and clears old projects on switching", async () => {
  h.list.mockResolvedValue([pool("a", "Production", 2), pool("b", "Staging", 8)]);
  await render();
  expect(host.textContent).toContain("vCPU2");
  const next = deferred<ReturnType<typeof usage>>();
  h.usage.mockReturnValueOnce(next.promise);
  h.params = new URLSearchParams("pool=b");
  await render();
  expect(host.textContent).toContain("vCPU8");
  expect(host.textContent).not.toContain("Application A");
  expect(h.usage.mock.calls.map((call) => call[0])).toEqual(["a", "b"]);
  await act(async () => next.resolve(usage("Application B")));
  expect(host.textContent).toContain("Application B");
  expect(host.textContent).not.toContain("vCPU10");
});
it("shows inventory failures with a working retry instead of an empty pool", async () => {
  h.list.mockRejectedValueOnce(new Error("Connection lost"));
  await render();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Connection lost");
  expect(host.textContent).not.toContain(baseDictionary.servers.resources.emptyTitle);
  await act(async () => button(baseDictionary.billing.plansRoute.tryAgain).click());
  expect(host.textContent).toContain("Application A");
});
it("shows unknown usage after a lost request and can refresh it", async () => {
  h.usage.mockRejectedValueOnce(new Error("Usage unavailable"));
  await render();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Usage unavailable");
  expect(host.textContent).not.toContain(baseDictionary.servers.resources.noProjects);
  const refreshes = [...host.querySelectorAll<HTMLButtonElement>("button[aria-label]")].filter(
    (node) => node.getAttribute("aria-label") === baseDictionary.billing.resourceOverview.refresh,
  );
  await act(async () => refreshes[1]!.click());
  expect(host.textContent).toContain("Application A");
});
it("ignores an old account's pending inventory after a scope change", async () => {
  const old = deferred<ServerInfo[]>();
  h.list.mockReturnValueOnce(old.promise);
  await render();
  h.list.mockResolvedValueOnce([pool("b", "New account")]);
  h.usage.mockResolvedValueOnce(usage("New account app"));
  await render(<ManagedResourcesPage />, "account-b:org-b");
  await act(async () => old.resolve([pool("a", "Previous account")]));
  expect(host.textContent).toContain("New account app");
  expect(host.textContent).not.toContain("Previous account");
  expect(h.usage).toHaveBeenCalledExactlyOnceWith("b");
});
it("does not silently select a different pool when an old bookmark is unavailable", async () => {
  h.params = new URLSearchParams("pool=missing");
  await render();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    baseDictionary.servers.resources.notFound,
  );
  expect(h.usage).not.toHaveBeenCalled();
});
it("maps retained server detail links to the pool overview even with a host tab", async () => {
  h.params = new URLSearchParams("tab=terminal");
  await render(<ManagedResourcesPage serverId="a" />);
  expect(host.textContent).toContain("Application A");
  expect(host.textContent).not.toContain("Terminal");
  expect(h.get).toHaveBeenCalledExactlyOnceWith("a");
});

it("does not call an unobserved pool empty when usage is unavailable", async () => {
  h.usage.mockResolvedValueOnce({
    ...usage(),
    available: false,
    reason: "Temporarily unavailable",
    projects: [],
    cpuPercent: null,
  });
  await render();
  expect(host.textContent).toContain("Temporarily unavailable");
  expect(host.textContent).not.toContain(baseDictionary.servers.resources.noProjects);
});

it("opens the named plan without repeating its name in a Cloud space selector", async () => {
  h.list.mockResolvedValue([pool("a", "Production"), pool("b", "Staging")]);
  await render();
  expect(host.querySelector("h1")?.textContent).toBe("Starter");
  expect(host.querySelector('button[aria-haspopup="listbox"]')).toBeNull();
  expect(host.querySelector('a[href="/billing"]')).toBeNull();
  expect(host.textContent).not.toContain("Staging");
});

it("shows unfinished Cloud setup without attempting a live connection or exposing old server copy", async () => {
  h.params = new URLSearchParams("pool=a&tab=usage");
  const space = pool("a", "Production");
  space.managed!.state = "not_provisioned";
  h.list.mockResolvedValue([space]);
  h.usage.mockResolvedValue({
    ...usage(),
    available: false,
    reason: "The managed server has not been provisioned yet",
    projects: [],
    cpuPercent: null,
  });
  await render();
  expect(host.textContent).toContain(baseDictionary.servers.resources.setupPending);
  expect(host.textContent).not.toContain("managed server");
  expect(host.textContent).not.toContain(baseDictionary.servers.resources.connecting);
  expect(h.monitor).toHaveBeenLastCalledWith(null, false, "usage");
});

it("keeps subscription management on the selected plan page", async () => {
  h.params = new URLSearchParams("pool=b");
  h.list.mockResolvedValue([pool("a", "Production"), pool("b", "Staging")]);
  await render();
  expect(h.billing).toHaveBeenCalledExactlyOnceWith("workspace-b");
  expect(host.querySelector('a[href^="/billing/plans"]')).toBeNull();
  expect(host.querySelector('a[href^="/billing/overview"]')).toBeNull();
  expect(button(baseDictionary.billing.workspaces.changePlan)).toBeDefined();
  expect(host.textContent).not.toContain(baseDictionary.billing.portal.openButton);
  h.params = new URLSearchParams("pool=b&tab=payment");
  await render();
  expect(button(baseDictionary.billing.portal.openButton)).toBeDefined();
  expect(host.textContent).not.toContain(baseDictionary.servers.resources.managePlan);
  expect(host.textContent).not.toContain(baseDictionary.billing.subscription.cancel);
});

it("rejects another plan's billing response without exposing its actions", async () => {
  h.billing.mockResolvedValue(billingFixture("wrong-workspace"));
  await render();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "Billing data did not match this plan",
  );
  expect(host.textContent).not.toContain(baseDictionary.billing.portal.openButton);
  expect(host.textContent).toContain("Application A");
});

const partialLiveSample = {
  measuredAt: "2026-10-01T00:00:05Z",
  cpuPercent: 35,
  memoryUsedMb: 2048,
  memoryAvailableMb: 6144,
  diskUsedMb: null,
  diskAvailableMb: null,
  diskTotalMb: null,
};
it.each([
  {
    name: "keeps the host snapshot when live metrics omit storage",
    live: partialLiveSample,
    history: [],
    snapshot: usage(),
    expected: "4 GB / 32 GB",
    older: true,
  },
  {
    name: "accepts measured zero storage instead of replacing it with the snapshot",
    live: { ...partialLiveSample, diskUsedMb: 0, diskAvailableMb: 32768, diskTotalMb: 32768 },
    history: [],
    snapshot: usage(),
    expected: "0 GB / 32 GB",
    older: false,
  },
  {
    name: "keeps the recent live storage reading ahead of the older snapshot after a partial frame",
    live: partialLiveSample,
    history: [{ ...partialLiveSample, measuredAt: "2026-10-01T00:00:04Z", diskUsedMb: 5120 }],
    snapshot: usage(),
    expected: "5 GB / 32 GB",
    older: true,
  },
  {
    name: "prefers a refreshed snapshot to an older live storage reading",
    live: partialLiveSample,
    history: [{ ...partialLiveSample, measuredAt: "2026-10-01T00:00:04Z", diskUsedMb: 5120 }],
    snapshot: {
      ...usage(),
      measuredAt: "2026-10-01T00:00:06Z",
      diskUsedMb: 8192,
      memoryUsedMb: 2048,
      memoryAvailableMb: 6144,
    },
    expected: "8 GB / 32 GB",
    older: false,
  },
  {
    name: "leaves storage unknown when neither source measured it despite known allocation",
    live: partialLiveSample,
    history: [],
    snapshot: { ...usage(), diskUsedMb: null, diskAvailableMb: null, diskTotalMb: null },
    expected: "— GB / 32 GB",
    older: false,
  },
])("$name", async ({ live, history, snapshot, expected, older }) => {
  h.params = new URLSearchParams("pool=a&tab=usage");
  h.usage.mockResolvedValue(snapshot);
  h.monitor.mockReturnValue({
    usage: live,
    history: [...history, live],
    error: null,
    isConnected: true,
    paused: false,
    reconnect: vi.fn(),
  });
  await render();
  const storage = [...host.querySelectorAll("p")].find(
    (node) => node.textContent === baseDictionary.billing.workspaces.diskUsage,
  )!.parentElement!;
  expect(storage.textContent).toContain(expected);
  if (older) expect(storage.textContent).toContain(baseDictionary.billing.workspaces.measuredAt);
  else expect(storage.textContent).not.toContain(baseDictionary.billing.workspaces.measuredAt);
  expect(host.textContent).toContain("2 GB / 8 GB");
});

const pendingPayment = (workspace = "a") => ({
  id: "payment-" + workspace,
  checkoutId: "cs-" + workspace,
  server: pool(workspace, workspace === "a" ? "Production" : "Private staging").managed!,
  kind: "subscription",
  name: "Pro monthly",
  amountCents: 4700,
  currency: "usd",
  interval: "monthly",
  state: "open",
  canResume: true,
  canCancel: true,
});
it("keeps usage history on the plan and reads only its workspace", async () => {
  h.params = new URLSearchParams("pool=b&tab=usage");
  h.list.mockResolvedValue([pool("b", "Staging")]);
  await render();
  expect(host.querySelector("h1")?.textContent).toBe("Starter");
  expect(h.usage).toHaveBeenCalledExactlyOnceWith("b");
  expect(h.resources).toHaveBeenCalledExactlyOnceWith("workspace-b");
  expect(h.monitor).toHaveBeenLastCalledWith("b", true, "usage");
  expect(h.apiGet).toHaveBeenCalledWith(
    "billing/usage",
    expect.objectContaining({ params: expect.objectContaining({ workspaceId: "workspace-b" }) }),
  );
  expect(h.billing).toHaveBeenCalledExactlyOnceWith("workspace-b");
});
it("shows the pending warning and recovery list inside the plan's payments tab using one read", async () => {
  h.params = new URLSearchParams("pool=a&tab=payment");
  h.checkouts.mockResolvedValue({ items: [pendingPayment()] });
  await render();
  expect(host.querySelector("h1")?.textContent).toBe("Starter");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    baseDictionary.billing.hub.paymentRequired,
  );
  expect(host.textContent).toContain("Pro monthly");
  expect(h.checkouts).toHaveBeenCalledExactlyOnceWith("workspace-a");
  expect(h.usage).not.toHaveBeenCalled();
  expect(host.querySelector('a[aria-current="page"]')?.getAttribute("href")).toBe(
    "/resources?pool=a&tab=payment",
  );
});
it("keeps the warning on overview and links into this plan's payments", async () => {
  h.params = new URLSearchParams("pool=a");
  h.checkouts.mockResolvedValue({ items: [pendingPayment()] });
  await render();
  expect(host.querySelector('[role="alert"] a')?.getAttribute("href")).toBe(
    "/resources?pool=a&tab=payment",
  );
  expect(host.textContent).not.toContain(baseDictionary.billing.pendingPayments.title);
});
it("does not expose another plan's pending payment in a scoped recovery response", async () => {
  h.params = new URLSearchParams("pool=a&tab=payment");
  h.checkouts.mockResolvedValue({ items: [pendingPayment("b")] });
  await render();
  expect(host.textContent).not.toContain("Private staging");
  expect(host.textContent).toContain(baseDictionary.billing.pendingPayments.loadError);
});
it("keeps recovery available when the plan's billing snapshot is temporarily unavailable", async () => {
  h.params = new URLSearchParams("pool=a&tab=payment");
  h.billing.mockRejectedValue(new Error("Billing unavailable"));
  h.checkouts.mockResolvedValue({ items: [pendingPayment()] });
  await render();
  expect(host.textContent).toContain("Pro monthly");
  expect(host.textContent).toContain(baseDictionary.billing.pendingPayments.resume);
});
it("only clears the plan warning after confirmed cancellation", async () => {
  h.params = new URLSearchParams("pool=a&tab=payment");
  h.checkouts.mockResolvedValue({ items: [pendingPayment()] });
  h.cancelPayment.mockResolvedValue({ status: "canceling", checkoutId: "cs-a", checkoutUrl: null });
  await render();
  await act(async () => button(baseDictionary.billing.pendingPayments.cancel).click());
  expect(h.cancelPayment).not.toHaveBeenCalled();
  await act(async () => button(baseDictionary.billing.pendingPayments.confirmCancel).click());
  expect(h.cancelPayment).toHaveBeenCalledExactlyOnceWith({
    workspaceId: "workspace-a",
    id: "payment-a",
  });
  expect(host.textContent).toContain(baseDictionary.billing.hub.paymentRequired);
  h.cancelPayment.mockResolvedValue({ status: "expired", checkoutId: "cs-a", checkoutUrl: null });
  await act(async () => button(baseDictionary.billing.pendingPayments.retryCancel).click());
  expect(host.textContent).not.toContain(baseDictionary.billing.hub.paymentRequired);
});

it("uses the plan name instead of the infrastructure label", async () => {
  const server = pool("a", "Pro server");
  server.managed!.planTierId = "pro";
  h.list.mockResolvedValue([server]);
  const state = billingFixture("workspace-a");
  h.billing.mockResolvedValue({ ...state, plan: { ...state.plan, name: "Pro" } });
  await render();
  expect(host.querySelector("h1")?.textContent).toBe("Pro");
  expect(host.textContent).not.toContain("Pro server");
});

it("moves live metrics and compute totals to Usage and stops streaming when leaving it", async () => {
  await render();
  expect(host.textContent).not.toContain(baseDictionary.billing.resourceOverview.computeTitle);
  expect(h.resources).not.toHaveBeenCalled();
  h.params = new URLSearchParams("pool=a&tab=usage");
  await render();
  expect(host.textContent).toContain(baseDictionary.servers.resources.usageTitle);
  expect(host.textContent).toContain(baseDictionary.billing.resourceOverview.computeTitle);
  expect(host.textContent).not.toContain(baseDictionary.servers.resources.projectsAssigned);
  expect(h.monitor).toHaveBeenLastCalledWith("a", true, "usage");
  // Switching between overview and usage reuses the existing project/resource snapshot.
  expect(h.usage).toHaveBeenCalledExactlyOnceWith("a");
  h.params = new URLSearchParams("pool=a");
  await render();
  expect(h.monitor).toHaveBeenLastCalledWith(null, false, "usage");
  expect(host.textContent).not.toContain(baseDictionary.billing.resourceOverview.computeTitle);
});

it("limits the overview to four projects and opens the full scoped list without another read", async () => {
  h.usage.mockResolvedValue({
    ...usage(),
    projects: Array.from({ length: 6 }, (_, i) => ({
      id: `project-${i}`,
      name: `Application ${i}`,
      diskMb: null,
    })),
  });
  await render();
  expect(host.querySelectorAll('a[href^="/projects/"]')).toHaveLength(4);
  const showAll = button("Show all 6 projects");
  showAll.focus();
  await act(async () => showAll.click());
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog.querySelectorAll('a[href^="/projects/"]')).toHaveLength(6);
  expect(h.usage).toHaveBeenCalledOnce();
  const search = dialog.querySelector<HTMLInputElement>('input[type="search"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      search,
      "Application 5",
    );
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(dialog.querySelectorAll('a[href^="/projects/"]')).toHaveLength(1);
  expect(dialog.querySelector("a")?.getAttribute("href")).toBe("/projects/project-5");
  await act(async () =>
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
  );
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(showAll);
});

it("does not offer a full list for four projects or retain a dialog after changing workspace", async () => {
  h.usage.mockResolvedValue({
    ...usage(),
    projects: Array.from({ length: 4 }, (_, i) => ({
      id: `project-${i}`,
      name: `Application ${i}`,
      diskMb: null,
    })),
  });
  await render();
  expect(host.textContent).not.toContain("Show all");
  h.list.mockResolvedValue([pool("b", "Another plan")]);
  h.usage.mockResolvedValue({
    ...usage(),
    projects: Array.from({ length: 5 }, (_, i) => ({
      id: `project-${i}`,
      name: `Private ${i}`,
      diskMb: null,
    })),
  });
  await render(<ManagedResourcesPage />, "account-b:org-b");
  await act(async () => button("Show all 5 projects").click());
  h.list.mockResolvedValue([pool("c", "Third plan")]);
  h.usage.mockResolvedValue(usage("Third app"));
  await render(<ManagedResourcesPage />, "account-c:org-c");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.body.textContent).not.toContain("Private");
});

it("uses the saved offer name for custom or older subscriptions", async () => {
  const state = billingFixture("workspace-a");
  h.billing.mockResolvedValue({ ...state, plan: { ...state.plan, name: "Custom Cloud plan" } });
  await render();
  expect(host.querySelector("h1")?.textContent).toBe("Custom Cloud plan");
  expect(h.billing).toHaveBeenCalledOnce();
});
