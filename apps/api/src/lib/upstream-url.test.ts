import { describe, expect, it, vi } from "vitest";
import {
  buildUpstreamUrl,
  resolveLiveUpstreamUrl,
  resolveRouteStrategy,
  resolveUpstreamUrl,
} from "./upstream-url";

/** A docker-shaped runtime whose live inspect we control. */
function dockerRuntime(opts: {
  /** undefined → the inspect throws (unreachable daemon). */
  info?: { status?: string; ip?: string; hostPort?: number };
  ip?: string | null;
}) {
  return {
    name: "docker" as const,
    supports: (cap: string) => cap === "containerIp" || cap === "containerInfo",
    getContainerInfo: vi.fn(async () => {
      if (!opts.info) throw new Error("daemon unreachable");
      return { containerId: "c1", status: "running", ...opts.info } as never;
    }),
    getContainerIp: vi.fn(async () => (opts.ip === undefined ? "172.19.0.2" : opts.ip)),
  };
}

describe("buildUpstreamUrl", () => {
  it("dials the loopback host port when the workload publishes one", () => {
    expect(
      buildUpstreamUrl({ strategy: "loopback-port", ip: "172.19.0.2", hostPort: 4000, containerPort: 3001 }),
    ).toBe("http://127.0.0.1:4000");
  });

  it("falls back to the container IP when nothing is published", () => {
    expect(buildUpstreamUrl({ strategy: "loopback-port", ip: "172.19.0.2", containerPort: 3001 })).toBe(
      "http://172.19.0.2:3001",
    );
  });

  it("returns null when neither a host port nor an ip is known", () => {
    expect(buildUpstreamUrl({ strategy: "loopback-port", containerPort: 3001 })).toBeNull();
  });

  it("ignores a published host port under the container-ip strategy", () => {
    expect(
      buildUpstreamUrl({ strategy: "container-ip", ip: "172.19.0.2", hostPort: 4000, containerPort: 3001 }),
    ).toBe("http://172.19.0.2:3001");
  });
});

describe("resolveRouteStrategy", () => {
  it.each([
    ["auto", "loopback-port"],
    [null, "loopback-port"],
    ["nonsense", "loopback-port"],
    ["container-ip", "container-ip"],
  ])("%s → %s", (setting, expected) => {
    expect(resolveRouteStrategy(setting)).toBe(expected);
  });
});

describe("resolveUpstreamUrl", () => {
  it("uses the passed host port without touching the runtime", async () => {
    const runtime = dockerRuntime({});
    await expect(
      resolveUpstreamUrl({
        strategy: "loopback-port",
        runtime,
        containerId: "c1",
        containerPort: 3001,
        hostPort: 4000,
      }),
    ).resolves.toBe("http://127.0.0.1:4000");
    expect(runtime.getContainerIp).not.toHaveBeenCalled();
  });

  it("resolves the container IP when no host port is passed", async () => {
    await expect(
      resolveUpstreamUrl({
        strategy: "loopback-port",
        runtime: dockerRuntime({}),
        containerId: "c1",
        containerPort: 3001,
      }),
    ).resolves.toBe("http://172.19.0.2:3001");
  });
});

