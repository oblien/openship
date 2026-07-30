import { describe, expect, it } from "vitest";
import { DockerRuntime } from "../src/runtime/docker";

describe("DockerRuntime container status normalization", () => {
  it("correctly identifies running status when State.Running is true regardless of State.Status casing", async () => {
    const runtime = await DockerRuntime.create();
    
    // Mock container inspect response
    const mockInspectInfo: any = {
      Id: "container-12345",
      State: {
        Status: "Running",
        Running: true,
        Paused: false,
        StartedAt: new Date(Date.now() - 60000).toISOString(),
      },
      NetworkSettings: { Networks: {}, Ports: {} },
    };

    // Override internal docker container inspect
    runtime.docker.getContainer = (() => ({
      inspect: async () => mockInspectInfo,
    })) as any;

    const info = await runtime.getContainerInfo("container-12345");
    expect(info.status).toBe("running");
    expect(info.uptimeSeconds).toBeGreaterThan(0);
  });

  it("handles health check status strings like 'healthy' and 'starting'", async () => {
    const runtime = await DockerRuntime.create();

    const mockInspectInfo: any = {
      Id: "container-67890",
      State: {
        Status: "healthy",
        Running: false, // In case Running flag is false or not set
        Paused: false,
        StartedAt: new Date(Date.now() - 30000).toISOString(),
      },
      NetworkSettings: { Networks: {}, Ports: {} },
    };

    runtime.docker.getContainer = (() => ({
      inspect: async () => mockInspectInfo,
    })) as any;

    const info = await runtime.getContainerInfo("container-67890");
    expect(info.status).toBe("running");
  });

  it("normalizes listDeploymentContainers state string in case-insensitive manner", async () => {
    const runtime = await DockerRuntime.create();

    runtime.docker.listContainers = (async () => [
      {
        Id: "c1",
        State: "Running",
        Labels: { "openship.deployment": "dep1", "openship.service": "web" },
      },
      {
        Id: "c2",
        State: "HEALTHY",
        Labels: { "openship.deployment": "dep1", "openship.service": "db" },
      },
      {
        Id: "c3",
        State: "Exited",
        Labels: { "openship.deployment": "dep1", "openship.service": "cache" },
      },
    ]) as any;

    const results = await runtime.listDeploymentContainers("dep1");
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ containerId: "c1", status: "running", serviceName: "web" });
    expect(results[1]).toEqual({ containerId: "c2", status: "running", serviceName: "db" });
    expect(results[2]).toEqual({ containerId: "c3", status: "stopped", serviceName: "cache" });
  });

  it("listAllContainers carries the RAW state, status line and network ip", async () => {
    // The live service-state read matches on these fields: the raw state (so
    // `restarting` isn't collapsed into running), the human status line (health
    // suffix) and the ip from the list view (no extra inspect round-trip).
    const runtime = await DockerRuntime.create();

    runtime.docker.listContainers = (async () => [
      {
        Id: "c_api",
        Names: ["/openship-openship-api"],
        Image: "openship/openship-api:bld_x",
        ImageID: "sha256:1",
        State: "Restarting",
        Status: "Restarting (1) 44 seconds ago",
        Labels: { "openship.project": "proj_1", "openship.service": "api" },
        Ports: [{ PrivatePort: 4000, PublicPort: 4000, Type: "tcp" }],
        Mounts: [],
        NetworkSettings: { Networks: { "openship-openship": { IPAddress: "172.18.0.7" } } },
      },
    ]) as any;

    const [c] = await runtime.listAllContainers();
    expect(c).toMatchObject({
      id: "c_api",
      names: ["openship-openship-api"],
      state: "restarting",
      status: "Restarting (1) 44 seconds ago",
      ip: "172.18.0.7",
    });
    expect(c.ports[0]).toMatchObject({ privatePort: 4000, publicPort: 4000 });
  });

  it("listAllContainers omits ip when no network reports one", async () => {
    const runtime = await DockerRuntime.create();
    runtime.docker.listContainers = (async () => [
      {
        Id: "c_stopped",
        Names: ["/openship-openship-web"],
        Image: "img",
        ImageID: "sha256:2",
        State: "exited",
        Status: "Exited (0) 5 minutes ago",
        Labels: {},
        Ports: [],
        Mounts: [],
        NetworkSettings: { Networks: { bridge: { IPAddress: "" } } },
      },
    ]) as any;

    const [c] = await runtime.listAllContainers();
    expect(c.ip).toBeUndefined();
    expect(c.state).toBe("exited");
  });
});
