import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks (top-level handles) ────────────────────────────────────────────────

const authorize = vi.fn(async () => {});

vi.mock("./authorization", () => ({
  authorization: { authorize },
}));

const state = {
  settings: { enabled: true, workspaceId: null, sweepIntervalSeconds: 60, lastScanAt: null, lastScanError: null },
  bindings: new Map<string, Record<string, unknown>>(),
  forgotten: [] as string[],
  configured: [] as Array<{ enabled: boolean }>,
  withdrawalsScheduled: 0,
};

const discoveryRepo = {
  getSettings: vi.fn(async () => state.settings),
  configure: vi.fn(async (_serverId: string, patch: { enabled: boolean }) => {
    state.configured.push(patch);
    state.settings = { ...state.settings, enabled: patch.enabled };
    return { serverId: "srv_1", ...state.settings };
  }),
  disableAndScheduleWithdrawals: vi.fn(async (_serverId: string) => {
    state.settings = { ...state.settings, enabled: false };
    return [];
  }),
  getBinding: vi.fn(async (_serverId: string, serviceKey: string) => state.bindings.get(serviceKey)),
  listByServer: vi.fn(async () => [...state.bindings.values()]),
  findDomainForBinding: vi.fn(async (_serverId: string, hostname: string) =>
    hostname === "app.example.com"
      ? { hostname, verified: true, sslStatus: "issued", sslExpiresAt: new Date("2030-01-01"), sslIssuer: "letsencrypt" }
      : null,
  ),
  suppress: vi.fn(async (_serverId: string, serviceKey: string) => state.bindings.get(serviceKey)),
  unsuppress: vi.fn(async (_serverId: string, serviceKey: string) => state.bindings.get(serviceKey)),
  forget: vi.fn(async (_serverId: string, serviceKey: string) => {
    state.forgotten.push(serviceKey);
    state.bindings.delete(serviceKey);
  }),
  scheduleWithdrawalForAll: vi.fn(async () => {
    state.withdrawalsScheduled += 1;
    return [];
  }),
};

vi.mock("@repo/db", () => ({
  repos: { discovery: discoveryRepo },
}));

const sweep = vi.fn(async () => ({
  serverId: "srv_1",
  failed: [],
  scan: { scanned: 3, ok: true },
  reconcile: { withdrawals: [], applied: ["id:my-app"], removed: [], retained: [], failed: [], ok: true },
  repair: { scanned: 1, repaired: [], retained: [], requeued: [], failed: [] },
}));
const retire = vi.fn(async () => {});

const queueTasks: Array<() => Promise<unknown>> = [];
/** Set by queue-deferral tests: tasks queue without executing until flushed. */
let deferQueue = false;
const runQueuedTasksNow = async (): Promise<void> => {
  deferQueue = false;
  while (queueTasks.length > 0) await queueTasks.shift()!();
};
vi.mock("./engine/modules/discovery/discovery-sweep", () => ({
  sweepServerDiscovery: sweep,
  runInServerQueue: vi.fn((_serverId: string, task: () => Promise<unknown>) => {
    queueTasks.push(task);
    if (!deferQueue) return task();
    return Promise.resolve();
  }),
}));
vi.mock("./engine/modules/discovery/discovery-reconciler", () => ({ retireBindingRoute: retire }));

const { createDiscoveryOperations } = await import("./discovery");

const ctx = {
  organizationId: "org_1",
  userId: "usr_1",
} as unknown as import("./context").ExecutionContext;

function binding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "dsb_1",
    serviceKey: "id:my-app",
    hostname: "app.example.com",
    port: 3000,
    containerName: "my-app",
    observationStatus: "observed",
    containerRunning: true,
    applyState: "applied",
    applyAttempts: 0,
    desiredGeneration: 2,
    appliedGeneration: 2,
    suppressed: false,
    withdrawalPending: false,
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.settings = { enabled: true, workspaceId: null, sweepIntervalSeconds: 60, lastScanAt: null, lastScanError: null };
  state.bindings = new Map([["id:my-app", binding()]]);
  state.forgotten = [];
  state.configured = [];
  state.withdrawalsScheduled = 0;
  queueTasks.length = 0;
  deferQueue = false;
});

