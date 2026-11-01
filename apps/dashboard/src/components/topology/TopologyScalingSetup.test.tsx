// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComputeCluster } from "@repo/contracts";
import { TopologyScalingSetup } from "./TopologyScalingSetup";

const h = vi.hoisted(() => ({
  get: vi.fn(),
  capabilities: vi.fn(),
  received: vi.fn(),
  ready: vi.fn(),
  close: vi.fn(),
  swarm: vi.fn(),
}));
vi.mock("@/components/servers/ServerSwarm", () => ({
  ServerSwarm: (props: unknown) => {
    h.swarm(props);
    return <div>Connected Swarm</div>;
  },
}));
vi.mock("@/lib/api/compute-clusters", () => ({ computeClustersApi: { get: h.get } }));
vi.mock("@/lib/api/private-networks", () => ({
  privateNetworksApi: { capabilities: h.capabilities },
}));
vi.mock("@/components/servers/clusters/ClusterRuntimePanel", () => ({
  ClusterRuntimePanel: (props: {
    canManage: boolean;
    embedded: boolean;
    onReadyChange: (ready: boolean) => void;
  }) => {
    h.received(props);
    return <button onClick={() => props.onReadyChange(true)}>Runtime verified</button>;
  },
}));
const cluster = {
  id: "cluster",
  name: "Production",
  scaling: { status: "ready", verifiedAt: null },
} as ComputeCluster;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.get.mockResolvedValue(cluster);
  h.capabilities.mockResolvedValue({ available: true, canManage: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) => element.textContent?.trim() === label,
  )!;
const render = () =>
  act(async () =>
    root.render(<TopologyScalingSetup cluster={cluster} onReady={h.ready} onClose={h.close} />),
  );
describe("inline scaling preparation", () => {
  it("reuses connected Swarm inspection without opening Kubernetes installation", async () => {
    const swarm = {
      ...cluster,
      serverIds: ["manager"],
      scaling: { provider: "swarm", status: "ready", verifiedAt: null },
    };
    h.get.mockResolvedValue(swarm);
    await render();
    expect(h.received).not.toHaveBeenCalled();
    expect(h.swarm).toHaveBeenCalledWith({ serverId: "manager", connected: true });
    expect(h.ready).not.toHaveBeenCalled();
    await act(async () => button("Continue with this cluster").click());
    expect(h.ready).toHaveBeenCalledWith(swarm);
  });
  it("opens the existing setup read-only and returns to the draft only after explicit continuation", async () => {
    await render();
    expect(h.get).toHaveBeenCalledOnce();
    expect(h.received).toHaveBeenCalledWith(
      expect.objectContaining({ canManage: true, embedded: true }),
    );
    expect(h.ready).not.toHaveBeenCalled();
    await act(async () => button("Runtime verified").click());
    expect(h.ready).not.toHaveBeenCalled();
    await act(async () => button("Continue with this cluster").click());
    expect(h.get).toHaveBeenCalledTimes(2);
    expect(h.ready).toHaveBeenCalledOnce();
    expect(h.ready).toHaveBeenCalledWith(cluster);
  });
  it("rejects readiness that changed before continuation", async () => {
    await render();
    await act(async () => button("Runtime verified").click());
    h.get.mockResolvedValue({ ...cluster, scaling: { status: "interrupted" } });
    await act(async () => button("Continue with this cluster").click());
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("readiness changed");
    expect(h.ready).not.toHaveBeenCalled();
    expect(button("Continue with this cluster")).toBeUndefined();
  });
  it("does not offer privileged controls when the permission read fails", async () => {
    h.capabilities.mockRejectedValue(new Error("Permission lookup failed"));
    await render();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Permission lookup failed",
    );
    expect(h.received).not.toHaveBeenCalled();
    expect(h.ready).not.toHaveBeenCalled();
  });
});
