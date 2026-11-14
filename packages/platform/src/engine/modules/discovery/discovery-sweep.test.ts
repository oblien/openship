import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks (top-level handles; the mocked-module binding is never touched) ────

const state = {
  enabled: [] as Array<{ serverId: string }>,
  settingsByServer: {} as Record<string, { enabled: boolean; sweepIntervalSeconds: number; lastScanAt: Date | null } | null>,
  servers: {} as Record<string, { organizationId: string | null } | undefined>,
};

const discoveryRepo = {
  getSettings: vi.fn(async (serverId: string) => state.settingsByServer[serverId] ?? null),
  listSweepableServerIds: vi.fn(async () => state.enabled),
};

const serverRepo = {
  get: vi.fn(async (serverId: string) => state.servers[serverId]),
};

vi.mock("@repo/db", () => ({
  repos: { discovery: discoveryRepo, server: serverRepo },
}));

const scan = vi.fn(async (serverId: string) => ({
  scanned: 1,
  eligible: 1,
  observed: [],
  desiredChanged: [],
  invalid: [],
  missing: [],
  withdrawn: [],
  blocked: [],
  errors: [],
  ok: true,
}));
const reconcile = vi.fn(async (): Promise<Record<string, unknown>> => ({
  withdrawals: [],
  applied: [],
  removed: [],
  retained: [],
  failed: [],
  skipped: 0,
  ok: true,
}));
const repair = vi.fn(async (): Promise<Record<string, unknown>> => ({
  scanned: 0,
  repaired: [],
  retained: [],
  requeued: [],
  failed: [],
}));
const renew = vi.fn(async () => {});

vi.mock("./discovery-scanner", () => ({ scanServerDiscovery: scan }));
vi.mock("./discovery-reconciler", () => ({ reconcileServerDiscovery: reconcile }));
vi.mock("./discovery-repair", () => ({ repairDiscoveryRoutes: repair }));
vi.mock("./discovery-watch", () => ({ renewDiscoveryWatchers: renew }));
vi.mock("../../lib/system-jobs", () => ({
  scheduleSystemJob: vi.fn(async () => {}),
}));
vi.mock("../../lib/background-work", () => ({
  trackBackgroundWork: (p: Promise<unknown>) => p,
}));

const { sweepDiscovery, sweepServerDiscovery, startDiscoverySweep, runInServerQueue } = await import("./discovery-sweep");
const { scheduleSystemJob } = await import("../../lib/system-jobs");

function enable(serverId: string, organizationId: string | null, settings?: Partial<{ sweepIntervalSeconds: number; lastScanAt: Date | null }>) {
  state.enabled.push({ serverId });
  state.servers[serverId] = { organizationId };
  state.settingsByServer[serverId] = {
    enabled: true,
    sweepIntervalSeconds: 60,
    lastScanAt: null,
    ...settings,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.enabled = [];
  state.settingsByServer = {};
  state.servers = {};
});

describe("sweepServerDiscovery", () => {
  it("runs scan → reconcile → repair for one server", async () => {
    enable("srv_1", "org_1");
    const summary = await sweepServerDiscovery("srv_1", "org_1");
    expect(scan).toHaveBeenCalledWith("srv_1", "org_1");
    expect(reconcile).toHaveBeenCalledWith("srv_1", "org_1");
    expect(repair).toHaveBeenCalledWith("srv_1", "org_1");
    expect(summary.failed).toEqual([]);
  });

  it("isolates stage failures: a throwing scan still reconciles and repairs", async () => {
    enable("srv_1", "org_1");
    scan.mockRejectedValueOnce(new Error("docker down"));
    const summary = await sweepServerDiscovery("srv_1", "org_1");
    expect(summary.failed).toEqual(["scan"]);
    expect(reconcile).toHaveBeenCalledOnce();
    expect(repair).toHaveBeenCalledOnce();
  });

  it("reports a non-ok reconcile as failed without blocking repair", async () => {
    enable("srv_1", "org_1");
    reconcile.mockResolvedValueOnce({ withdrawals: [], applied: [], removed: [], retained: [], failed: [{ serviceKey: "s", reason: "x" }], skipped: 0, ok: false });
    const summary = await sweepServerDiscovery("srv_1", "org_1");
    expect(summary.failed).toEqual(["reconcile"]);
    expect(repair).toHaveBeenCalledOnce();
  });

  it("skips the scan while the per-server interval is fresh, but always reconciles and repairs", async () => {
    enable("srv_1", "org_1", { sweepIntervalSeconds: 300, lastScanAt: new Date(Date.now() - 10_000) });
    const summary = await sweepServerDiscovery("srv_1", "org_1");
    expect(scan).not.toHaveBeenCalled();
    expect(summary.scan).toBeUndefined();
    expect(reconcile).toHaveBeenCalledOnce();
    expect(repair).toHaveBeenCalledOnce();
    expect(summary.failed).toEqual([]);
  });

  it("scans when the last scan is older than the configured interval", async () => {
    enable("srv_1", "org_1", { sweepIntervalSeconds: 300, lastScanAt: new Date(Date.now() - 400_000) });
    await sweepServerDiscovery("srv_1", "org_1");
    expect(scan).toHaveBeenCalledOnce();
  });

  it("scans when there is no last scan at all (startup)", async () => {
    enable("srv_1", "org_1", { lastScanAt: null });
    await sweepServerDiscovery("srv_1", "org_1");
    expect(scan).toHaveBeenCalledOnce();
  });
});

