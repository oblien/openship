import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Per-project resource usage.
 *
 * The bug this replaced: usage read `deployment.containerId` and stopped. On a
 * compose project that id belongs to the PRIMARY service, so a five-service stack
 * reported one container's CPU as the project's and the other four were invisible.
 *
 * Three things are worth pinning, because each has a silent failure mode:
 *   - identity is resolved LIVE on a host that can be enumerated (the recorded id
 *     goes stale on every redeploy, and an adopted container never had our labels)
 *   - one dead container must not blank the whole card
 *   - a runtime that CANNOT measure must say so instead of returning zeros, which
 *     are indistinguishable from a genuinely idle app
 */

const usage = (cpu: number, mem: number) => ({
  cpuPercent: cpu,
  memoryMb: mem,
  diskMb: 0,
  networkRxBytes: 0,
  networkTxBytes: 0,
});

const h = vi.hoisted(() => ({
  project: null as Record<string, unknown> | null,
  deployment: null as Record<string, unknown> | null,
  services: [] as Array<{ id: string; name: string }>,
  serviceDeployments: [] as Array<{ serviceId: string; containerId: string | null }>,
  /** null = the host refused to enumerate (cloud, unreachable). */
  liveContainers: null as Array<Record<string, unknown>> | null,
  /** How many times listAllContainers was invoked in the current test. */
  listCalls: 0,
  caps: new Set<string>(["usage", "hostContainerQuery"]),
  usageByContainer: new Map<string, ReturnType<typeof usage> | Error>(),
  getUsage: vi.fn(),
  dispose: vi.fn(async () => {}),
  capacity: { cpuCores: 4, memoryMb: 8192 } as Record<string, unknown> | null,
}));

vi.mock("@repo/db", () => ({
  repos: {
    project: { findById: vi.fn(async () => h.project) },
    deployment: { findById: vi.fn(async () => h.deployment) },
    service: {
      listByProject: vi.fn(async () => h.services),
      listByDeployment: vi.fn(async () => h.serviceDeployments),
    },
  },
}));

vi.mock("../../../src/lib/deployment-runtime", () => ({
  resolveDeploymentRuntimeForRead: vi.fn(async () => ({
    runtime: {
      name: "docker",
      supports: (cap: string) => h.caps.has(cap),
      listAllContainers: h.caps.has("hostContainerQuery")
        ? async () => {
            h.listCalls += 1;
            if (!h.liveContainers) throw new Error("host unreachable");
            return h.liveContainers;
          }
        : undefined,
      getUsage: h.getUsage,
      dispose: h.dispose,
    },
    serverId: "s1",
  })),
}));

vi.mock("../../../src/lib/host-capacity", () => ({
  getHostCapacity: vi.fn(async () => h.capacity),
}));

vi.mock("../../../src/lib/system-debug", () => ({ systemDebug: vi.fn() }));

const { collectProjectUsage } = await import("../../../src/modules/monitoring/project-usage");

const ctx = { organizationId: "org1" } as never;

/** A `docker ps -a` entry carrying our canonical labels. */
const container = (id: string, service: string, state = "running") => ({
  id,
  names: [`openship-app-${service}`],
  state,
  status: state === "running" ? "Up 2 hours" : "Exited (0) 1 min ago",
  labels: { "openship.project": "p1", "openship.service": service },
  ports: [],
});

beforeEach(() => {
  h.project = { id: "p1", organizationId: "org1", slug: "app", name: "App", activeDeploymentId: "d1" };
  h.deployment = { id: "d1", containerId: "c-primary", meta: {}, organizationId: "org1" };
  h.services = [];
  h.serviceDeployments = [];
  h.liveContainers = [];
  h.caps = new Set(["usage", "hostContainerQuery"]);
  h.listCalls = 0;
  h.capacity = { cpuCores: 4, memoryMb: 8192 };
  h.usageByContainer = new Map();
  h.dispose.mockClear();
  h.getUsage.mockReset();
  h.getUsage.mockImplementation(async (id: string) => {
    const v = h.usageByContainer.get(id);
    if (v instanceof Error) throw v;
    if (!v) throw new Error(`no such container: ${id}`);
    return v;
  });
});

describe("single-container app", () => {
  it("uses the deployment's container when there are no service rows", async () => {
    h.usageByContainer.set("c-primary", usage(12.5, 256));
    const r = await collectProjectUsage(ctx, "p1");

    expect(r.supported).toBe(true);
    expect(r.services).toHaveLength(1);
    expect(r.services[0]).toMatchObject({ serviceId: null, name: "App", containerId: "c-primary" });
    expect(r.overall).toMatchObject({ cpuPercent: 12.5, memoryMb: 256 });
  });

  it("returns no targets when the deployment has no container yet", async () => {
    h.deployment = { id: "d1", containerId: null, meta: {}, organizationId: "org1" };
    const r = await collectProjectUsage(ctx, "p1");
    expect(r.services).toEqual([]);
    expect(r.overall.cpuPercent).toBe(0);
  });
});

