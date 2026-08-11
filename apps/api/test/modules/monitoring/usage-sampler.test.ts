import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The `resources:sample` sweep.
 *
 * `docker stats` occupies the daemon for roughly a SECOND per container (it must
 * collect two CPU samples to compute a delta), so nearly every property worth pinning
 * here is about not spending that second unnecessarily: one host listing per server
 * rather than per project, running containers only, bounded fan-out, a hard per-server
 * budget whose overflow is REPORTED rather than dropped, and serial across servers so
 * a 50-box estate isn't probed all at once.
 */

const usage = (cpu: number, mem: number, rx = 0, tx = 0) => ({
  cpuPercent: cpu,
  memoryMb: mem,
  diskMb: 0,
  networkRxBytes: rx,
  networkTxBytes: tx,
});

const h = vi.hoisted(() => ({
  projects: [] as Array<Record<string, unknown>>,
  deployments: new Map<string, Record<string, unknown>>(),
  servicesByProject: new Map<string, Array<{ id: string; name: string }>>(),
  serviceDeployments: [] as Array<{ serviceId: string; containerId: string | null }>,
  liveContainers: [] as Array<Record<string, unknown>>,
  caps: new Set<string>(["usage", "hostContainerQuery"]),
  inserted: [] as Array<Record<string, unknown>>,
  /** How many times insertSamples was called this test — the batching assertion. */
  insertCalls: 0,
  getUsage: vi.fn(),
  dispose: vi.fn(async () => {}),
  listCalls: 0,
  resolveCalls: 0,
  /** Server keys whose runtime resolution throws. */
  failingServers: new Set<string>(),
  concurrentPeak: 0,
  /** Order in which servers were entered, to assert serial execution. */
  serverOrder: [] as string[],
  activeServers: 0,
  serverPeak: 0,
}));

vi.mock("@repo/db", () => ({
  RESOURCE_BUCKET_MINUTES: 5,
  SINGLE_APP_SERVICE_KEY: "__app__",
  repos: {
    project: { listAllForScan: vi.fn(async () => h.projects) },
    deployment: { findManyById: vi.fn(async () => h.deployments) },
    service: {
      listByProjects: vi.fn(async () => h.servicesByProject),
      listByDeployment: vi.fn(async () => h.serviceDeployments),
    },
    resourceUsage: {
      insertSamples: vi.fn(async (rows: Array<Record<string, unknown>>) => {
        h.insertCalls += 1;
        h.inserted.push(...rows);
      }),
    },
  },
}));

vi.mock("../../../src/lib/deployment-runtime", () => ({
  resolveDeploymentRuntimeForRead: vi.fn(async (dep: { meta?: { serverId?: string } }) => {
    h.resolveCalls += 1;
    const key = dep.meta?.serverId ?? "__local__";
    if (h.failingServers.has(key)) throw new Error("ssh refused");
    h.serverOrder.push(key);
    h.activeServers += 1;
    h.serverPeak = Math.max(h.serverPeak, h.activeServers);
    return {
      runtime: {
        name: "docker",
        supports: (c: string) => h.caps.has(c),
        listAllContainers: h.caps.has("hostContainerQuery")
          ? async () => {
              h.listCalls += 1;
              return h.liveContainers;
            }
          : undefined,
        getUsage: h.getUsage,
        dispose: async () => {
          h.activeServers -= 1;
          await h.dispose();
        },
      },
      serverId: dep.meta?.serverId ?? null,
    };
  }),
}));

vi.mock("../../../src/lib/system-debug", () => ({
  systemDebug: vi.fn(),
  formatDuration: () => "1ms",
}));

const { runUsageSampleSweep, bucketMinuteFor } = await import(
  "../../../src/modules/monitoring/usage-sampler"
);

const container = (id: string, service: string, state = "running") => ({
  id,
  names: [`openship-app-${service}`],
  state,
  status: state === "running" ? "Up 1 hour" : "Exited (0)",
  labels: { "openship.project": "p1", "openship.service": service },
  ports: [],
});

/** A project + its active deployment, on `serverId`. */
function project(id: string, serverId: string | null, containerId: string | null = null) {
  h.projects.push({ id, slug: "app", activeDeploymentId: `d-${id}`, disabledAt: null });
  h.deployments.set(`d-${id}`, {
    id: `d-${id}`,
    organizationId: "org1",
    containerId,
    meta: serverId ? { serverId } : {},
  });
}