describe("sweepDiscovery", () => {
  it("sweeps every enabled server and renews watcher leases with the enabled ids", async () => {
    enable("srv_1", "org_1");
    enable("srv_2", "org_2");
    const summary = await sweepDiscovery();
    expect(summary.servers).toBe(2);
    expect(summary.failed).toEqual([]);
    expect(scan).toHaveBeenCalledTimes(2);
    expect(renew).toHaveBeenCalledWith(["srv_1", "srv_2"]);
  });

  it("skips tenant-less servers and reports them", async () => {
    enable("srv_1", null);
    const summary = await sweepDiscovery();
    expect(summary.servers).toBe(1);
    expect(summary.failed).toEqual(["srv_1"]);
    expect(scan).not.toHaveBeenCalled();
    // The watcher renewal still runs — but a tenant-less server never arms a
    // watcher, so the enabled list is empty.
    expect(renew).toHaveBeenCalledWith([]);
  });

  it("keeps other servers sweeping when one throws", async () => {
    enable("srv_1", "org_1");
    enable("srv_2", "org_2");
    scan.mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    // Note: sweepServerDiscovery catches stage errors, so a throw here models a
    // crash OUTSIDE the stages (repo failure mid-loop).
    const summary = await sweepDiscovery();
    expect(summary.servers).toBe(2);
    expect(summary.details).toHaveLength(2);
    expect(scan).toHaveBeenCalledTimes(2); // srv_2 still scanned
    void summary;
  });

  it("survives listSweepableServerIds failing", async () => {
    discoveryRepo.listSweepableServerIds.mockRejectedValueOnce(new Error("db down"));
    const summary = await sweepDiscovery();
    expect(summary.servers).toBe(0);
    expect(summary.failed).toEqual([]);
    expect(renew).not.toHaveBeenCalled();
  });
});

describe("queue cleanup under rejection", () => {
  it("a failing settings read rejects the caller's promise WITHOUT an unhandled rejection from the cleanup chain", async () => {
    // The queue's cleanup used to ride a bare run.finally(...) whose returned
    // promise was discarded — a rejecting run (settings read fails before any
    // stage isolation) produced an unhandledRejection even though the caller
    // caught the run itself. The cleanup now observes both outcomes.
    enable("srv_1", "org_1");
    discoveryRepo.getSettings.mockRejectedValueOnce(new Error("db hiccough"));
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      await expect(sweepServerDiscovery("srv_1", "org_1")).rejects.toThrow("db hiccough");
      // Give any discarded-rejection microtask a chance to surface.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    // The queue entry is gone: the next sweep is not chained behind a dead tail.
    discoveryRepo.getSettings.mockRejectedValueOnce(new Error("db hiccough again"));
    await expect(sweepServerDiscovery("srv_1", "org_1")).rejects.toThrow("db hiccough again");
    expect(scan).not.toHaveBeenCalled(); // both failures happened before any stage ran
  });
});

