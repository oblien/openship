import { describe, expect, it, vi } from "vitest";

const dockerCreate = vi.fn();
vi.mock("./runtime/docker", () => ({
  DockerRuntime: { create: dockerCreate },
}));

import { createPlatform } from "./platform";

const managerInfo = JSON.stringify({
  ServerVersion: "29.5.3",
  Swarm: {
    LocalNodeState: "active",
    ControlAvailable: true,
    NodeID: "node-1",
    Cluster: { ID: "cluster-1" },
  },
});
const serverVersion = JSON.stringify({ Version: "29.5.3", APIVersion: "1.52" });

describe("createPlatform Swarm resolution", () => {
  it("keeps Docker for builds while binding a verified stack runtime and no Edge provider", async () => {
    dockerCreate.mockResolvedValue({ name: "docker", supports: () => false });
    const exec = vi.fn((command: string) =>
      Promise.resolve(command.startsWith("docker info") ? managerInfo : serverVersion),
    );

    const platform = await createPlatform({
      target: "selfhosted",
      runtime: "docker",
      orchestratorMode: "swarm",
      executor: { exec } as never,
    });

    expect(platform.runtime.name).toBe("docker");
    expect(platform.orchestratorMode).toBe("swarm");
    expect(platform.stackRuntime?.name).toBe("swarm");
    await expect(platform.stackRuntime?.probe()).resolves.toMatchObject({ clusterId: "cluster-1" });
    expect(exec.mock.calls.map(([command]) => command)).toEqual([
      "docker info --format '{{json .}}'",
      "docker version --format '{{json .Server}}'",
      "docker info --format '{{json .}}'",
      "docker version --format '{{json .Server}}'",
    ]);
  });
});