describe("createDiscoveryOperations", () => {
  it("authorizes SERVER access for every operation, at the right strength", async () => {
    const ops = createDiscoveryOperations({ authorize } as never);
    await ops.status(ctx, "srv_1");
    expect(authorize).toHaveBeenCalledWith(ctx, { resourceType: "server", resourceId: "srv_1", action: "read" });
    authorize.mockClear();
    await ops.configure(ctx, "srv_1", { enabled: false });
    expect(authorize).toHaveBeenCalledWith(ctx, { resourceType: "server", resourceId: "srv_1", action: "admin" });
    authorize.mockClear();
    await ops.rescan(ctx, "srv_1");
    expect(authorize).toHaveBeenCalledWith(ctx, { resourceType: "server", resourceId: "srv_1", action: "write" });
    authorize.mockClear();
    await ops.forget(ctx, "srv_1", { serviceKey: "id:my-app" });
    expect(authorize).toHaveBeenCalledWith(ctx, { resourceType: "server", resourceId: "srv_1", action: "admin" });
  });

  it("status joins each binding with its server-scoped TLS state", async () => {
    const ops = createDiscoveryOperations({ authorize } as never);
    const { data } = await ops.status(ctx, "srv_1");
    expect(data.settings.enabled).toBe(true);
    expect(data.services).toHaveLength(1);
    expect(data.services[0]).toMatchObject({
      serviceKey: "id:my-app",
      hostname: "app.example.com",
      applyState: "applied",
      tls: { verified: true, sslStatus: "issued", sslIssuer: "letsencrypt" },
    });
  });

  it("disable commits settings + withdrawal scheduling ATOMICALLY (one repo call)", async () => {
    const ops = createDiscoveryOperations({ authorize } as never);
    const { data } = await ops.configure(ctx, "srv_1", { enabled: false });
    // The atomic repo method is the ONLY writer: separate configure(false) +
    // scheduling calls could interleave with a crash, leaving live routes on a
    // server no sweep would select.
    expect(discoveryRepo.disableAndScheduleWithdrawals).toHaveBeenCalledWith("srv_1");
    expect(discoveryRepo.configure).not.toHaveBeenCalled();
    expect(data.settings.enabled).toBe(false);
    expect(queueTasks).toHaveLength(1); // the whole disable entered the server queue
  });

  it("enable keeps using the plain configure path", async () => {
    const ops = createDiscoveryOperations({ authorize } as never);
    await ops.configure(ctx, "srv_1", { enabled: true });
    expect(discoveryRepo.configure).toHaveBeenCalledWith("srv_1", { enabled: true });
    expect(discoveryRepo.disableAndScheduleWithdrawals).not.toHaveBeenCalled();
  });

  it("rescan enters the serialized server queue with FRESH inventory and validates its output", async () => {
    const ops = createDiscoveryOperations({ authorize } as never);
    const { data } = await ops.rescan(ctx, "srv_1");
    expect(sweep).toHaveBeenCalledWith("srv_1", "org_1", { fresh: true });
    expect(data).toMatchObject({
      serverId: "srv_1",
      failed: [],
      scan: { scanned: 3, ok: true },
      reconcile: { applied: ["id:my-app"], ok: true },
    });
  });

  it("forget retires the route BEFORE deleting the binding, INSIDE the server sweep queue", async () => {
    const ops = createDiscoveryOperations({ authorize } as never);
    const { data } = await ops.forget(ctx, "srv_1", { serviceKey: "id:my-app" });
    expect(data.forgotten).toBe(true);
    expect(retire).toHaveBeenCalledWith("srv_1", "org_1", expect.objectContaining({ hostname: "app.example.com" }));
    expect(discoveryRepo.forget).toHaveBeenCalledWith("srv_1", "id:my-app");
    // Order matters: a failed removal must leave the binding intact.
    const retireOrder = retire.mock.invocationCallOrder[0];
    const forgetOrder = discoveryRepo.forget.mock.invocationCallOrder[0];
    expect(retireOrder).toBeLessThan(forgetOrder);
    // P1: the WHOLE retire+delete sequence runs inside the serialized server
    // queue — an in-flight reconcile must not recreate the route between the
    // two steps. (The inline mock executed the task once; the recorded entry
    // must never be re-run — the binding is already deleted.)
    expect(queueTasks).toHaveLength(1);
  });

  it("a forget whose route removal fails leaves NO queue residue and deletes nothing", async () => {
    retire.mockRejectedValueOnce(new Error("edge down"));
    const ops = createDiscoveryOperations({ authorize } as never);
    await expect(ops.forget(ctx, "srv_1", { serviceKey: "id:my-app" })).rejects.toThrow("edge down");
    expect(state.bindings.has("id:my-app")).toBe(true);
    expect(queueTasks).toHaveLength(1); // the failed task entered and drained from the queue
  });

  it("forget reads the binding INSIDE the queue: a queued scan may have changed the hostname first", async () => {
    const ops = createDiscoveryOperations({ authorize } as never);
    deferQueue = true; // the forget task queues behind a not-yet-run scan
    const pending = ops.forget(ctx, "srv_1", { serviceKey: "id:my-app" });
    await vi.waitFor(() => expect(queueTasks.length).toBe(1)); // the op reached the queue
    // The queued scan REPLACES the container: same serviceKey, new hostname.
    state.bindings.set("id:my-app", binding({ hostname: "renamed.example.com" }));
    await runQueuedTasksNow(); // scan already consumed its slot; the forget task now runs
    await pending;
    // The retirement targeted the CURRENT (post-scan) hostname, not a stale one.
    expect(retire).toHaveBeenCalledWith(
      "srv_1",
      "org_1",
      expect.objectContaining({ hostname: "renamed.example.com" }),
    );
    expect(discoveryRepo.forget).toHaveBeenCalledWith("srv_1", "id:my-app");
  });

  it("disable runs INSIDE the server queue too (cannot race a first route write)", async () => {
    const ops = createDiscoveryOperations({ authorize } as never);
    deferQueue = true;
    const pending = ops.configure(ctx, "srv_1", { enabled: false }); // queued behind passes
    expect(discoveryRepo.disableAndScheduleWithdrawals).not.toHaveBeenCalled(); // waits for the queue
    await runQueuedTasksNow();
    await pending;
    expect(discoveryRepo.disableAndScheduleWithdrawals).toHaveBeenCalledWith("srv_1");
    expect(state.settings.enabled).toBe(false);
  });

  it("suppress/unsuppress return the updated service with its TLS state", async () => {
    const ops = createDiscoveryOperations({ authorize } as never);
    const { data } = await ops.suppress(ctx, "srv_1", { serviceKey: "id:my-app" });
    expect(discoveryRepo.suppress).toHaveBeenCalledWith("srv_1", "id:my-app");
    expect(data).toMatchObject({ serviceKey: "id:my-app", tls: { verified: true } });
    const again = await ops.unsuppress(ctx, "srv_1", { serviceKey: "id:my-app" });
    expect(again.data).toMatchObject({ serviceKey: "id:my-app" });
  });

  it("rejects unknown services with NotFound", async () => {
    const ops = createDiscoveryOperations({ authorize } as never);
    await expect(ops.forget(ctx, "srv_1", { serviceKey: "id:ghost" })).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
