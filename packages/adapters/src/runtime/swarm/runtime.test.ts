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

  it("renders through docker stack config with an explicit environment and always removes its private stage", async () => {
    const commands: string[] = [];
    const writes = new Map<string, string>();
    const rm = vi.fn().mockResolvedValue(undefined);
    const exec = vi.fn(async (command: string) => {
      commands.push(command);
      if (command.startsWith("docker info")) return JSON.stringify(managerInfo);
      if (command.startsWith("docker version")) return JSON.stringify(serverVersion);
      if (command.startsWith("umask 077 && mktemp")) return "/tmp/openship-swarm-render.abc123\n";
      if (command.includes("docker stack config")) return "services:\n  web:\n    image: nginx:alpine\n";
      throw new Error(`unexpected command: ${command}`);
    });
    const runtime = await SwarmRuntime.create({
      executor: {
        exec,
        writeFile: async (path, content) => { writes.set(path, content); },
        readFile: async () => "unsupported option warning\n",
        rm,
      },
    });

    const result = await runtime.renderStack({
      files: [{ path: "compose.yaml", content: "version: \"3.9\"\nservices:\n  web:\n    image: nginx\n    command: \"$${1}\"\n" }],
      composePaths: ["compose.yaml"],
      environment: { IMAGE_TAG: "v1", REGEX: "$${1}" },
      ownershipLabels: { web: { "com.openship.stack-id": "swarm_a" } },
    });

    expect(result).toMatchObject({
      renderedYaml: "services:\n  web:\n    image: nginx:alpine\n",
      warnings: ["unsupported option warning"],
    });
    expect(result.renderedDigest).toMatch(/^sha256:/);
    expect(writes.get("/tmp/openship-swarm-render.abc123/compose.yaml")).toContain("$${1}");
    expect(writes.get("/tmp/openship-swarm-render.abc123/.openship-render.env")).toContain("REGEX='$${1}'");
    expect(writes.get("/tmp/openship-swarm-render.abc123/.openship-render.override.yaml")).toContain("com.openship.stack-id");
    expect(writes.get("/tmp/openship-swarm-render.abc123/.openship-render.override.yaml")).toContain('version: "3.9"');
    const renderCommand = commands.find((command) => command.includes("docker stack config"))!;
    expect(renderCommand).toContain("env -i PATH=\"$PATH\"");
    expect(renderCommand).not.toContain("docker stack deploy");
    expect(rm).toHaveBeenCalledWith("/tmp/openship-swarm-render.abc123");
  });

  it("returns a typed safe validation error and cleans staging on docker stack config failure", async () => {
    const rm = vi.fn().mockResolvedValue(undefined);
    const runtime = await SwarmRuntime.create({
      executor: {
        exec: async (command: string) => {
          if (command.startsWith("docker info")) return JSON.stringify(managerInfo);
          if (command.startsWith("docker version")) return JSON.stringify(serverVersion);
          if (command.startsWith("umask 077 && mktemp")) return "/tmp/openship-swarm-render.def456";
          if (command.includes("docker stack config")) throw new Error("interpolation variable SECRET_TOKEN is required");
          throw new Error("unexpected");
        },
        writeFile: async () => {},
        readFile: async () => "",
        rm,
      },
    });

    await expect(runtime.renderStack({
      files: [{ path: "compose.yaml", content: "services: {}\n" }],
      composePaths: ["compose.yaml"],
      environment: { SECRET_TOKEN: "secret-canary" },
    })).rejects.toMatchObject({
      name: "SwarmRenderError",
      issues: [{ code: "SWARM_STACK_INTERPOLATION_FAILED" }],
    });
    expect(rm).toHaveBeenCalledWith("/tmp/openship-swarm-render.def456");
  });

  it("deploys only a reviewed rendered document with explicit image resolution and private cleanup", async () => {
    const commands: string[] = [];
    const writes = new Map<string, string>();
    const rm = vi.fn().mockResolvedValue(undefined);
    const runtime = await SwarmRuntime.create({
      executor: {
        exec: async (command: string) => {
          commands.push(command);
          if (command.startsWith("docker info")) return JSON.stringify(managerInfo);
          if (command.startsWith("docker version")) return JSON.stringify(serverVersion);
          if (command.startsWith("umask 077 && mktemp -d /tmp/openship-swarm-deploy.")) {
            return "/tmp/openship-swarm-deploy.abc123";
          }
          if (command.startsWith("docker stack deploy")) return "Creating service demo_web";
          throw new Error(`unexpected command: ${command}`);
        },
        writeFile: async (path, content) => { writes.set(path, content); },
        rm,
      },
    });

    await expect(runtime.deployStack({
      stackName: "demo",
      renderedYaml: "services:\n  web:\n    image: nginx:1.27-alpine\n",
    })).resolves.toEqual({ output: "Creating service demo_web" });

    expect(writes.get("/tmp/openship-swarm-deploy.abc123/rendered-stack.yaml")).toContain("nginx:1.27-alpine");
    const command = commands.find((entry) => entry.startsWith("docker stack deploy"))!;
    expect(command).toContain("--resolve-image always");
    expect(command).not.toContain("--prune");
    expect(command).not.toContain("nginx:1.27-alpine");
    expect(rm).toHaveBeenCalledWith("/tmp/openship-swarm-deploy.abc123");
  });

  it("rejects invalid deploy input before invoking docker", async () => {
    const exec = vi.fn(async (command: string) =>
      command.startsWith("docker info") ? JSON.stringify(managerInfo) : JSON.stringify(serverVersion),
    );
    const runtime = await SwarmRuntime.create({ executor: { exec, writeFile: async () => {}, rm: async () => {} } });
    await expect(runtime.deployStack({ stackName: "Not Allowed", renderedYaml: "services: {}" }))
      .rejects.toMatchObject({ name: "SwarmDeployError" });
    expect(exec.mock.calls.some(([command]) => String(command).includes("docker stack deploy"))).toBe(false);
  });

  it("uses bounded service and stack operations without accepting untrusted shell identifiers", async () => {
    const commands: string[] = [];
    const runtime = await SwarmRuntime.create({
      executor: {
        exec: async (command: string) => {
          commands.push(command);
          if (command.startsWith("docker info")) return JSON.stringify(managerInfo);
          if (command.startsWith("docker version")) return JSON.stringify(serverVersion);
          if (command.startsWith("docker service scale")) return "blog_web scaled to 0";
          if (command.startsWith("docker service update")) return "blog_web restarted";
          if (command.startsWith("docker stack rm")) return "Removing service blog_web";
          throw new Error(`unexpected command: ${command}`);
        },
      },
    });

    await expect(runtime.scaleService({ serviceId: "service-1", replicas: 0 })).resolves.toEqual({ output: "blog_web scaled to 0" });
    await expect(runtime.restartService({ serviceId: "service-1" })).resolves.toEqual({ output: "blog_web restarted" });
    await expect(runtime.removeStack({ stackName: "blog" })).resolves.toEqual({ output: "Removing service blog_web" });
    expect(commands).toEqual(expect.arrayContaining([
      expect.stringContaining("docker service scale --detach=false 'service-1=0'"),
      expect.stringContaining("docker service update --detach=false --force 'service-1'"),
      expect.stringContaining("docker stack rm 'blog'"),
    ]));
    await expect(runtime.scaleService({ serviceId: "service; rm -rf /", replicas: 1 })).rejects.toMatchObject({ name: "SwarmDeployError" });
  });

  it("reads and follows bounded service or task logs with caller cancellation", async () => {
    const commands: string[] = [];
    const streamExec = vi.fn((_command: string, onLog: (entry: { message: string }) => void, opts?: { signal?: AbortSignal }) => {
      onLog({ message: "blog_web.1.task-1@manager | 2026-07-30T00:00:00.000000000Z booted\n" });
      return new Promise<{ code: number; output: string }>((resolve) => {
        opts?.signal?.addEventListener("abort", () => resolve({ code: 0, output: "" }), { once: true });
      });
    });
    const runtime = await SwarmRuntime.create({
      executor: {
        exec: async (command: string) => {
          commands.push(command);
          if (command.startsWith("docker info")) return JSON.stringify(managerInfo);
          if (command.startsWith("docker version")) return JSON.stringify(serverVersion);
          if (command.startsWith("docker service logs")) return "blog_web.1.task-1@manager | 2026-07-30T00:00:00.000000000Z ready";
          throw new Error(`unexpected command: ${command}`);
        },
        streamExec,
      },
    });

    await expect(runtime.getServiceLogs({ serviceId: "service-1", tail: 20, since: "1h" })).resolves.toEqual({
      entries: [{ raw: "blog_web.1.task-1@manager | 2026-07-30T00:00:00.000000000Z ready", timestamp: "2026-07-30T00:00:00.000000000Z", message: "ready", serviceName: "blog_web", taskId: "task-1", nodeName: "manager" }],
    });
    const entries: unknown[] = [];
    const stream = runtime.streamServiceLogs({ serviceId: "service-1", taskId: "task-1", tail: 5 }, (entry) => entries.push(entry));
    stream.stop();
    await stream.done;
    expect(entries).toEqual([{ raw: "blog_web.1.task-1@manager | 2026-07-30T00:00:00.000000000Z booted", timestamp: "2026-07-30T00:00:00.000000000Z", message: "booted", serviceName: "blog_web", taskId: "task-1", nodeName: "manager" }]);
    expect(commands).toEqual(expect.arrayContaining([
      expect.stringContaining("docker service logs --timestamps --tail 20 --since '1h' 'service-1'"),
    ]));
    expect(streamExec).toHaveBeenCalledWith(
      expect.stringContaining("docker service logs --timestamps --tail 5 --follow 'task-1'"),
      expect.any(Function),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
