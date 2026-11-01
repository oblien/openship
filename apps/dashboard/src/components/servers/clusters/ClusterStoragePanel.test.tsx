// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClusterStorage, ComputeCluster } from "@repo/contracts";
import { I18nProvider } from "@/components/i18n-provider";
import { ModalProvider } from "@/context/ModalContext";
import { clusterRuntimeFixture } from "../../../../../../packages/contracts/test/cluster-runtime-fixtures";
import { serverClusterFixture } from "../../../../../../packages/contracts/test/server-cluster-fixtures";
import { ClusterStoragePanel } from "./ClusterStoragePanel";

const h = vi.hoisted(() => ({
  get: vi.fn(),
  setup: vi.fn(),
  receive: null as null | ((row: ClusterStorage) => void),
}));
vi.mock("@/lib/api/cluster-storage", () => ({ clusterStorageApi: { get: h.get, setup: h.setup } }));
vi.mock("@/lib/api/backups", () => ({
  backupDestinationsApi: { list: vi.fn(async () => ({ data: [] })) },
}));
vi.mock("@/hooks/useRunEvents", () => ({
  useRunEvents: (_path: string | null, receive: typeof h.receive) => {
    h.receive = receive;
    return { connected: true, reconnecting: false, error: null, reconnect: vi.fn() };
  },
}));

function cluster(): ComputeCluster {
  const runtime = clusterRuntimeFixture(),
    network = serverClusterFixture();
  network.members = runtime.plan.hosts.map((host) => ({
    serverId: host.serverId,
    name: host.name,
    privateIp: host.privateIp,
    providerId: "custom",
  }));
  return {
    id: runtime.clusterId,
    name: "Apps",
    revision: 1,
    location: null,
    networkId: network.id,
    network,
    serverIds: runtime.plan.hosts.map((host) => host.serverId),
    createdAt: runtime.createdAt,
    updatedAt: runtime.updatedAt,
  };
}
function storage(): ClusterStorage {
  const c = cluster();
  return {
    id: "storage",
    clusterId: c.id,
    runtimeId: "runtime",
    sequence: 10,
    generation: 1,
    status: "ready",
    intent: "setup",
    error: null,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    config: {
      replicas: 2,
      disks: c.serverIds.map((serverId) => ({
        serverId,
        path: "/var/lib/openship/storage",
        reservedGiB: 5,
      })),
    },
    progress: { steps: [], logs: [] },
    observation: { observedAt: "2026-09-26T10:00:00Z", ready: true, nodes: [], volumes: [] },
  };
}
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.get.mockResolvedValue(null);
  h.receive = null;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const render = (value = cluster()) =>
  act(async () =>
    root.render(
      <I18nProvider>
        <ModalProvider>
          <ClusterStoragePanel cluster={value} canManage scalingReady />
        </ModalProvider>
      </I18nProvider>,
    ),
  );

describe("shared storage outcomes and observed health", () => {
  it("explains why a single server cannot share independent copies", async () => {
    const value = cluster();
    value.serverIds = value.serverIds.slice(0, 1);
    await render(value);
    expect(host.textContent).toContain("Shared storage needs at least two servers");
    expect(
      [...host.querySelectorAll("button")].find((button) => button.textContent === "Share storage")
        ?.disabled,
    ).toBe(true);
    expect(host.textContent).not.toMatch(/Longhorn|Kubernetes|K3s/);
  });
  it("keeps infrastructure details collapsed and retains a newer health check over a saved setup snapshot", async () => {
    const saved = storage();
    h.get.mockResolvedValueOnce(saved);
    await render();
    const technical = [...host.querySelectorAll("details")].find(
      (details) => details.querySelector("summary")?.textContent === "Technical details",
    )!;
    expect(technical.open).toBe(false);
    const observed = {
      ...saved,
      observation: {
        ...saved.observation!,
        observedAt: "2026-09-26T11:00:00Z",
        ready: false,
        nodes: [
          {
            serverId: "one",
            name: "Storage server",
            ready: false,
            availableGiB: 0,
            scheduledGiB: 5,
            message: "Disk needs attention",
          },
        ],
      },
    };
    h.get.mockResolvedValue(observed);
    await act(async () =>
      (host.querySelector('[aria-label="Refresh storage status"]') as HTMLButtonElement).click(),
    );
    expect(h.get).toHaveBeenLastCalledWith(saved.clusterId, true);
    expect(host.textContent).toContain("Disk needs attention");
    await act(async () => h.receive?.(saved));
    expect(host.textContent).toContain("Disk needs attention");
    expect(h.setup).not.toHaveBeenCalled();
  });
  it("ignores a response from the previous cluster after navigation", async () => {
    h.get.mockResolvedValueOnce(storage());
    await render();
    const previous = h.receive;
    await render({ ...cluster(), id: "another-cluster" });
    await act(async () =>
      previous?.({
        ...storage(),
        status: "failed",
        sequence: 11,
        error: "Previous cluster failure",
      }),
    );
    expect(host.textContent).not.toContain("Previous cluster failure");
    expect(host.textContent).toContain("Keep files available to your applications across servers.");
  });
});
