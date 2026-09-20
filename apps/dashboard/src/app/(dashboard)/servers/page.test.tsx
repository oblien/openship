// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClusterCapabilities, ServerCluster, ComputeCluster } from "@repo/contracts";
import type { ManagedNetworkPreparation, ManagedNetworkPreparationSummary } from "@repo/core";
import { I18nProvider } from "@/components/i18n-provider";
import { PlatformProvider } from "@/context/PlatformContext";
import { baseDictionary } from "@/i18n";
import ServersPage from "./page";
import {
  managedPreparationFixture,
  managedPreparationSummaryFixture,
} from "../../../../../../packages/contracts/test/managed-network-fixtures";
import { serverClusterFixture } from "../../../../../../packages/contracts/test/server-cluster-fixtures";

type OverviewSnapshot = {
  networks: ServerCluster[];
  computeClusters: ComputeCluster[];
  preparations: ManagedNetworkPreparationSummary[];
};

const h = vi.hoisted(() => ({
  search: "",
  replace: vi.fn(),
  push: vi.fn(),
  servers: vi.fn(),
  capabilities: vi.fn(),
  clusters: vi.fn(),
  discardPreparation: vi.fn(),
  subscribe: vi.fn(),
  reconnect: vi.fn(),
  overview: { networks: [], preparations: [], computeClusters: [] } as OverviewSnapshot,
  receive: null as ((snapshot: OverviewSnapshot) => void) | null,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: h.replace, push: h.push }),
  useSearchParams: () => new URLSearchParams(h.search),
}));
vi.mock("@/lib/api", () => ({
  systemApi: { listServers: h.servers },
  getApiErrorMessage: (error: Error) => error.message,
}));
vi.mock("@/lib/api/private-networks", () => ({
  privateNetworksApi: {
    capabilities: h.capabilities,
    list: h.clusters,
    discardPreparation: h.discardPreparation,
  },
}));
vi.mock("@/hooks/useRunEvents", () => ({
  useRunEvents: (path: string | null, onSnapshot: (snapshot: OverviewSnapshot) => void) => {
    useEffect(() => {
      if (!path) return;
      h.subscribe(path);
      h.receive = onSnapshot;
      onSnapshot(h.overview);
      return () => {
        h.receive = null;
      };
    }, [path]);
    return { connected: !!path, reconnecting: false, error: null, reconnect: h.reconnect };
  },
}));
// Keep the actual page, platform context, tabs, and cluster overview. Managed
// containers and their mutation modal are unrelated to navigation.
vi.mock("@/hooks/useInfraFleet", () => ({
  useInfraFleet: () => ({ summaries: new Map() }),
}));
vi.mock("@/hooks/useSystemPrepareModal", () => ({
  useContainerApplyModal: () => vi.fn(),
}));