beforeEach(() => {
  h.projects = [];
  h.deployments = new Map();
  h.servicesByProject = new Map();
  h.serviceDeployments = [];
  h.liveContainers = [];
  h.caps = new Set(["usage", "hostContainerQuery"]);
  h.inserted = [];
  h.insertCalls = 0;
  h.listCalls = 0;
  h.resolveCalls = 0;
  h.failingServers = new Set();
  h.concurrentPeak = 0;
  h.serverOrder = [];
  h.activeServers = 0;
  h.serverPeak = 0;
  h.dispose.mockClear();
  h.getUsage.mockReset();
  h.getUsage.mockImplementation(async () => usage(5, 50));
});

describe("bucketMinuteFor", () => {
  it("floors to a 5-minute multiple so a re-run lands on the same key", () => {
    const at = (m: number) => bucketMinuteFor(m * 60_000);
    expect(at(1_000_000)).toBe(1_000_000);
    expect(at(1_000_001)).toBe(1_000_000);
    expect(at(1_000_004)).toBe(1_000_000);
    expect(at(1_000_005)).toBe(1_000_005);
    // Every sample in one sweep shares a key — that plus onConflictDoNothing is what
    // makes the sweep idempotent rather than duplicating rows on a re-run.
    expect(at(1_000_002)).toBe(at(1_000_003));
  });
});

describe("scope", () => {
  it("samples a single-container project under the shared sentinel key", async () => {
    project("p1", "s1", "c-app");
    h.liveContainers = [{ ...container("c-app", "app"), labels: {} }];

    const r = await runUsageSampleSweep();

    expect(h.inserted).toHaveLength(1);
    expect(h.inserted[0]).toMatchObject({
      projectId: "p1",
      serviceKey: "__app__",
      cpuPercent: 5,
      memoryMb: 50,
    });
    expect(r.samples).toBe(1);
  });

  it("samples every service of a compose project", async () => {
    project("p1", "s1", "c-web");
    h.servicesByProject.set("p1", [
      { id: "sv-web", name: "web" },
      { id: "sv-db", name: "db" },
    ]);
    h.serviceDeployments = [
      { serviceId: "sv-web", containerId: "c-web" },
      { serviceId: "sv-db", containerId: "c-db" },
    ];
    h.liveContainers = [container("c-web", "web"), container("c-db", "db")];

    await runUsageSampleSweep();

    expect(h.inserted.map((r) => r.serviceKey).sort()).toEqual(["sv-db", "sv-web"]);
  });

  it("skips projects with no active deployment", async () => {
    h.projects.push({ id: "p9", slug: "app", activeDeploymentId: null, disabledAt: null });
    const r = await runUsageSampleSweep();
    expect(r.samples).toBe(0);
    expect(h.resolveCalls).toBe(0);
  });

  it("skips a disabled project", async () => {
    project("p1", "s1", "c-app");
    (h.projects[0] as Record<string, unknown>).disabledAt = new Date();
    const r = await runUsageSampleSweep();
    expect(r.samples).toBe(0);
  });
});

describe("not paying for what has nothing to give", () => {
  it("skips a stopped container", async () => {
    project("p1", "s1", "c-web");
    h.servicesByProject.set("p1", [
      { id: "sv-web", name: "web" },
      { id: "sv-db", name: "db" },
    ]);
    h.serviceDeployments = [
      { serviceId: "sv-web", containerId: "c-web" },
      { serviceId: "sv-db", containerId: "c-db" },
    ];
    h.liveContainers = [container("c-web", "web"), container("c-db", "db", "exited")];

    await runUsageSampleSweep();

    // A stopped container costs a full second for a guaranteed miss, and the host
    // listing already told us. Nor should a zero row be written — that would read as
    // "idle" on the chart rather than "not running".
    expect(h.getUsage).toHaveBeenCalledTimes(1);
    expect(h.inserted.map((r) => r.serviceKey)).toEqual(["sv-web"]);
  });

  it("lists the host ONCE per server, not once per project", async () => {
    project("p1", "s1", "c-1");
    project("p2", "s1", "c-2");
    project("p3", "s1", "c-3");
    h.liveContainers = [
      { ...container("c-1", "a"), labels: {} },
      { ...container("c-2", "b"), labels: {} },
      { ...container("c-3", "c"), labels: {} },
    ];

    await runUsageSampleSweep();

    expect(h.listCalls).toBe(1);
    expect(h.resolveCalls).toBe(1);
    expect(h.inserted).toHaveLength(3);
  });

  it("bounds stats concurrency within a server", async () => {
    const many = Array.from({ length: 20 }, (_, i) => `c-${i}`);
    many.forEach((id, i) => project(`p${i}`, "s1", id));
    h.liveContainers = many.map((id, i) => ({ ...container(id, `s${i}`), labels: {} }));

    let active = 0;
    h.getUsage.mockImplementation(async () => {
      active += 1;
      h.concurrentPeak = Math.max(h.concurrentPeak, active);
      await new Promise((r) => setTimeout(r, 2));
      active -= 1;
      return usage(1, 1);
    });

    await runUsageSampleSweep();

    expect(h.getUsage).toHaveBeenCalledTimes(20);
    expect(h.concurrentPeak).toBeLessThanOrEqual(8);
  });

  it("goes one server at a time — a 50-box estate must not be probed at once", async () => {
    project("p1", "s1", "c-1");
    project("p2", "s2", "c-2");
    project("p3", "s3", "c-3");
    h.liveContainers = [
      { ...container("c-1", "a"), labels: {} },
      { ...container("c-2", "b"), labels: {} },
      { ...container("c-3", "c"), labels: {} },
    ];

    await runUsageSampleSweep();

    expect(h.serverPeak).toBe(1);
    expect(h.serverOrder).toHaveLength(3);
  });
});

