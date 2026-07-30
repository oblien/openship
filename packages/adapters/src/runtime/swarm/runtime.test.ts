import { describe, expect, it, vi } from "vitest";
import { SwarmProbeError } from "./normalize";
import { SwarmRuntime } from "./runtime";

const managerInfo = {
  ServerVersion: "29.5.3",
  Swarm: {
    LocalNodeState: "active",
    ControlAvailable: true,
    NodeID: "node-1",
    NodeAddr: "10.0.0.10",
    RemoteManagers: [{ Addr: "10.0.0.10:2377" }],
    Cluster: { ID: "cluster-1" },
  },
};
const serverVersion = { Version: "29.5.3", APIVersion: "1.52" };

function executor(info: unknown = managerInfo, server: unknown = serverVersion) {
  return {
    exec: vi.fn((command: string) =>
      Promise.resolve(command.startsWith("docker info") ? JSON.stringify(info) : JSON.stringify(server)),
    ),
  };
}

describe("SwarmRuntime manager probe", () => {
  it("normalizes a reachable manager with stable cluster identity", async () => {
    const exec = executor();
    const runtime = await SwarmRuntime.create({ executor: exec });
    await expect(runtime.probe()).resolves.toMatchObject({
      clusterId: "cluster-1",
      nodeId: "node-1",
      apiVersion: "1.52",
      controlAvailable: true,
    });
  });

  it.each([
    ["inactive engine", { ...managerInfo, Swarm: { ...managerInfo.Swarm, LocalNodeState: "inactive" } }, "SWARM_INACTIVE"],
    ["worker", { ...managerInfo, Swarm: { ...managerInfo.Swarm, ControlAvailable: false } }, "SWARM_MANAGER_REQUIRED"],
  ])("rejects a %s before any stack operation", async (_label, info, code) => {
    await expect(SwarmRuntime.create({ executor: executor(info) })).rejects.toMatchObject({ code });
  });

  it("maps executor failures to a credential-safe unreachable error", async () => {
    const exec = { exec: vi.fn().mockRejectedValue(new Error("ssh://secret@host failed")) };
    await expect(SwarmRuntime.create({ executor: exec })).rejects.toEqual(
      expect.objectContaining<Partial<SwarmProbeError>>({ code: "SWARM_MANAGER_UNREACHABLE" }),
    );
  });
});
