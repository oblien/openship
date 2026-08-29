import { describe, expect, it } from "vitest";
import type { RuntimeAdapter } from "@repo/adapters";
import { resolveReadinessTarget } from "../../../src/modules/deployments/readiness-target";

function runtime(options: {
  name?: string;
  hostPort?: number;
  containerIp?: string | null;
}): RuntimeAdapter {
  return {
    name: options.name ?? "docker",
    supports: (capability: string) => capability === "containerIp",
    getContainerInfo: async () => ({ hostPort: options.hostPort }),
    getContainerIp: async () => options.containerIp ?? null,
  } as RuntimeAdapter;
}

describe("resolveReadinessTarget", () => {
  it("maps an explicit primary container port to its published host port", async () => {
    const target = await resolveReadinessTarget({
      runtime: runtime({ hostPort: 20_001, containerIp: "172.19.0.8" }),
      containerId: "container-1",
      primaryPort: 8080,
      probePort: 8080,
    });

    expect(target).toEqual({ host: "127.0.0.1", port: 20_001 });
  });

  it("uses the container address for an alternate container port", async () => {
    const target = await resolveReadinessTarget({
      runtime: runtime({ hostPort: 20_001, containerIp: "172.19.0.8" }),
      containerId: "container-1",
      primaryPort: 8080,
      probePort: 9090,
    });

    expect(target).toEqual({ host: "172.19.0.8", port: 9090 });
  });

  it("keeps bare workloads on loopback", async () => {
    let inspected = false;
    const bare = runtime({ name: "bare", hostPort: 20_001 });
    bare.getContainerInfo = async () => {
      inspected = true;
      throw new Error("bare runtime must not be inspected");
    };

    const target = await resolveReadinessTarget({
      runtime: bare,
      containerId: "process-1",
      primaryPort: 8080,
      probePort: 9090,
    });

    expect(target).toEqual({ host: "127.0.0.1", port: 9090 });
    expect(inspected).toBe(false);
  });
});
