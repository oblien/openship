// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComputeCluster } from "@repo/contracts";
import type { ClusterRuntime } from "@repo/core";
import { I18nProvider } from "@/components/i18n-provider";
import { ModalProvider } from "@/context/ModalContext";
import { baseDictionary } from "@/i18n";
import { clusterRuntimeFixture } from "../../../../../../packages/contracts/test/cluster-runtime-fixtures";
import { serverClusterFixture } from "../../../../../../packages/contracts/test/server-cluster-fixtures";
import { ClusterRuntimePanel } from "./ClusterRuntimePanel";

const h = vi.hoisted(() => ({
  runtime: vi.fn(),
  setup: vi.fn(),
  retry: vi.fn(),
  remove: vi.fn(),
  receive: null as null | ((runtime: ClusterRuntime) => void),
  path: null as string | null,
}));
vi.mock("@/lib/api/compute-clusters", () => ({
  computeClustersApi: {
    runtime: h.runtime,
    setupRuntime: h.setup,
    retryRuntime: h.retry,
    removeRuntime: h.remove,
  },
}));
vi.mock("@/hooks/useRunEvents", () => ({
  useRunEvents: (path: string | null, receive: typeof h.receive) => {
    h.path = path;
    h.receive = receive;
    return { connected: !!path, reconnecting: false, error: null, reconnect: vi.fn() };
  },
}));
const c = baseDictionary.servers.runtime;
function cluster(): ComputeCluster {
  const runtime = clusterRuntimeFixture();
  const network = serverClusterFixture();
  network.id = runtime.plan.networkId!;
  network.members = runtime.plan.hosts.map((host) => ({
    serverId: host.serverId,
    name: host.name,
    privateIp: host.privateIp,
    providerId: "custom",
  }));
  return {
    id: runtime.clusterId,
    name: "Apps",
    revision: 3,
    location: null,
    networkId: network.id,
    network,
    serverIds: runtime.plan.hosts.map((host) => host.serverId),
    createdAt: runtime.createdAt,
    updatedAt: runtime.updatedAt,
  };
}
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.runtime.mockResolvedValue(null);
  h.path = null;
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
async function render(canManage = true) {
  await act(async () =>
    root.render(
      <I18nProvider>
        <ModalProvider>
          <ClusterRuntimePanel cluster={cluster()} canManage={canManage} />
        </ModalProvider>
      </I18nProvider>,
    ),
  );
}
const button = (label: string, scope: ParentNode = host) =>
  [...scope.querySelectorAll("button")].find((element) => element.textContent?.trim() === label)!;

describe("cluster runtime setup UI", () => {
  it("keeps engine details and logs expandable while showing setup health and the project entry point", async () => {
    const runtime = {
      ...clusterRuntimeFixture(),
      status: "ready" as const,
      verifiedAt: "2026-09-21T10:00:00Z",
    };
    h.runtime.mockResolvedValue(runtime);
    await render();
    expect(host.textContent).toContain(c.status.ready);
    expect(host.querySelector('a[href="/projects"]')?.textContent).toContain(c.scaleProject);
    const technical = [...host.querySelectorAll("details")].find(
      (element) => element.querySelector("summary")?.textContent === c.technicalDetails,
    )!;
    expect(technical.open).toBe(false);
    expect(technical.textContent).toContain("K3s");
    expect(host.querySelector('[role="log"]')?.hasAttribute("hidden")).toBe(true);
    await act(async () => button(baseDictionary.servers.networks.managed.logs).click());
    expect(host.querySelector('[role="log"]')?.hasAttribute("hidden")).toBe(false);
    expect(h.setup).not.toHaveBeenCalled();
  });
  it("locks duplicate clicks until the start response arrives and follows the saved run", async () => {
    let resolve!: (runtime: ClusterRuntime) => void;
    h.setup.mockReturnValue(
      new Promise<ClusterRuntime>((done) => {
        resolve = done;
      }),
    );
    await render();
    expect(host.querySelector("details")?.open).toBe(true); // Native network prerequisites are visible.
    const setup = button(c.setup);
    await act(async () => {
      setup.click();
      setup.click();
    });
    expect(h.setup).toHaveBeenCalledOnce();
    expect(setup.disabled).toBe(true);
    expect(h.setup).toHaveBeenCalledWith("pool-a", 3, expect.any(String));
    await act(async () => resolve(clusterRuntimeFixture()));
    expect(h.path).toBe("system/compute-clusters/pool-a/runtime/stream");
    expect(host.textContent).toContain(c.status.setting_up);
    expect(button(c.setup)).toBeUndefined();
  });
  it("replays stopped progress without retrying and ignores an older snapshot", async () => {
    const runtime = {
      ...clusterRuntimeFixture(),
      status: "interrupted" as const,
      sequence: 9,
      error: "Controller restarted",
    };
    h.runtime.mockResolvedValue(runtime);
    await render();
    await act(async () => h.receive?.(runtime));
    await act(async () =>
      h.receive?.({ ...runtime, status: "setting_up", sequence: 8, error: null }),
    );
    expect(host.textContent).toContain(c.status.interrupted);
    expect(host.textContent).toContain("Controller restarted");
    expect(button(baseDictionary.servers.clusters.retry)).toBeDefined();
    expect(h.setup).not.toHaveBeenCalled();
    expect(h.retry).not.toHaveBeenCalled();
    expect(h.runtime).toHaveBeenCalledOnce();
  });
  it("recovers a lost start response by reading progress without replaying the request", async () => {
    h.runtime.mockResolvedValueOnce(null).mockResolvedValue(clusterRuntimeFixture());
    h.setup.mockRejectedValue(new Error("Response disconnected"));
    await render();
    await act(async () => button(c.setup).click());
    expect(h.setup).toHaveBeenCalledOnce();
    expect(h.runtime).toHaveBeenCalledTimes(2);
    expect(h.path).toContain("/runtime/stream");
    expect(button(c.setup)).toBeUndefined();
  });
  it("uses the reviewed removal sequence when another client changes progress", async () => {
    const runtime = { ...clusterRuntimeFixture(), status: "failed" as const, sequence: 4 };
    h.runtime.mockResolvedValue(runtime);
    h.remove.mockResolvedValue({ ...runtime, intent: "remove", status: "removing", sequence: 6 });
    await render();
    await act(async () =>
      host.querySelector<HTMLButtonElement>(`[aria-label="${c.remove}"]`)!.click(),
    );
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain(c.removeDescription);
    await act(async () => h.receive?.({ ...runtime, sequence: 5 }));
    await act(async () => button(c.remove, dialog).click());
    expect(h.remove).toHaveBeenCalledWith("pool-a", 4);
  });
  it("keeps setup mutations out of the read-only view", async () => {
    await render(false);
    expect(button(c.setup)).toBeUndefined();
    expect(h.setup).not.toHaveBeenCalled();
    expect(h.remove).not.toHaveBeenCalled();
  });
});
