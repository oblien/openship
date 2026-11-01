// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
  params: new URLSearchParams(),
  monitor: vi.fn(),
}));
vi.mock("@/hooks/useMonitorStream", () => ({
  useMonitorStream: h.monitor,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: h.replace }),
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
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("shows measured pool usage and assigned projects with no host controls", async () => {
  await render();
  expect(host.textContent).toContain("Cloud spaces");
  expect(host.textContent).toContain("23");
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

it("switches spaces through the compact menu with plan and project counts", async () => {
  h.list.mockResolvedValue([
    pool("a", "Production"),
    {
      ...pool("b", "Staging"),
      projectCount: 4,
      managed: { ...pool("b", "Staging").managed!, projectCount: 4 },
    },
  ]);
  await render();
  const picker = button(baseDictionary.servers.resources.selectPool);
  expect(picker.textContent).toContain("Production");
  expect(picker.textContent).toContain("1 project");
  expect(picker.textContent).toContain("Starter");
  expect(host.textContent).not.toContain("Staging");
  await act(async () => picker.click());
  const choices = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')];
  expect(choices).toHaveLength(2);
  expect(choices[0]?.getAttribute("aria-selected")).toBe("true");
  expect(choices[1]?.textContent).toContain("4 projects");
  await act(async () => choices[1]!.click());
  expect(h.replace).toHaveBeenCalledWith("/resources?pool=b", { scroll: false });
});

it("shows unfinished Cloud setup without attempting a live connection or exposing old server copy", async () => {
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

it("keeps billing links on the selected subscription and new purchases separate", async () => {
  h.params = new URLSearchParams("pool=b");
  h.list.mockResolvedValue([pool("a", "Production"), pool("b", "Staging")]);
  await render();
  expect(host.querySelector('a[href="/billing/plans?workspaceId=workspace-b"]')).not.toBeNull();
  expect(host.querySelector('a[href="/billing/overview?workspaceId=workspace-b"]')).not.toBeNull();
  expect(host.querySelector('a[href="/billing/plans?newServer=1"]')).not.toBeNull();
  expect(host.querySelector('a[href*="workspace-a"]')).toBeNull();
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