const capabilities: ClusterCapabilities = {
  available: true,
  reason: null,
  canManage: true,
  maxMembers: 16,
  modes: ["native"],
  providers: [],
};
const c = baseDictionary.servers.networks;
const pools = baseDictionary.servers.clusters;
let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.search = "";
  h.servers.mockResolvedValue([]);
  h.capabilities.mockResolvedValue(capabilities);
  h.clusters.mockResolvedValue([]);
  h.overview = { networks: [], preparations: [], computeClusters: [] };
  h.receive = null;
  h.discardPreparation.mockResolvedValue({
    ...managedPreparationFixture(),
    sequence: 2,
    status: "cancelled",
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function render(deployMode = "desktop", selfHosted = true) {
  await act(async () => {
    root.render(
      <I18nProvider initialLocale="en" initialDictionary={baseDictionary}>
        <PlatformProvider deployMode={deployMode} selfHosted={selfHosted}>
          <ServersPage />
        </PlatformProvider>
      </I18nProvider>,
    );
  });
}
function tab(name: "cluster" | "networking") {
  return host.querySelector<HTMLAnchorElement>(`a[href="/servers?tab=${name}"]`);
}
function setupActions(name: string) {
  return [...host.querySelectorAll("button")].find(
    (button) =>
      button.getAttribute("aria-label") === c.managed.setupActions.replace("{name}", name),
  );
}
async function click(label: string, scope: ParentNode = host) {
  const button = [...scope.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === label,
  );
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
}

describe("server cluster navigation", () => {
  it("shows separate groups for networks at the same provider and updates them through the shared stream", async () => {
    const first = serverClusterFixture();
    if (first.network.mode !== "native") throw new Error("Expected native fixture");
    first.network = {
      ...first.network,
      mode: "native",
      source: { providerId: "aws", networkRef: "vpc-a" },
    };
    const second: ServerCluster = {
      ...first,
      id: "cluster-b",
      name: "Analytics",
      network: {
        ...first.network,
        id: "network-b",
        source: { providerId: "aws", networkRef: "vpc-b" },
      },
    };
    h.search = "tab=networking";
    h.overview = { networks: [first, second], preparations: [], computeClusters: [] };
    await render();
    expect(
      host.querySelector('a[href="/servers/networks/cluster-a?tab=network&from=networking"]'),
    ).not.toBeNull();
    expect(
      host.querySelector('a[href="/servers/networks/cluster-b?tab=network&from=networking"]'),
    ).not.toBeNull();
    expect(host.textContent).toContain("vpc-a");
    expect(host.textContent).toContain("vpc-b");
    expect(host.querySelectorAll(".react-flow__edge")).toHaveLength(0);
    await act(async () =>
      h.receive?.({
        networks: [{ ...second, name: "Analytics renamed" }],
        preparations: [],
        computeClusters: [],
      }),
    );
    expect(
      host.querySelector('a[href="/servers/networks/cluster-a?tab=network&from=networking"]'),
    ).toBeNull();
    expect(host.textContent).toContain("Analytics renamed");
    expect(h.subscribe).toHaveBeenCalledTimes(1);
    expect(h.clusters).not.toHaveBeenCalled();
    expect(h.reconnect).not.toHaveBeenCalled();
  });
  it.each(["desktop", "docker"])(
    "opens both infrastructure views from /servers on %s",
    async (mode) => {
      await render(mode);
      expect(tab("cluster")).not.toBeNull();
      expect(tab("networking")).not.toBeNull();
      await act(async () => tab("cluster")!.click());
      expect(h.replace).toHaveBeenLastCalledWith("/servers?tab=cluster");
      h.search = "tab=cluster";
      await render(mode);
      expect(host.querySelector("h2")?.textContent).toBe(pools.listTitle);
      expect(host.textContent).toContain(pools.createCluster);
      expect(host.textContent).toContain(pools.listDescription);
      await act(async () => tab("networking")!.click());
      expect(h.replace).toHaveBeenLastCalledWith("/servers?tab=networking");
      h.search = "tab=networking";
      await render(mode);
      expect(host.querySelector("h2")?.textContent).toBe(c.networksEmptyTitle);
    },
  );

  it("keeps a deep link selected while capabilities load, fail, and retry", async () => {
    let reject!: (reason: Error) => void;
    h.capabilities.mockImplementationOnce(
      () =>
        new Promise((_, no) => {
          reject = no;
        }),
    );
    h.search = "tab=cluster";
    await render();
    expect(tab("cluster")).not.toBeNull();
    expect(tab("networking")).not.toBeNull();
    expect(host.querySelector('[role="status"]')?.getAttribute("aria-label")).toBe(pools.listTitle);
    expect(h.clusters).not.toHaveBeenCalled();
    expect(h.subscribe).not.toHaveBeenCalled();

    await act(async () => reject(new Error("Unable to reach the API")));
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Unable to reach the API");
    expect(tab("cluster")).not.toBeNull();
    expect(h.replace).not.toHaveBeenCalled();
    await act(async () => alert!.querySelector("button")!.click());
    expect(h.capabilities).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector("h2")?.textContent).toBe(pools.listTitle);
  });

  it("explains unavailable capabilities inside the selected tab", async () => {
    h.search = "tab=networking";
    h.capabilities.mockResolvedValue({
      ...capabilities,
      available: false,
      canManage: false,
      reason: "Fleet access is required",
    });
    await render();
    expect(tab("networking")).not.toBeNull();
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Fleet access is required");
    expect(host.textContent).not.toContain(pools.createCluster);
    expect(h.clusters).not.toHaveBeenCalled();
    expect(h.subscribe).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps Cloud isolated even with selfHosted=%s", async (selfHosted) => {
    h.search = "tab=cluster";
    await render("cloud", selfHosted);
    expect(tab("cluster")).toBeNull();
    expect(tab("networking")).toBeNull();
    expect(h.capabilities).not.toHaveBeenCalled();
    expect(h.clusters).not.toHaveBeenCalled();
    expect(h.subscribe).not.toHaveBeenCalled();
  });

  it("refreshes the shared overview from the header across both tabs", async () => {
    h.search = "tab=cluster";
    await render();
    expect(h.subscribe).toHaveBeenCalledExactlyOnceWith("system/networks/stream");
    const refresh = host.querySelector<HTMLButtonElement>(`button[aria-label="${c.refresh}"]`)!;
    expect(refresh).not.toBeNull();
    await act(async () => refresh.click());
    expect(h.reconnect).toHaveBeenCalledTimes(1);
    expect(refresh.disabled).toBe(true);
    await act(async () => h.receive!(h.overview));
    expect(refresh.disabled).toBe(false);

    h.search = "tab=networking";
    await render();
    expect(h.subscribe).toHaveBeenCalledTimes(1);
    expect(host.querySelectorAll(`button[aria-label="${c.refresh}"]`)).toHaveLength(1);
    expect(h.clusters).not.toHaveBeenCalled();

    h.search = "";
    await render();
    expect(h.receive).toBeNull();
    expect(host.querySelector(`button[aria-label="${c.refresh}"]`)).toBeNull();
  });

  it("confirms discarding a ready card once and keeps it removed through a stale snapshot", async () => {
    const setup = { ...managedPreparationSummaryFixture(), status: "ready" as const };
    h.overview.preparations = [setup];
    h.search = "tab=networking";
    let finish!: (preparation: ManagedNetworkPreparation) => void;
    h.discardPreparation.mockImplementationOnce(
      () =>
        new Promise<ManagedNetworkPreparation>((resolve) => {
          finish = resolve;
        }),
    );
    await render();
    const menu = setupActions(setup.name)!;
    expect(menu.closest("a")).toBeNull();
    await act(async () => menu.click());
    await click(c.managed.discardSetup);
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain(setup.name);
    expect(dialog.textContent).toContain(c.managed.discardDescription);
    expect(h.discardPreparation).not.toHaveBeenCalled();
    await click(c.cancel, dialog);
    expect(host.querySelector("article")).not.toBeNull();
    await act(async () => menu.click());
    await click(c.managed.discardSetup);
    const confirm = [
      ...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
    ].find((button) => button.textContent?.trim() === c.managed.discardSetup)!;
    await act(async () => {
      confirm.click();
      confirm.click();
    });
    expect(h.discardPreparation).toHaveBeenCalledExactlyOnceWith({
      preparationId: setup.id,
      sequence: setup.sequence,
    });
    expect(confirm.disabled).toBe(true);
    expect(host.querySelector("article")).not.toBeNull();
    await act(async () =>
      finish({ ...managedPreparationFixture(), status: "cancelled", sequence: 2 }),
    );
    expect(host.querySelector("article")).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(h.reconnect).toHaveBeenCalledTimes(1);
    await act(async () => h.receive!(h.overview));
    expect(host.querySelector("article")).toBeNull();
    expect(h.replace).not.toHaveBeenCalled();
    expect(h.push).not.toHaveBeenCalled();
  });

  it("keeps a refused discard visible and retries with the refreshed preparation sequence", async () => {
    const setup = { ...managedPreparationSummaryFixture(), status: "ready" as const };
    h.overview.preparations = [setup];
    h.search = "tab=networking";
    h.discardPreparation.mockRejectedValueOnce(
      new Error("Preparation changed. Reload saved progress."),
    );
    await render();
    await act(async () => setupActions(setup.name)!.click());
    await click(c.managed.discardSetup);
    let dialog = document.querySelector('[role="dialog"]')!;
    await click(c.managed.discardSetup, dialog);
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain("Preparation changed");
    expect(host.querySelector("article")).not.toBeNull();
    expect(h.reconnect).toHaveBeenCalledTimes(1);
    await act(async () =>
      h.receive!({ networks: [], preparations: [{ ...setup, sequence: 8 }], computeClusters: [] }),
    );
    dialog = document.querySelector('[role="dialog"]')!;
    await click(c.managed.discardSetup, dialog);
    expect(h.discardPreparation).toHaveBeenLastCalledWith({ preparationId: setup.id, sequence: 8 });
    expect(host.querySelector("article")).toBeNull();
  });

  it.each(["preparing", "read-only"])(
    "hides destructive card actions for %s setups",
    async (state) => {
      const setup = {
        ...managedPreparationSummaryFixture(),
        status: state === "read-only" ? ("ready" as const) : ("preparing" as const),
      };
      h.overview.preparations = [setup];
      h.search = "tab=networking";
      if (state === "read-only")
        h.capabilities.mockResolvedValue({ ...capabilities, canManage: false });
      await render();
      expect(setupActions(setup.name)).toBeUndefined();
      expect(host.querySelector("article a")).not.toBeNull();
      expect(host.querySelector(`button[aria-label="${c.refresh}"]`)).not.toBeNull();
      expect(h.discardPreparation).not.toHaveBeenCalled();
    },
  );
});
