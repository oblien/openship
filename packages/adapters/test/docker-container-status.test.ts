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
});
