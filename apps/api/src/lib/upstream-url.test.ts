import { describe, it, expect, vi } from "vitest";
import { buildUpstreamUrl, resolveRouteStrategy, resolveUpstreamUrl } from "./upstream-url";

describe("buildUpstreamUrl", () => {
  it("uses the loopback host port when one is provided", () => {
    expect(
      buildUpstreamUrl({
        strategy: "loopback-port",
        ip: "172.18.0.5",
        hostPort: 4000,
        containerPort: 3001,
      }),
    ).toBe("http://127.0.0.1:4000");
  });

  it("falls back to the container IP when no loopback host port is bound", () => {
    expect(
      buildUpstreamUrl({
        strategy: "loopback-port",
        ip: "172.18.0.5",
        containerPort: 3001,
      }),
    ).toBe("http://172.18.0.5:3001");
  });

  it("returns null when neither loopback host port nor container IP is known", () => {
    expect(
      buildUpstreamUrl({
        strategy: "loopback-port",
        containerPort: 3001,
      }),
    ).toBeNull();
  });

  it("always uses the container IP for the explicit container-ip strategy", () => {
    expect(
      buildUpstreamUrl({
        strategy: "container-ip",
        ip: "172.18.0.5",
        hostPort: 4000,
        containerPort: 3001,
      }),
    ).toBe("http://172.18.0.5:3001");
  });
});

describe("resolveRouteStrategy", () => {
  it("resolves auto to loopback-port", () => {
    expect(resolveRouteStrategy("auto")).toBe("loopback-port");
  });

  it("preserves the explicit container-ip strategy", () => {
    expect(resolveRouteStrategy("container-ip")).toBe("container-ip");
  });
});

describe("resolveUpstreamUrl", () => {
  it("falls back to the container IP when the container has no loopback host port", async () => {
    const runtime = {
      supports: (cap: string) => cap === "containerIp",
      getContainerIp: vi.fn().mockResolvedValue("172.18.0.5"),
    };

    const url = await resolveUpstreamUrl({
      strategy: "loopback-port",
      runtime,
      containerId: "abc123",
      containerPort: 3001,
    });

    expect(url).toBe("http://172.18.0.5:3001");
    expect(runtime.getContainerIp).toHaveBeenCalledWith("abc123");
  });

  it("uses the provided loopback host port when one is bound", async () => {
    const runtime = {
      supports: () => false,
      getContainerIp: vi.fn(),
    };

    const url = await resolveUpstreamUrl({
      strategy: "loopback-port",
      runtime,
      containerId: "abc123",
      containerPort: 3001,
      hostPort: 4000,
    });

    expect(url).toBe("http://127.0.0.1:4000");
    expect(runtime.getContainerIp).not.toHaveBeenCalled();
  });

  it("returns null when the container IP cannot be resolved", async () => {
    const runtime = {
      supports: () => true,
      getContainerIp: vi.fn().mockResolvedValue(null),
    };

    const url = await resolveUpstreamUrl({
      strategy: "loopback-port",
      runtime,
      containerId: "missing",
      containerPort: 3001,
    });

    expect(url).toBeNull();
  });
});
