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

  it("discovers manager resources read-only and never inspects secret payloads", async () => {
    const commands: string[] = [];
    const exec = vi.fn(async (command: string) => {
      commands.push(command);
      if (command.startsWith("docker info")) return JSON.stringify(managerInfo);
      if (command.startsWith("docker version")) return JSON.stringify(serverVersion);
      if (command.startsWith("docker node ls")) return JSON.stringify({ ID: "node-1", Hostname: "manager", Status: "Ready", Availability: "Active" });
      if (command === "docker service ls -q") return "service-1\n";
      if (command.startsWith("docker service inspect")) {
        return JSON.stringify({
          ID: "service-1",
          Version: { Index: 1 },
          Spec: {
            Name: "blog_web",
            Labels: { "com.docker.stack.namespace": "blog" },
            Mode: { Replicated: { Replicas: 1 } },
            TaskTemplate: { ContainerSpec: { Image: "nginx:alpine" } },
          },
        });
      }
      if (command.startsWith("docker service ps")) {
        return JSON.stringify({ ID: "task-1", Name: "blog_web.1", DesiredState: "Running", CurrentState: "Running" });
      }
      if (command.startsWith("docker network ls")) return JSON.stringify({ ID: "net-1", Name: "blog_default", Driver: "overlay", Scope: "swarm" });
      if (command.startsWith("docker volume ls")) return JSON.stringify({ Name: "blog_data", Driver: "local", Scope: "local" });
      if (command.startsWith("docker config ls")) return JSON.stringify({ ID: "config-1", Name: "blog_config" });
      if (command.startsWith("docker secret ls")) return JSON.stringify({ ID: "secret-1", Name: "blog_password" });
      throw new Error(`unexpected command: ${command}`);
    });
    const runtime = await SwarmRuntime.create({ executor: { exec } });

    const snapshot = await runtime.discover();
    expect(snapshot).toMatchObject({
      stacks: [{ name: "blog", serviceNames: ["web"] }],
      services: [{ id: "service-1", sourceServiceName: "web" }],
      tasks: [{ id: "task-1", slot: 1 }],
      secrets: [{ id: "secret-1", name: "blog_password" }],
    });
    expect(commands.some((command) => command.startsWith("docker secret inspect"))).toBe(false);
  });
});
