import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandExecutor } from "../../../types";

const h = vi.hoisted(() => ({ ports: vi.fn(), swarm: vi.fn() }));
vi.mock("../../port-listen", async (original) => ({
  ...await original<typeof import("../../port-listen")>(),
  probePortListeningOnce: h.ports,
}));
vi.mock("../swarm", async (original) => ({
  ...await original<typeof import("../swarm")>(),
  swarmEdgePorts: h.swarm,
}));
import { scanOpenshipEdgeStrict } from "./nginx";

function executor(proof: string | Error = "__OPENSHIP_NO_INGRESS__") {
  return { exec: vi.fn(async (command: string) => {
    if (command === "id -u") return "0";
    if (!command.includes("__OPENSHIP_NO_INGRESS__")) return "";
    if (proof instanceof Error) throw proof;
    return proof;
  }) } as unknown as CommandExecutor;
}
beforeEach(() => {
  vi.clearAllMocks();
  h.ports.mockResolvedValue(false);
  h.swarm.mockResolvedValue(new Map());
});
describe("strict inventory on a fresh private deployment host", () => {
  it("accepts a positive empty-ingress proof without installing an edge", async () => {
    const exec = executor();
    const result = await scanOpenshipEdgeStrict(exec);
    expect(result.loopbackUpstreamPorts).toEqual(new Set());
    expect(result.sites).toEqual([]);
    expect(h.ports.mock.calls.map(([, port]) => port)).toEqual([80, 443]);
  });
  it.each(["", "partial", new Error("Docker inspect unavailable")])(
    "rejects an absent or failed dormant-ingress proof (%s)", async (proof) => {
      await expect(scanOpenshipEdgeStrict(executor(proof))).rejects.toThrow("no running Openship edge");
    },
  );
  it.each([80, 443])("rejects an occupied port %s", async (occupied) => {
    h.ports.mockImplementation(async (_exec, port) => port === occupied);
    await expect(scanOpenshipEdgeStrict(executor())).rejects.toThrow("no running Openship edge");
  });
  it("rejects an unreadable socket table", async () => {
    h.ports.mockResolvedValue(null);
    await expect(scanOpenshipEdgeStrict(executor())).rejects.toThrow("no running Openship edge");
  });
  it("rejects Swarm ingress even without a local listening socket", async () => {
    h.swarm.mockResolvedValue(new Map([[80, "foreign-service"]]));
    await expect(scanOpenshipEdgeStrict(executor())).rejects.toThrow("no running Openship edge");
  });
  it("rejects unreadable Swarm state", async () => {
    h.swarm.mockRejectedValueOnce(new Error("manager unavailable"));
    await expect(scanOpenshipEdgeStrict(executor())).rejects.toThrow("no running Openship edge");
  });
});