describe("compose project", () => {
  beforeEach(() => {
    h.services = [
      { id: "sv-web", name: "web" },
      { id: "sv-db", name: "db" },
    ];
    h.serviceDeployments = [
      { serviceId: "sv-web", containerId: "c-web" },
      { serviceId: "sv-db", containerId: "c-db" },
    ];
    h.liveContainers = [container("c-web", "web"), container("c-db", "db")];
  });

  it("covers EVERY service, not just the one on deployment.containerId", async () => {
    h.usageByContainer.set("c-web", usage(10, 100));
    h.usageByContainer.set("c-db", usage(5.5, 400));

    const r = await collectProjectUsage(ctx, "p1");

    expect(r.services.map((s) => s.name).sort()).toEqual(["db", "web"]);
    // Overall is the SUM across the stack — the whole point of the change.
    expect(r.overall.cpuPercent).toBe(15.5);
    expect(r.overall.memoryMb).toBe(500);
  });

  it("resolves identity from the LIVE host, so a stale recorded id doesn't win", async () => {
    // What actually runs is c-web-NEW (a redeploy replaced the container), while the
    // service_deployment row still names the old one.
    h.serviceDeployments = [{ serviceId: "sv-web", containerId: "c-web-OLD" }];
    h.services = [{ id: "sv-web", name: "web" }];
    h.liveContainers = [container("c-web-NEW", "web")];
    h.usageByContainer.set("c-web-NEW", usage(3, 30));

    const r = await collectProjectUsage(ctx, "p1");
    expect(r.services[0].containerId).toBe("c-web-NEW");
    expect(r.overall.cpuPercent).toBe(3);
  });

  it("reports a service whose container is gone as stopped with null usage, and keeps the rest", async () => {
    h.liveContainers = [container("c-web", "web")]; // db's container no longer exists
    h.usageByContainer.set("c-web", usage(8, 80));

    const r = await collectProjectUsage(ctx, "p1");
    const db = r.services.find((s) => s.name === "db")!;

    expect(db).toMatchObject({ containerId: null, status: "stopped", usage: null });
    // One missing service must not blank the card.
    expect(r.overall.cpuPercent).toBe(8);
  });

  it("does not fail the whole read when one getUsage throws", async () => {
    h.usageByContainer.set("c-web", usage(9, 90));
    h.usageByContainer.set("c-db", new Error("container removed mid-sample"));

    const r = await collectProjectUsage(ctx, "p1");
    expect(r.services.find((s) => s.name === "db")!.usage).toBeNull();
    expect(r.overall.cpuPercent).toBe(9);
  });

  it("surfaces a crash-looping container as restarting rather than running", async () => {
    h.liveContainers = [container("c-web", "web", "restarting"), container("c-db", "db")];
    h.usageByContainer.set("c-web", usage(1, 10));
    h.usageByContainer.set("c-db", usage(1, 10));

    const r = await collectProjectUsage(ctx, "p1");
    expect(r.services.find((s) => s.name === "web")!.status).toBe("restarting");
  });

  it("does not pay for a stopped container — stats on one has nothing to give", async () => {
    // `getUsage` occupies the daemon ~1s. Asking a stopped container costs that for
    // a guaranteed miss, and the host listing already told us it isn't running.
    h.liveContainers = [container("c-web", "web"), container("c-db", "db", "exited")];
    h.usageByContainer.set("c-web", usage(6, 60));
    h.usageByContainer.set("c-db", usage(99, 999)); // must never be read

    const r = await collectProjectUsage(ctx, "p1");

    expect(h.getUsage).toHaveBeenCalledTimes(1);
    expect(h.getUsage).toHaveBeenCalledWith("c-web");
    expect(r.services.find((s) => s.name === "db")).toMatchObject({
      status: "stopped",
      usage: null,
    });
    expect(r.overall.cpuPercent).toBe(6);
  });

  it("skips a restarting container rather than charting noise from a bouncing one", async () => {
    h.liveContainers = [container("c-web", "web", "restarting"), container("c-db", "db")];
    h.usageByContainer.set("c-db", usage(2, 20));

    const r = await collectProjectUsage(ctx, "p1");
    const web = r.services.find((s) => s.name === "web")!;

    // Status still surfaces the crash loop — that IS the signal. The numbers don't,
    // because a container mid-restart has none worth plotting.
    expect(web.status).toBe("restarting");
    expect(web.usage).toBeNull();
    expect(h.getUsage).not.toHaveBeenCalledWith("c-web");
  });

  it("bounds stats concurrency — an unbounded fan-out hits one daemon with N second-long calls", async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `sv-${i}`, name: `s${i}` }));
    h.services = many;
    h.serviceDeployments = many.map((s) => ({ serviceId: s.id, containerId: `c-${s.name}` }));
    h.liveContainers = many.map((s) => container(`c-${s.name}`, s.name));

    let concurrent = 0;
    let peak = 0;
    h.getUsage.mockImplementation(async () => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((r) => setTimeout(r, 2));
      concurrent -= 1;
      return usage(1, 1);
    });

    await collectProjectUsage(ctx, "p1");

    expect(h.getUsage).toHaveBeenCalledTimes(20);
    expect(peak).toBeLessThanOrEqual(8);
  });

  it("queries the host ONCE for the whole project, not once per service", async () => {
    // A compose stack polled every few seconds would otherwise issue N
    // `docker ps -a` calls per tick over the same SSH connection.
    h.usageByContainer.set("c-web", usage(1, 1));
    h.usageByContainer.set("c-db", usage(1, 1));

    await collectProjectUsage(ctx, "p1");
    expect(h.listCalls).toBe(1);
  });
});