describe("runInServerQueue (operator mutations serialize with sweeps)", () => {
  it("a mutation task waits for an in-flight sweep and vice versa", async () => {
    enable("srv_1", "org_1");
    let releaseScan: (() => void) | undefined;
    scan.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseScan = () =>
            resolve({ scanned: 1, eligible: 1, observed: [], desiredChanged: [], invalid: [], missing: [], withdrawn: [], blocked: [], errors: [], ok: true });
        }),
    );
    let sweepSettled = false;
    const sweepPass = sweepServerDiscovery("srv_1", "org_1", { fresh: true }).finally(() => {
      sweepSettled = true;
    });
    // A forget-style mutation enters the queue while the sweep holds it.
    const mutation = runInServerQueue("srv_1", async () => {
      // SERIALIZATION: the sweep's every stage completed before this task
      // started — an in-flight reconcile can never interleave with a route
      // deletion. (Measured via the stage mocks: the queue's internal run
      // settles a microtask before its async-wrapper promise, so wrapper
      // callbacks lag the real completion order.)
      expect(scan).toHaveBeenCalledTimes(1);
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(repair).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => expect(releaseScan).toBeDefined());
    expect(sweepSettled).toBe(false); // nothing finished yet
    releaseScan!();
    await Promise.all([sweepPass, mutation]);
    expect(sweepSettled).toBe(true);
  });

  it("a mutation task rejection cleans the queue entry without an unhandled rejection", async () => {
    enable("srv_1", "org_1");
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      await expect(runInServerQueue("srv_1", async () => { throw new Error("removal failed"); })).rejects.toThrow("removal failed");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toHaveLength(0);
      // The queue is usable again: the next task is not chained behind the dead one.
      const result = await runInServerQueue("srv_1", async () => "ok");
      expect(result).toBe("ok");
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("per-server serialization and fresh inventory", () => {
  it("serializes overlapping triggers for one server: the second pass waits for the first", async () => {
    enable("srv_1", "org_1");
    // Gate the FIRST call inside its scan so the second trigger overlaps.
    let releaseScan: (() => void) | undefined;
    scan.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseScan = () =>
            resolve({ scanned: 1, eligible: 1, observed: [], desiredChanged: [], invalid: [], missing: [], withdrawn: [], blocked: [], errors: [], ok: true });
        }),
    );
    const first = sweepServerDiscovery("srv_1", "org_1", { fresh: true });
    const second = sweepServerDiscovery("srv_1", "org_1"); // e.g. cron tick during the startup pass
    await vi.waitFor(() => expect(releaseScan).toBeDefined());
    // The second pass has not entered its scan while the first holds the queue.
    expect(scan).toHaveBeenCalledTimes(1);
    releaseScan!();
    await Promise.all([first, second]);
    expect(scan).toHaveBeenCalledTimes(2); // strictly after the first finished
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it("queues serialize per server but different servers sweep independently", async () => {
    enable("srv_1", "org_1");
    enable("srv_2", "org_2");
    let release: (() => void) | undefined;
    scan.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ scanned: 1, eligible: 1, observed: [], desiredChanged: [], invalid: [], missing: [], withdrawn: [], blocked: [], errors: [], ok: true });
        }),
    );
    const p1 = sweepServerDiscovery("srv_1", "org_1");
    const p2 = sweepServerDiscovery("srv_2", "org_2"); // different queue: runs now
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(scan).toHaveBeenCalledTimes(2); // srv_2 was NOT blocked by srv_1's queue
    release!();
    await Promise.all([p1, p2]);
  });

  it("event/reconnect passes request FRESH inventory — the interval gate cannot skip them", async () => {
    enable("srv_1", "org_1", { sweepIntervalSeconds: 3600, lastScanAt: new Date() }); // scan absurdly fresh
    const summary = await sweepServerDiscovery("srv_1", "org_1", { fresh: true });
    expect(scan).toHaveBeenCalledOnce(); // fresh bypasses the interval
    expect(summary.failed).toEqual([]);
  });

  it("the recurring poll keeps its interval gating (no fresh flag)", async () => {
    enable("srv_1", "org_1", { sweepIntervalSeconds: 3600, lastScanAt: new Date() });
    await sweepDiscovery(); // cron body
    expect(scan).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledOnce(); // reconcile/repair still run
    expect(repair).toHaveBeenCalledOnce();
  });

  it("the startup inventory forces fresh inventory on every enabled server", async () => {
    enable("srv_1", "org_1", { sweepIntervalSeconds: 3600, lastScanAt: new Date() });
    await startDiscoverySweep();
    await vi.waitFor(() => expect(scan).toHaveBeenCalledOnce()); // fresh despite the fresh lastScanAt
  });
});

describe("startDiscoverySweep", () => {
  it("registers the 60-second cron job and runs the startup inventory immediately", async () => {
    enable("srv_1", "org_1");
    await startDiscoverySweep();
    expect(scheduleSystemJob).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "discovery:sweep", cronExpression: "* * * * *" }),
    );
    // Startup inventory: the first sweep runs (fire-and-forget) without
    // waiting for a tick.
    await vi.waitFor(() => expect(scan).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(renew).toHaveBeenCalledWith(["srv_1"]));
  });

  it("the job body aggregates repair counters across servers", async () => {
    enable("srv_1", "org_1");
    enable("srv_2", "org_2");
    repair.mockResolvedValue({ scanned: 1, repaired: ["a.example.com"], retained: ["b.example.com"], requeued: ["c.example.com"], failed: [] });
    let jobRun: (() => Promise<Record<string, unknown>>) | undefined;
    vi.mocked(scheduleSystemJob).mockImplementationOnce(async (opts) => {
      jobRun = opts.run as () => Promise<Record<string, unknown>>;
    });
    await startDiscoverySweep();
    // Drain the startup sweep's ticks, then run the job body directly.
    await vi.waitFor(() => expect(jobRun).toBeDefined());
    const jobSummary = await jobRun!();
    expect(jobSummary).toMatchObject({ servers: 2, failed: 0, repaired: 2, retained: 2, requeued: 2 });
  });
});
