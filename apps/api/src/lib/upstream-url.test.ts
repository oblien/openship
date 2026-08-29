import { describe, expect, it, vi } from "vitest";
import {
  buildUpstreamUrl,
  resolveLiveUpstreamUrl,
  resolveRouteStrategy,
  resolveUpstreamUrl,
  usesHostLoopbackUpstream,
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
      buildUpstreamUrl({
        strategy: "loopback-port",
        ip: "172.19.0.2",
        hostPort: 4000,
        containerPort: 3001,
      }),
    ).toBe("http://127.0.0.1:4000");
  });

  it("falls back to the container IP when nothing is published", () => {
    expect(
      buildUpstreamUrl({ strategy: "loopback-port", ip: "172.19.0.2", containerPort: 3001 }),
    ).toBe("http://172.19.0.2:3001");
  });

  it("returns null when neither a host port nor an ip is known", () => {
    expect(buildUpstreamUrl({ strategy: "loopback-port", containerPort: 3001 })).toBeNull();
  });

  it("ignores a published host port under the container-ip strategy", () => {
    expect(
      buildUpstreamUrl({
        strategy: "container-ip",
        ip: "172.19.0.2",
        hostPort: 4000,
        containerPort: 3001,
      }),
    ).toBe("http://172.19.0.2:3001");
  });

  it("selects the persisted publish for the requested container port", () => {
    expect(
      buildUpstreamUrl({
        strategy: "loopback-port",
        ip: "172.19.0.2",
        hostPort: 4000,
        hostPorts: { "3000": 4000, "3001": 4001 },
        containerPort: 3001,
      }),
    ).toBe("http://127.0.0.1:4001");
  });

  it("does not borrow the scalar when a persisted map proves this port is unpublished", () => {
    expect(
      buildUpstreamUrl({
        strategy: "loopback-port",
        ip: "172.19.0.2",
        hostPort: 4000,
        hostPorts: { "3000": 4000 },
        containerPort: 3001,
      }),
    ).toBe("http://172.19.0.2:3001");
  });

  it("keeps scalar-only migrated rows backwards compatible", () => {
    expect(
      buildUpstreamUrl({
        strategy: "loopback-port",
        hostPort: 4000,
        hostPorts: { __legacy__: 4000 },
        containerPort: 3001,
      }),
    ).toBe("http://127.0.0.1:4000");
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

describe("usesHostLoopbackUpstream", () => {
  const topologyRuntime = (name: string, containerIp: boolean) => ({
    name,
    supports: (capability: string) => capability === "containerIp" && containerIp,
  });

  it("accounts for runtime topology instead of trusting only the stored strategy", () => {
    expect(usesHostLoopbackUpstream("container-ip", topologyRuntime("docker", true))).toBe(false);
    expect(usesHostLoopbackUpstream("loopback-port", topologyRuntime("docker", true))).toBe(true);
    expect(usesHostLoopbackUpstream("container-ip", topologyRuntime("bare", true))).toBe(true);
    expect(usesHostLoopbackUpstream("container-ip", topologyRuntime("host-only", false))).toBe(
      true,
    );
    expect(usesHostLoopbackUpstream("loopback-port", topologyRuntime("cloud", true))).toBe(false);
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

  it("uses the reserved host port when container IP is unsupported", async () => {
    const getContainerIp = vi.fn(async () => {
      throw new Error("container IP is unavailable");
    });

    await expect(
      resolveUpstreamUrl({
        strategy: "container-ip",
        runtime: {
          name: "host-only",
          supports: () => false,
          getContainerIp,
        },
        containerId: "c1",
        containerPort: 3001,
        hostPort: 20_041,
      }),
    ).resolves.toBe("http://127.0.0.1:20041");
    expect(getContainerIp).not.toHaveBeenCalled();
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

  it("route writers refuse a cached host port when live inspection is unavailable", async () => {
    await expect(
      resolveLiveUpstreamUrl({
        strategy: "loopback-port",
        runtime: dockerRuntime({ ip: null }),
        containerId: "c1",
        containerPort: 3001,
        stored: { ip: "172.19.0.2", hostPort: 4000 },
        requireLiveObservation: true,
      }),
    ).resolves.toBeNull();
  });

  it("route writers refuse a stopped container's retained HostConfig publish", async () => {
    await expect(
      resolveLiveUpstreamUrl({
        strategy: "loopback-port",
        runtime: dockerRuntime({ info: { status: "stopped", hostPort: 4000 } }),
        containerId: "c1",
        containerPort: 3001,
        stored: { hostPort: 4000 },
        requireLiveObservation: true,
      }),
    ).resolves.toBeNull();
  });

  it("uses the requested port's durable binding when live inspection is unavailable", async () => {
    await expect(
      resolveLiveUpstreamUrl({
        strategy: "loopback-port",
        runtime: dockerRuntime({ ip: null }),
        containerId: "c1",
        containerPort: 3001,
        stored: {
          ip: "172.19.0.2",
          hostPort: 4000,
          hostPorts: { "3000": 4000, "3001": 4001 },
        },
      }),
    ).resolves.toBe("http://127.0.0.1:4001");
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

/**
 * A container publishing SEVERAL ports has one binding per port, and
 * `ContainerInfo.hostPort` is whichever the daemon listed first. Reading that scalar
 * for a specific container port dialed the wrong app: minio's console route resolved
 * to the S3 port's publish, the vhost came up green, and the domain served the other
 * service. `hostPortByContainerPort` is the per-port answer; these pin that it is
 * preferred, and that "this port isn't published" is honoured rather than papered
 * over with a sibling's number.
 */
describe("resolveLiveUpstreamUrl — multi-port containers", () => {
  const multiPortRuntime = (map: Record<number, number>, scalar?: number) => ({
    name: "docker" as const,
    supports: (cap: string) => cap === "containerIp" || cap === "containerInfo",
    getContainerInfo: vi.fn(
      async () =>
        ({
          containerId: "c1",
          status: "running",
          ip: "172.19.0.9",
          hostPort: scalar,
          hostPortByContainerPort: map,
        }) as never,
    ),
    getContainerIp: vi.fn(async () => "172.19.0.9"),
  });

  it("dials the publish belonging to THIS container port, not the first binding", async () => {
    const url = await resolveLiveUpstreamUrl({
      strategy: "loopback-port",
      runtime: multiPortRuntime({ 9000: 34100, 9001: 34101 }, 34100),
      containerId: "c1",
      containerPort: 9001,
    });
    expect(url).toBe("http://127.0.0.1:34101");
  });

  it("falls back to the container IP when THIS port is not published", async () => {
    // The map exists and has no 9000, so 9000 genuinely isn't published. Borrowing
    // 9001's publish here is what served the wrong app.
    const url = await resolveLiveUpstreamUrl({
      strategy: "loopback-port",
      runtime: multiPortRuntime({ 9001: 34101 }, 34101),
      containerId: "c1",
      containerPort: 9000,
    });
    expect(url).toBe("http://172.19.0.9:9000");
  });

  it("does not resurrect a stored port for an unpublished port", async () => {
    // #506: the live read ANSWERED (map present, no entry) — that is "publishes
    // nothing", not "couldn't ask", so the stored port must not come back.
    const url = await resolveLiveUpstreamUrl({
      strategy: "loopback-port",
      runtime: multiPortRuntime({ 9001: 34101 }),
      containerId: "c1",
      containerPort: 9000,
      stored: { ip: "172.19.0.9", hostPort: 34100 },
    });
    expect(url).toBe("http://172.19.0.9:9000");
  });

  it("dials a port the caller named by its PUBLISHED side", async () => {
    // A project-level route carries whichever side of `8080:3000` the operator typed,
    // and project-route's primary-container fallback passes it through unresolved. 8080
    // is a host port on this container, so it is the exact dial — not a borrowed one.
    const url = await resolveLiveUpstreamUrl({
      strategy: "loopback-port",
      runtime: multiPortRuntime({ 3000: 8080 }, 8080),
      containerId: "c1",
      containerPort: 8080,
    });
    expect(url).toBe("http://127.0.0.1:8080");
  });

  it("prefers the container-port key over a colliding published value", async () => {
    // 8080 is both a container port (→34100) and 3000's publish. The container side
    // wins, so the route dials what the app inside 8080 is reachable at.
    const url = await resolveLiveUpstreamUrl({
      strategy: "loopback-port",
      runtime: multiPortRuntime({ 3000: 8080, 8080: 34100 }, 8080),
      containerId: "c1",
      containerPort: 8080,
    });
    expect(url).toBe("http://127.0.0.1:34100");
  });

  it("still reads the scalar from a runtime that reports no map", async () => {
    const legacy = {
      name: "docker" as const,
      supports: (cap: string) => cap === "containerIp" || cap === "containerInfo",
      getContainerInfo: vi.fn(
        async () =>
          ({
            containerId: "c1",
            status: "running",
            ip: "172.19.0.9",
            hostPort: 4000,
          }) as never,
      ),
      getContainerIp: vi.fn(async () => "172.19.0.9"),
    };
    expect(
      await resolveLiveUpstreamUrl({
        strategy: "loopback-port",
        runtime: legacy,
        containerId: "c1",
        containerPort: 3001,
      }),
    ).toBe("http://127.0.0.1:4000");
  });
});