describe("cloud (no host enumeration)", () => {
  it("falls back to the recorded workspace ids when the runtime can't list containers", async () => {
    // Oblien services are workspaces; there is no `docker ps` equivalent.
    h.caps = new Set(["usage"]);
    h.services = [{ id: "sv-web", name: "web" }];
    h.serviceDeployments = [{ serviceId: "sv-web", containerId: "ws-123" }];
    h.usageByContainer.set("ws-123", usage(20, 512));

    const r = await collectProjectUsage(ctx, "p1");
    expect(r.services[0]).toMatchObject({ containerId: "ws-123", usage: expect.anything() });
    expect(r.overall.cpuPercent).toBe(20);
  });

  it("degrades to recorded ids rather than nothing when the host query FAILS", async () => {
    h.services = [{ id: "sv-web", name: "web" }];
    h.serviceDeployments = [{ serviceId: "sv-web", containerId: "c-web" }];
    h.liveContainers = null; // listAllContainers throws
    h.usageByContainer.set("c-web", usage(4, 44));

    const r = await collectProjectUsage(ctx, "p1");
    expect(r.services[0].containerId).toBe("c-web");
    expect(r.overall.cpuPercent).toBe(4);
  });
});

describe("capability gate", () => {
  it("says unsupported instead of reporting a stub's zeros as a measurement", async () => {
    h.caps = new Set(); // no "usage" — e.g. a runtime with no accounting
    const r = await collectProjectUsage(ctx, "p1");

    expect(r.supported).toBe(false);
    expect(r.reason).toMatch(/not available/i);
    expect(h.getUsage).not.toHaveBeenCalled();
  });
});

describe("lifecycle", () => {
  it("always disposes the runtime — it holds an SSH loopback bridge", async () => {
    h.usageByContainer.set("c-primary", usage(1, 1));
    await collectProjectUsage(ctx, "p1");
    expect(h.dispose).toHaveBeenCalled();
  });

  it("disposes even when the capability gate short-circuits", async () => {
    h.caps = new Set();
    await collectProjectUsage(ctx, "p1");
    expect(h.dispose).toHaveBeenCalled();
  });

  it("reports capacity as denominators, and null (not 0) when unknown", async () => {
    h.usageByContainer.set("c-primary", usage(1, 1));
    expect((await collectProjectUsage(ctx, "p1")).capacity).toEqual({ cpuCores: 4, memoryMb: 8192 });

    h.capacity = null; // cloud: getHostCapacity never probes tenant hardware
    expect((await collectProjectUsage(ctx, "p1")).capacity).toEqual({
      cpuCores: null,
      memoryMb: null,
    });
  });
});

describe("guards", () => {
  it("404s a project outside the caller's organization", async () => {
    h.project = { id: "p1", organizationId: "other", slug: "app", name: "App", activeDeploymentId: "d1" };
    await expect(collectProjectUsage(ctx, "p1")).rejects.toThrow();
  });

  it("reports no active deployment as unsupported-with-reason, not as an error", async () => {
    h.project = { id: "p1", organizationId: "org1", slug: "app", name: "App", activeDeploymentId: null };
    const r = await collectProjectUsage(ctx, "p1");
    expect(r.supported).toBe(false);
    expect(r.reason).toMatch(/no active deployment/i);
  });
});