describe("resolveLiveUpstreamUrl", () => {
  /**
   * #506: a same-server migration attaches a container that was never published
   * to 127.0.0.1, while `service_deployment.hostPort` still carries a port from
   * an earlier deploy. A live inspect that ANSWERED "nothing published" must win
   * over that stored port — otherwise the edge keeps dialing a dead loopback
   * port behind a domain the dashboard reports as Verified.
   */
  it("ignores a stored host port the container no longer publishes", async () => {
    const runtime = dockerRuntime({ info: { ip: "172.19.0.2" } });

    await expect(
      resolveLiveUpstreamUrl({
        strategy: "loopback-port",
        runtime,
        containerId: "c1",
        containerPort: 3001,
        stored: { ip: "172.19.0.2", hostPort: 3001 },
      }),
    ).resolves.toBe("http://172.19.0.2:3001");
  });

  it("uses the live host port when the container does publish one", async () => {
    await expect(
      resolveLiveUpstreamUrl({
        strategy: "loopback-port",
        runtime: dockerRuntime({ info: { ip: "172.19.0.2", hostPort: 4000 } }),
        containerId: "c1",
        containerPort: 3001,
        stored: { ip: "172.19.0.2", hostPort: 3999 },
      }),
    ).resolves.toBe("http://127.0.0.1:4000");
  });

  it("prefers the LIVE host port over a stale stored one", async () => {
    await expect(
      resolveLiveUpstreamUrl({
        strategy: "loopback-port",
        runtime: dockerRuntime({ info: { hostPort: 4100 } }),
        containerId: "c1",
        containerPort: 3001,
        stored: { hostPort: 4000 },
      }),
    ).resolves.toBe("http://127.0.0.1:4100");
  });

  it("keeps the last-known host port when the container CANNOT be inspected", async () => {
    // Unreachable daemon is not evidence that nothing is published — a re-apply
    // must not silently repoint a working vhost.
    await expect(
      resolveLiveUpstreamUrl({
        strategy: "loopback-port",
        runtime: dockerRuntime({ ip: null }),
        containerId: "c1",
        containerPort: 3001,
        stored: { ip: "172.19.0.2", hostPort: 4000 },
      }),
    ).resolves.toBe("http://127.0.0.1:4000");
  });

  it("keeps the last-known ip when the container cannot be inspected and nothing was published", async () => {
    await expect(
      resolveLiveUpstreamUrl({
        strategy: "loopback-port",
        runtime: dockerRuntime({ ip: null }),
        containerId: "c1",
        containerPort: 3001,
        stored: { ip: "172.19.0.2" },
      }),
    ).resolves.toBe("http://172.19.0.2:3001");
  });

  it("treats a MISSING container as publishing nothing, not as unknown", async () => {
    // The container is gone: a stored host port must not resurrect it. The last
    // known ip is still offered rather than blanking the route outright.
    await expect(
      resolveLiveUpstreamUrl({
        strategy: "loopback-port",
        runtime: dockerRuntime({ info: { status: "missing" }, ip: null }),
        containerId: "c1",
        containerPort: 3001,
        stored: { ip: "172.19.0.2", hostPort: 4000 },
      }),
    ).resolves.toBe("http://172.19.0.2:3001");
  });

  it("returns null when nothing — live or stored — resolves", async () => {
    await expect(
      resolveLiveUpstreamUrl({
        strategy: "loopback-port",
        runtime: dockerRuntime({ info: {}, ip: null }),
        containerId: "c1",
        containerPort: 3001,
      }),
    ).resolves.toBeNull();
  });

  it("never inspects for the container-ip strategy", async () => {
    const runtime = dockerRuntime({ info: { ip: "172.19.0.2", hostPort: 4000 } });

    await expect(
      resolveLiveUpstreamUrl({
        strategy: "container-ip",
        runtime,
        containerId: "c1",
        containerPort: 3001,
        stored: { hostPort: 4000 },
      }),
    ).resolves.toBe("http://172.19.0.2:3001");
    expect(runtime.getContainerInfo).not.toHaveBeenCalled();
  });

  it("routes a bare workload at its own loopback port without inspecting", async () => {
    const runtime = {
      name: "bare" as const,
      supports: () => true,
      getContainerInfo: vi.fn(),
      getContainerIp: vi.fn(async () => "127.0.0.1"),
    };

    await expect(
      resolveLiveUpstreamUrl({
        strategy: "loopback-port",
        runtime,
        containerId: "app",
        containerPort: 3001,
      }),
    ).resolves.toBe("http://127.0.0.1:3001");
    expect(runtime.getContainerInfo).not.toHaveBeenCalled();
  });

  it("falls back to the stored row when the runtime cannot inspect at all", async () => {
    const runtime = {
      name: "docker" as const,
      supports: (cap: string) => cap === "containerIp",
      getContainerIp: vi.fn(async () => null),
    };

    await expect(
      resolveLiveUpstreamUrl({
        strategy: "loopback-port",
        runtime,
        containerId: "c1",
        containerPort: 3001,
        stored: { hostPort: 4000 },
      }),
    ).resolves.toBe("http://127.0.0.1:4000");
  });
});
