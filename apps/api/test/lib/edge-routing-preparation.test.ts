import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandExecutor } from "@repo/adapters";

const h = vi.hoisted(() => ({
  source: true,
  calls: [] as string[],
  deliver: vi.fn(),
  ensure: vi.fn(),
  docker: vi.fn(),
  probe: vi.fn(),
}));
vi.mock("@repo/adapters", () => ({
  dockerAvailable: h.docker,
  ensureContainerEdge: h.ensure,
  waitForPortListening: h.probe,
}));
vi.mock("@repo/platform/engine/lib/edge-image", () => ({
  edgeBuildSpec: () => h.source ? { context: "/source", dockerfile: "apps/edge/Dockerfile" } : undefined,
  pinnedEdgeImage: () => "registry/edge:pinned",
}));
vi.mock("@repo/platform/engine/lib/deliver-managed-image", () => ({ deliverManagedImage: h.deliver }));
import { ensureRoutingReady, reconcileServerEdge } from "@repo/platform/engine/lib/edge-reconcile";

const executor = {} as CommandExecutor;
const opts = { onLog: vi.fn(), promptUser: vi.fn() };
const system = {
  ensureComponents: vi.fn(async () => { h.calls.push("docker"); }),
  ensureFeature: vi.fn(async () => { h.calls.push("routing"); }),
};
beforeEach(() => {
  vi.resetAllMocks();
  h.source = true;
  h.calls.length = 0;
  system.ensureComponents.mockImplementation(async () => { h.calls.push("docker"); });
  system.ensureFeature.mockImplementation(async () => { h.calls.push("routing"); });
  h.docker.mockResolvedValue(true);
  h.deliver.mockImplementation(async () => { h.calls.push("image"); return { delivered: true }; });
  h.ensure.mockImplementation(async () => { h.calls.push("edge"); return { converted: false }; });
});

describe("routing preparation from source", () => {
  it.each([false, true])("does not claim routing is healthy or down when a failed update cannot be checked (throws=%s)", async (throws) => {
    h.ensure.mockRejectedValueOnce(new Error("SSH connection lost"));
    if (throws) h.probe.mockRejectedValueOnce(new Error("Network unreachable"));
    else h.probe.mockResolvedValueOnce({ checked: false, listening: false });
    expect(await reconcileServerEdge(executor, opts)).toMatchObject({ edgeDown: false, error: "SSH connection lost" });
    const messages = opts.onLog.mock.calls.map(([entry]) => entry.message).join("\n");
    expect(messages).toContain("current health could not be verified");
    expect(messages).not.toContain("still served by");
  });
  it("prepares Docker and the pinned image before installing a fresh edge", async () => {
    await expect(ensureRoutingReady(executor, system, opts)).resolves.toEqual({ edgeDown: false });
    expect(h.calls).toEqual(["docker", "image", "routing", "image", "edge"]);
    expect(system.ensureComponents).toHaveBeenCalledWith(["docker"], opts.onLog);
    expect(h.deliver).toHaveBeenCalledWith({ kind: "edge", image: "registry/edge:pinned", targetExecutor: executor, onLog: opts.onLog });
    expect(system.ensureFeature).toHaveBeenCalledWith("routing", opts.onLog, { promptUser: opts.promptUser });
  });

  it("retains the published-image installation path", async () => {
    h.source = false;
    await ensureRoutingReady(executor, system, opts);
    expect(system.ensureComponents).not.toHaveBeenCalled();
    expect(h.calls).toEqual(["routing", "image", "edge"]);
  });

  it("does not start the edge after an image delivery failure", async () => {
    h.deliver.mockRejectedValueOnce(new Error("transfer failed"));
    await expect(ensureRoutingReady(executor, system, opts)).rejects.toThrow("transfer failed");
    expect(system.ensureFeature).not.toHaveBeenCalled();
    expect(h.ensure).not.toHaveBeenCalled();
  });
});