describe("budget", () => {
  it("caps a huge box and REPORTS the overflow rather than dropping it silently", async () => {
    const many = Array.from({ length: 130 }, (_, i) => `c-${i}`);
    many.forEach((id, i) => project(`p${i}`, "s1", id));
    h.liveContainers = many.map((id, i) => ({ ...container(id, `s${i}`), labels: {} }));

    const r = await runUsageSampleSweep();

    expect(r.samples).toBe(120);
    // Silently truncating would read as "those containers were idle".
    expect(r.skipped).toBe(10);
  });
});

describe("failure handling", () => {
  it("counts an unreachable server and keeps going", async () => {
    project("p1", "s1", "c-1");
    project("p2", "s2", "c-2");
    h.failingServers.add("s1");
    h.liveContainers = [
      { ...container("c-1", "a"), labels: {} },
      { ...container("c-2", "b"), labels: {} },
    ];

    const r = await runUsageSampleSweep();

    expect(r.unreachable).toBe(1);
    // s2 was still swept — one dead box must not end the sweep.
    expect(h.inserted.length).toBeGreaterThan(0);
  });

  it("survives a container that vanished between listing and stats", async () => {
    project("p1", "s1", "c-1");
    project("p2", "s1", "c-2");
    h.liveContainers = [
      { ...container("c-1", "a"), labels: {} },
      { ...container("c-2", "b"), labels: {} },
    ];
    h.getUsage.mockImplementation(async (id: string) => {
      if (id === "c-1") throw new Error("no such container");
      return usage(3, 30);
    });

    const r = await runUsageSampleSweep();

    expect(r.samples).toBe(1);
    expect(h.inserted[0]).toMatchObject({ projectId: "p2" });
  });

  it("says nothing when the runtime cannot measure usage at all", async () => {
    project("p1", "s1", "c-1");
    h.caps = new Set(["hostContainerQuery"]); // no "usage"
    h.liveContainers = [{ ...container("c-1", "a"), labels: {} }];

    const r = await runUsageSampleSweep();

    expect(r.samples).toBe(0);
    expect(h.getUsage).not.toHaveBeenCalled();
  });

  it("still samples cloud projects, which have no host to enumerate", async () => {
    // The whole reason this isn't part of the health watch: gating on
    // hostContainerQuery would exclude Oblien entirely.
    project("p1", null, null);
    h.caps = new Set(["usage"]); // CloudRuntime: getUsage yes, docker ps no
    h.servicesByProject.set("p1", [{ id: "sv-web", name: "web" }]);
    h.serviceDeployments = [{ serviceId: "sv-web", containerId: "ws-123" }];

    const r = await runUsageSampleSweep();

    expect(h.getUsage).toHaveBeenCalledWith("ws-123");
    expect(r.samples).toBe(1);
  });

  it("always disposes the runtime — it holds an SSH bridge", async () => {
    project("p1", "s1", "c-1");
    h.liveContainers = [{ ...container("c-1", "a"), labels: {} }];
    await runUsageSampleSweep();
    expect(h.dispose).toHaveBeenCalled();
  });

  it("writes ONE batch for the whole sweep, not one insert per container", async () => {
    project("p1", "s1", "c-1");
    project("p2", "s2", "c-2");
    h.liveContainers = [
      { ...container("c-1", "a"), labels: {} },
      { ...container("c-2", "b"), labels: {} },
    ];
    await runUsageSampleSweep();

    // One statement for the sweep, not one per container: on a busy estate that is
    // the difference between one insert and hundreds.
    expect(h.insertCalls).toBe(1);
    expect(h.inserted).toHaveLength(2);
  });

  it("is a no-op with no projects", async () => {
    await expect(runUsageSampleSweep()).resolves.toMatchObject({ samples: 0, servers: 0 });
  });
});
