import { describe, it, expect } from "vitest";
import { resolveUpstreamUrl, resolveRouteStrategy } from "../../src/lib/upstream-url";

const dockerRuntime = {
  supports: (c: string) => c === "containerIp",
  getContainerIp: async () => "172.18.0.5",
};
const bareRuntime = {
  supports: (c: string) => c === "containerIp",
  getContainerIp: async () => "127.0.0.1",
};

describe("resolveUpstreamUrl", () => {
  it("loopback-port with a pinned host port dials 127.0.0.1:<hostPort>", async () => {
    const url = await resolveUpstreamUrl({
      strategy: "loopback-port",
      runtime: dockerRuntime,
      containerId: "c1",
      containerPort: 3000,
      hostPort: 20050,
    });
    expect(url).toBe("http://127.0.0.1:20050");
  });

  it("loopback-port with NO host port falls back to the container IP", async () => {
    const url = await resolveUpstreamUrl({
      strategy: "loopback-port",
      runtime: dockerRuntime,
      containerId: "c1",
      containerPort: 3000,
    });
    expect(url).toBe("http://172.18.0.5:3000");
  });

  it("container-ip dials the bridge IP:containerPort", async () => {
    const url = await resolveUpstreamUrl({
      strategy: "container-ip",
      runtime: dockerRuntime,
      containerId: "c1",
      containerPort: 3000,
      hostPort: 20050, // ignored in container-ip mode
    });
    expect(url).toBe("http://172.18.0.5:3000");
  });

  it("bare resolves to loopback:<appPort> under either strategy", async () => {
    for (const strategy of ["loopback-port", "container-ip"] as const) {
      const url = await resolveUpstreamUrl({
        strategy,
        runtime: bareRuntime,
        containerId: "svc",
        containerPort: 4000,
      });
      expect(url).toBe("http://127.0.0.1:4000");
    }
  });

  it("returns null when the container IP can't be resolved", async () => {
    const url = await resolveUpstreamUrl({
      strategy: "container-ip",
      runtime: { supports: () => true, getContainerIp: async () => null },
      containerId: "gone",
      containerPort: 3000,
    });
    expect(url).toBeNull();
  });
});

describe("resolveRouteStrategy", () => {
  it("auto / unset / legacy → loopback-port", () => {
    expect(resolveRouteStrategy("auto")).toBe("loopback-port");
    expect(resolveRouteStrategy(null)).toBe("loopback-port");
    expect(resolveRouteStrategy(undefined)).toBe("loopback-port");
    expect(resolveRouteStrategy("network-dns")).toBe("loopback-port");
  });
  it("honors an explicit container-ip", () => {
    expect(resolveRouteStrategy("container-ip")).toBe("container-ip");
  });
  it("honors an explicit loopback-port", () => {
    expect(resolveRouteStrategy("loopback-port")).toBe("loopback-port");
  });
});
