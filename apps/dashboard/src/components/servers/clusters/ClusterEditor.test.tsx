// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComputeCluster } from "@repo/contracts";
import { I18nProvider } from "@/components/i18n-provider";
import { ModalProvider } from "@/context/ModalContext";
import { PlatformProvider } from "@/context/PlatformContext";
import { baseDictionary } from "@/i18n";
import {
  clusterCapabilitiesFixture,
  serverClusterFixture,
} from "../../../../../../packages/contracts/test/server-cluster-fixtures";
import { managedOperationFixture } from "../../../../../../packages/contracts/test/managed-network-fixtures";
import { ClusterEditor } from "./ClusterEditor";
import { ClusterDetail } from "./ClusterDetail";
import { ServerInfrastructure } from "../ServerInfrastructure";

const h = vi.hoisted(() => ({
  replace: vi.fn(),
  capabilities: vi.fn(),
  networks: vi.fn(),
  pools: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  runtime: vi.fn(),
  serverInfrastructure: vi.fn(),
  networkWrite: vi.fn(),
  receive: null as null | ((snapshot: { computeClusters: ComputeCluster[] }) => void),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: h.replace }) }));
vi.mock("@/hooks/useRunEvents", () => ({
  useRunEvents: (path: string | null, receive: typeof h.receive) => {
    if (path === "system/networks/stream") h.receive = receive;
    return { connected: true, reconnecting: false, error: null, reconnect: vi.fn() };
  },
}));
vi.mock("@/lib/api/private-networks", () => ({
  privateNetworksApi: {
    capabilities: h.capabilities,
    list: h.networks,
    create: h.networkWrite,
    update: h.networkWrite,
    remove: h.networkWrite,
    verify: h.networkWrite,
    prepareManaged: h.networkWrite,
  },
}));
vi.mock("@/lib/api/compute-clusters", () => ({
  computeClustersApi: {
    list: h.pools,
    get: h.get,
    create: h.create,
    update: h.update,
    remove: h.remove,
    runtime: h.runtime,
  },
}));
vi.mock("@/lib/api/system", () => ({
  systemApi: { getServerInfrastructure: h.serverInfrastructure },
}));
let host: HTMLDivElement, root: Root;
const c = baseDictionary.servers.clusters;
function pool(): ComputeCluster {
  const network = serverClusterFixture();
  return {
    id: "pool-a",
    name: "Apps",
    revision: 3,
    location: null,
    networkId: network.id,
    network,
    serverIds: ["server-a"],
    createdAt: network.createdAt,
    updatedAt: network.updatedAt,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.capabilities.mockResolvedValue(clusterCapabilitiesFixture());
  h.networks.mockResolvedValue([serverClusterFixture()]);
  h.pools.mockResolvedValue([]);
  h.get.mockResolvedValue(pool());
  h.create.mockResolvedValue(pool());
  h.update.mockResolvedValue(pool());
  h.remove.mockResolvedValue({ removed: true });
  h.runtime.mockResolvedValue(null);
  h.serverInfrastructure.mockResolvedValue({
    canBrowse: true,
    networks: [
      { id: "network", name: "Private production", mode: "native", privateIp: "10.20.0.2" },
    ],
    cluster: { id: "pool-a", name: "Apps" },
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
async function render(page: ReactNode, cloud = false) {
  await act(async () =>
    root.render(
      <I18nProvider>
        <PlatformProvider deployMode={cloud ? "cloud" : "docker"} selfHosted={!cloud}>
          <ModalProvider>{page}</ModalProvider>
        </PlatformProvider>
      </I18nProvider>,
    ),
  );
}
const button = (name: string, scope: ParentNode = host) =>
  [...scope.querySelectorAll("button")].find((button) => button.textContent?.trim() === name)!;
async function name(value: string) {
  const input = host.querySelector<HTMLInputElement>(`input[placeholder="${c.namePlaceholder}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("compute cluster responsibilities", () => {
  it("preselects an existing network and only creates a pool of its available members", async () => {
    h.pools.mockResolvedValue([{ ...pool(), id: "other", serverIds: ["server-b"] }]);
    await render(<ClusterEditor networkId="cluster-a" />);
    expect(host.querySelector('a[href="/servers/networks/new"]')).not.toBeNull();
    expect(host.querySelector('a[href="/servers/networks/cluster-a"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="server-b"]')?.hasAttribute("disabled")).toBe(true);
    expect(host.textContent).not.toContain(
      baseDictionary.servers.networks.managed.firewallRules.title,
    );
    await name("New apps");
    await act(async () => button(c.createCluster).click());
    expect(h.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "New apps",
        networkId: "cluster-a",
        serverIds: ["server-a"],
        requestId: expect.any(String),
      }),
    );
    expect(h.replace).toHaveBeenCalledWith("/servers/clusters/pool-a");
    expect(h.networkWrite).not.toHaveBeenCalled();
  });
  it("retains the original revision and idempotency key while retrying failed saves", async () => {
    h.create.mockRejectedValue(new Error("Connection lost"));
    await render(<ClusterEditor networkId="cluster-a" />);
    await name("Apps");
    await act(async () => button(c.createCluster).click());
    await act(async () => button(c.createCluster).click());
    expect(h.create.mock.calls[0]?.[0].requestId).toBe(h.create.mock.calls[1]?.[0].requestId);
    await render(<ClusterEditor id="pool-a" />);
    await name("Updated apps");
    await act(async () => button(c.save).click());
    expect(h.update).toHaveBeenCalledWith(
      expect.objectContaining({
        clusterId: "pool-a",
        revision: 3,
        networkId: "cluster-a",
        serverIds: ["server-a"],
      }),
    );
    expect(h.networkWrite).not.toHaveBeenCalled();
  });
  it("leaves unsettled network recovery in Networking before allowing a new dependency", async () => {
    h.networks.mockResolvedValue([
      {
        ...serverClusterFixture(),
        operation: { ...managedOperationFixture(), status: "needs_attention" },
      },
    ]);
    await render(<ClusterEditor networkId="cluster-a" />);
    await name("Apps");
    expect(button(c.createCluster).disabled).toBe(true);
    expect(host.textContent).toContain(c.networkBusy);
    expect(h.create).not.toHaveBeenCalled();
    expect(h.networkWrite).not.toHaveBeenCalled();
  });
  it("removes only the compute pool after explaining that its network and servers remain", async () => {
    await render(<ClusterDetail id="pool-a" />);
    expect(host.querySelector('a[href="/servers/server-a"]')).not.toBeNull();
    expect(host.querySelector('a[href="/servers/server-b"]')).toBeNull();
    await act(async () => button(c.removeCluster).click());
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain(c.removeDescription);
    // Live inventory cannot silently authorize deletion of a newer revision.
    await act(async () => h.receive?.({ computeClusters: [{ ...pool(), revision: 4 }] }));
    await act(async () => button(c.removeCluster, dialog).click());
    expect(h.remove).toHaveBeenCalledWith(expect.objectContaining({ id: "pool-a", revision: 3 }));
    expect(h.networkWrite).not.toHaveBeenCalled();
  });
  it("hides changes from read-only users and makes no infrastructure requests in cloud mode", async () => {
    h.capabilities.mockResolvedValue({ ...clusterCapabilitiesFixture(), canManage: false });
    await render(<ClusterEditor />);
    expect(host.textContent).toContain(c.managePermissionRequired);
    expect(h.networks).not.toHaveBeenCalled();
    expect(h.pools).not.toHaveBeenCalled();
    h.capabilities.mockClear();
    await render(<ClusterEditor />, true);
    expect(host.textContent).toContain(c.selfHostedOnly);
    expect(h.capabilities).not.toHaveBeenCalled();
  });
  it("shows server associations without offering inaccessible fleet pages", async () => {
    await render(<ServerInfrastructure serverId="server-a" />);
    expect(host.querySelector('a[href="/servers/clusters/pool-a"]')).not.toBeNull();
    expect(host.querySelector('a[href="/servers/networks/network"]')).not.toBeNull();
    h.serverInfrastructure.mockResolvedValue({
      ...(await h.serverInfrastructure()),
      canBrowse: false,
    });
    await render(<ServerInfrastructure serverId="server-b" />);
    expect(host.textContent).toContain("Private production");
    expect(host.querySelector("a")).toBeNull();
  });
});
