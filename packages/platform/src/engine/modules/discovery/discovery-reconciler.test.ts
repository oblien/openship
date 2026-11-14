import { beforeEach, describe, expect, it, vi } from "vitest";
import { repos } from "@repo/db";
import { discoveryConfigHash } from "@repo/core";

// ── In-memory discovery repo (same contract as the scanner tests) ───────────

const state = {
  settings: { enabled: false } as { enabled: boolean } | null,
  dueApply: [] as Array<Record<string, unknown>>,
  dueWithdrawal: [] as Array<Record<string, unknown>>,
  applied: [] as Array<{ serviceKey: string; generation: number }>,
  withdrawn: [] as string[],
  applyErrors: [] as Array<{ serviceKey: string; error: string; retryAt: Date; generation?: number }>,
};

function reset() {
  state.settings = { enabled: true };
  state.dueApply = [];
  state.dueWithdrawal = [];
  state.applied = [];
  state.withdrawn = [];
  state.applyErrors = [];
}

const discoveryRepo = {
  getSettings: vi.fn(async () => state.settings),
  dueForApply: vi.fn(async () => state.dueApply),
  dueForWithdrawal: vi.fn(async () => state.dueWithdrawal),
  getBinding: vi.fn(async (_serverId: string, key: string) => state.dueApply.find((b) => b.serviceKey === key)),
  resolveUpstream: vi.fn(async (expected: Record<string, unknown>, target: Record<string, unknown>) => {
    const index = state.dueApply.findIndex((b) => b.id === expected.id);
    const row = state.dueApply[index];
    if (!row || row.desiredGeneration !== expected.desiredGeneration) return undefined;
    const changed = Object.keys(target).some((key) => row[key] !== target[key]);
    const resolved = { ...row, ...target, desiredGeneration: Number(row.desiredGeneration) + (changed ? 1 : 0) };
    state.dueApply[index] = resolved;
    return resolved;
  }),
  markApplied: vi.fn(async (_serverId: string, serviceKey: string, generation: number) => {
    state.applied.push({ serviceKey, generation });
    return { serviceKey };
  }),
  markWithdrawn: vi.fn(async (_serverId: string, serviceKey: string) => {
    state.withdrawn.push(serviceKey);
    return { serviceKey };
  }),
  markApplyError: vi.fn(
    async (_serverId: string, serviceKey: string, error: string, retryAt: Date, generation?: number) => {
      state.applyErrors.push({ serviceKey, error, retryAt, generation });
      return { serviceKey };
    },
  ),
  recordScan: vi.fn(async () => {}),
};

const domainRepo = {
  ensureServerDomain: vi.fn(async () => ({ domain: { id: "dom_x" }, created: true })),
};

vi.mock("@repo/db", () => ({
  repos: {
    discovery: discoveryRepo,
    domain: domainRepo,
  },
}));

vi.mock("../../lib/domain-ssl", () => ({
  manageDomainSsl: vi.fn(async () => ({ verified: true, expiresAt: "2027-01-01T00:00:00Z" })),
}));

import { manageDomainSsl } from "../../lib/domain-ssl";

// The injected edge target bypasses server resolution entirely; keep the
// real module (and its env bootstrapping) out of the test.
vi.mock("../../lib/deployment-runtime", () => ({
  resolveServerExecutor: vi.fn(async () => {
    throw new Error("reconciler must use the injected edge in tests");
  }),
  createPlatformForResolvedServer: vi.fn(),
  resolveServerHostPortTarget: vi.fn(),
  disposePlatform: vi.fn(),
}));

const { reconcileServerDiscovery, upstreamUrlFor } = await import("./discovery-reconciler");

// ── Mock edge ────────────────────────────────────────────────────────────────

function edge(): import("./discovery-reconciler").DiscoveryEdgeTarget {
  return {
    routing: {
      registerRoute: vi.fn(async () => {}),
      removeRoute: vi.fn(async () => {}),
      probeUpstream: vi.fn(async () => ({ ok: true })),
    },
    hostPortTarget: { targetKey: "server:test", machineId: "m", hostId: "h" },
    runtime: {
      supports: () => true,
      getDiscoveryContainerView: vi.fn(async (id: string) => {
        const row = state.dueApply.find((b) => b.containerId === id);
        if (!row) return null;
        return liveView(row);
      }),
      listAllNetworks: vi.fn(async () => [{ id: "net_fe", name: "frontend", driver: "bridge" }]),
    },
    edgeProxy: { listLoopbackUpstreamPortsStrict: async () => [] },
    dispose: vi.fn(async () => {}),
  } as unknown as import("./discovery-reconciler").DiscoveryEdgeTarget;
}

function liveView(row: Record<string, unknown>) {
  return {
    containerId: String(row.containerId), running: true, status: "running", labels: {},
    env: ["OPENSHIP_DISCOVERY=true", "OPENSHIP_SERVICE_ID=my-app",
      `OPENSHIP_DOMAIN=${row.hostname}`, `OPENSHIP_PORT=${row.port}`],
    networks: [{ name: "frontend", id: "net_fe", ipAddress: "172.20.0.5" }],
    publishedPorts: row.hostPort
      ? [{ containerPort: 3000, hostPort: Number(row.hostPort), hostIp: row.hostIp as string | null }]
      : [],
  };
}

function binding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "dsb_1",
    serviceKey: "id:my-app",
    hostname: "app.example.com",
    networkName: "frontend",
    networkId: "net_fe",
    configHash: discoveryConfigHash({ hostname: "app.example.com", port: 3000, network: "frontend" }),
    port: 3000,
    containerId: "ctr_1",
    observationStatus: "observed",
    applyState: "pending",
    applyAttempts: 0,
    desiredGeneration: 1,
    appliedGeneration: 0,
    suppressed: false,
    withdrawalPending: false,
    containerRunning: true,
    upstreamStrategy: "network-ip",
    ipAddress: "172.20.0.5",
    hostPort: null,
    hostIp: null,
    ...overrides,
  };
}

describe("upstreamUrlFor", () => {
  it("builds the direct bridge URL and never leaks a stale upstream when unrouteable", () => {
    expect(upstreamUrlFor(binding() as never)).toBe("http://172.20.0.5:3000");
    expect(upstreamUrlFor(binding({ upstreamStrategy: "published-port", hostPort: 18080, ipAddress: null }) as never)).toBe(
      "http://127.0.0.1:18080",
    );
    expect(upstreamUrlFor(binding({ observationStatus: "missing" }) as never)).toBeNull();
    expect(upstreamUrlFor(binding({ observationStatus: "invalid" }) as never)).toBeNull();
    expect(upstreamUrlFor(binding({ containerRunning: false }) as never)).toBeNull();
    expect(upstreamUrlFor(binding({ ipAddress: null }) as never)).toBeNull();
    expect(upstreamUrlFor(binding({ upstreamStrategy: "published-port", hostPort: null }) as never)).toBeNull();
  });
});

describe("reconcileServerDiscovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reset();
  });

  it("a disabled server with NOTHING queued has no work (applies stay gated)", async () => {
    state.settings = { enabled: false };
    const summary = await reconcileServerDiscovery(SERVER(), "org_1", { edge: edge() });
    expect(summary.ok).toBe(true); // withdrawals ran (none due); applies stayed gated
    expect(summary.applied).toEqual([]);
  });

  it("registers a bridge-ip binding and marks it applied only after the edge write", async () => {
    state.dueApply = [binding()];
    const target = edge();
    const summary = await reconcileServerDiscovery(SERVER(), "org_1", { edge: target });
    expect(target.routing.registerRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: "app.example.com",
        targetUrl: "http://172.20.0.5:3000",
        tls: true,
        terminatesTlsLocally: true,
      }),
    );
    expect(summary.applied).toEqual(["id:my-app"]);
    expect(state.applied).toEqual([{ serviceKey: "id:my-app", generation: 1 }]);
    // Immediate certificate reconciliation for the freshly applied upstream.
    expect(manageDomainSsl).toHaveBeenCalledWith(
      "app.example.com",
      expect.objectContaining({ action: "provision", allowUnverified: true, serverId: SERVER() }),
    );
  });

  it("RETAINS a previously-applied hostname as an unavailable vhost when its backend disappears", async () => {
    // Applied route + container gone: replace the live proxy with 503 + TLS +
    // ACME (existing certificate material) instead of dropping the vhost —
    // the certificate lifecycle continues, clients see "backend unavailable".
    state.dueApply = [
      binding({ applyState: "applied", appliedGeneration: 2, observationStatus: "missing", containerId: null, ipAddress: null, containerRunning: false }),
    ];
    const target = edge();
    const summary = await reconcileServerDiscovery(SERVER(), "org_1", { edge: target });
    expect(target.routing.registerRoute).toHaveBeenCalledWith({
      domain: "app.example.com",
      tls: true,
      terminatesTlsLocally: true,
      unavailable: true,
    });
    expect(target.routing.removeRoute).not.toHaveBeenCalled();
    // The server-scoped domain row backs the TLS lifecycle for the retained vhost.
    expect(domainRepo.ensureServerDomain).toHaveBeenCalledWith({
      serverId: SERVER(),
      hostname: "app.example.com",
      targetPort: 3000,
    });
    expect(summary.retained).toEqual(["id:my-app"]);
    expect(summary.removed).toEqual([]);
    expect(state.applied).toEqual([{ serviceKey: "id:my-app", generation: 1 }]);
    // Retention never orders a certificate: the backend gate would defer.
    expect(manageDomainSsl).not.toHaveBeenCalled();
    // The upstream is gone — the owner's published-port claims still release.
    expect(convergeTargetHostPortClaimsUnlocked).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "discovery:dsb_1", desiredPublishes: [] }),
    );
  });

  it("removes the route outright for a missing binding that was NEVER applied", async () => {
    // No durable history (appliedGeneration 0) = no vhost ever existed to
    // retain; retention would create one for a service that never served.
    state.dueApply = [
      binding({ applyState: "pending", appliedGeneration: 0, observationStatus: "missing", containerId: null, ipAddress: null, containerRunning: false }),
    ];
    const target = edge();
    const summary = await reconcileServerDiscovery(SERVER(), "org_1", { edge: target });
    expect(target.routing.removeRoute).toHaveBeenCalledWith("app.example.com");
    expect(target.routing.registerRoute).not.toHaveBeenCalled();
    expect(summary.removed).toEqual(["id:my-app"]);
    expect(state.applied).toEqual([{ serviceKey: "id:my-app", generation: 1 }]);
    // No certificate order for a withdrawn upstream.
    expect(manageDomainSsl).not.toHaveBeenCalled();
  });

  it("RETAINS a stop-requeued binding: a normal stop flips applied bindings to applyState pending, but durable history decides", async () => {
    // The real observe flow: a stopped container is observed with running=false,
    // which requeues the binding (applyState "pending", generation bumped) while
    // appliedGeneration keeps its record. The apply STATE must not decide
    // retention — the durable history does.
    state.dueApply = [
      binding({ applyState: "pending", appliedGeneration: 2, containerRunning: false }),
    ];
    const target = edge();
    const summary = await reconcileServerDiscovery(SERVER(), "org_1", { edge: target });
    expect(target.routing.registerRoute).toHaveBeenCalledWith(
      expect.objectContaining({ domain: "app.example.com", unavailable: true }),
    );
    expect(target.routing.removeRoute).not.toHaveBeenCalled();
    expect(summary.retained).toEqual(["id:my-app"]);
    expect(summary.removed).toEqual([]);
  });

  it("retains through the WITHDRAWAL loop too: markMissing flags a previously-applied binding for retirement, and it keeps its hostname", async () => {
    // The real markMissing flow: invalidateObservation sets withdrawalPending on
    // any binding with applied-route evidence (appliedGeneration > 0) AND
    // requeues it as pending — the withdrawal loop consumes the flag first.
    state.dueWithdrawal = [
      binding({ applyState: "pending", appliedGeneration: 2, withdrawalPending: true }),
    ];
    const target = edge();
    const summary = await reconcileServerDiscovery(SERVER(), "org_1", { edge: target });
    expect(target.routing.registerRoute).toHaveBeenCalledWith(
      expect.objectContaining({ domain: "app.example.com", unavailable: true }),
    );
    expect(target.routing.removeRoute).not.toHaveBeenCalled();
    expect(summary.retained).toEqual(["id:my-app"]);
    expect(state.withdrawn).toEqual(["id:my-app"]); // the flag clears either way
    // Retention still releases the owner's published-port claims.
    expect(convergeTargetHostPortClaimsUnlocked).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "discovery:dsb_1", desiredPublishes: [] }),
    );
  });

  it("a SUPPRESSED binding with history still retires outright through the withdrawal loop", async () => {
    // Explicit control (operator opt-out) is never retention, regardless of history.
    state.dueWithdrawal = [
      binding({ applyState: "pending", appliedGeneration: 2, withdrawalPending: true, suppressed: true }),
    ];
    const target = edge();
    const summary = await reconcileServerDiscovery(SERVER(), "org_1", { edge: target });
    expect(target.routing.removeRoute).toHaveBeenCalledWith("app.example.com");
    expect(target.routing.registerRoute).not.toHaveBeenCalled();
    expect(summary.withdrawals).toEqual(["id:my-app"]);
  });

  it("retains an error-state binding's hostname too (a vhost may exist from the failed apply)", async () => {
    state.dueApply = [
      binding({ applyState: "error", appliedGeneration: 2, observationStatus: "observed", containerRunning: false }),
    ];
    const target = edge();
    const summary = await reconcileServerDiscovery(SERVER(), "org_1", { edge: target });
    expect(target.routing.registerRoute).toHaveBeenCalledWith(
      expect.objectContaining({ domain: "app.example.com", unavailable: true }),
    );
    expect(summary.retained).toEqual(["id:my-app"]);
  });

  it("a DISABLED server still retires scheduled routes — outright, never 503-retained", async () => {
    // Disable schedules retirement for every applied binding; the withdrawal
    // stage is the one stage that runs for disabled servers, and with
    // discovery off no vhost is retained at all.
    state.settings = { enabled: false };
    state.dueWithdrawal = [binding({ applyState: "pending", appliedGeneration: 2, withdrawalPending: true })];
    const target = edge();
    const summary = await reconcileServerDiscovery(SERVER(), "org_1", { edge: target });
    expect(target.routing.removeRoute).toHaveBeenCalledWith("app.example.com");
    expect(target.routing.registerRoute).not.toHaveBeenCalled(); // no retention write
    expect(summary.withdrawals).toEqual(["id:my-app"]);
    expect(summary.retained).toEqual([]);
    // The applies loop never ran.
    expect(state.applied).toEqual([]);
  });

  it("processes withdrawals first and clears the retirement flag", async () => {
    state.dueWithdrawal = [binding({ applyState: "blocked", withdrawalPending: true })];
    const target = edge();
    const summary = await reconcileServerDiscovery(SERVER(), "org_1", { edge: target });
    expect(target.routing.removeRoute).toHaveBeenCalledWith("app.example.com");
    expect(summary.withdrawals).toEqual(["id:my-app"]);
    expect(state.withdrawn).toEqual(["id:my-app"]);
    // The withdrawal releases this owner's published-port claims so the port
    // becomes legitimately reusable.
    expect(convergeTargetHostPortClaimsUnlocked).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "discovery:dsb_1", desiredPublishes: [] }),
    );
  });

  it("routes published-port bindings through the loopback ownership guard", async () => {
    state.dueApply = [
      binding({
        upstreamStrategy: "published-port",
        hostPort: 18080,
        hostIp: "127.0.0.1",
        ipAddress: null,
      }),
    ];
    const target = edge();
    const summary = await reconcileServerDiscovery(SERVER(), "org_1", { edge: target });
    expect(target.routing.registerRoute).toHaveBeenCalledWith(
      expect.objectContaining({ targetUrl: "http://127.0.0.1:18080", domain: "app.example.com" }),
    );
    expect(summary.applied).toEqual(["id:my-app"]);
    // The ownership guard ran under the target lock with the binding's claim.
    expect(reserveObservedLoopbackPublishes).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "discovery:dsb_1",
        publishes: [
          { serviceId: "id:my-app", containerId: "ctr_1", containerPort: 3000, hostPort: 18080 },
        ],
      }),
    );
    expect(prepareTargetPinnedHostPorts).toHaveBeenCalledWith(
      expect.objectContaining({ target: expect.objectContaining({ targetKey: "server:test" }) }),
    );
    // The published-port path converges claims to its OBSERVED publish (not empty).
    expect(convergeTargetHostPortClaimsUnlocked).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "discovery:dsb_1",
        desiredPublishes: [
          { serviceId: "id:my-app", containerId: "ctr_1", containerPort: 3000, hostPort: 18080 },
        ],
      }),
    );
  });

  it("persists apply errors with backoff instead of losing the binding", async () => {
    state.dueApply = [binding()];
    const target = edge();
    vi.mocked(target.routing.registerRoute).mockRejectedValue(new Error("edge write failed"));
    const summary = await reconcileServerDiscovery(SERVER(), "org_1", { edge: target });
    expect(summary.failed).toHaveLength(1);
    expect(summary.failed[0].reason).toContain("edge write failed");
    expect(state.applyErrors).toHaveLength(1);
    expect(state.applyErrors[0].error).toContain("edge write failed");
    expect(state.applyErrors[0].retryAt.getTime()).toBeGreaterThan(Date.now());
    // GENERATION-CONDITIONAL: the failure names the generation it attempted.
    expect(state.applyErrors[0].generation).toBe(1);
    expect(state.applied).toEqual([]);
  });

  it("a stale failed attempt does not overwrite a newer pending generation", async () => {
    // The reconciler passes the generation it attempted; the repo's real
    // generation-conditional WHERE is covered in the db tests — here we pin
    // the reconciler's contract: it reports failure per attempt, and a
    // stale markApplied is reported as skipped, never as applied.
    state.dueApply = [binding({ desiredGeneration: 2 })];
    const target = edge();
    vi.mocked(discoveryRepo.markApplied).mockResolvedValueOnce(undefined as never);
    const summary = await reconcileServerDiscovery(SERVER(), "org_1", { edge: target });
    expect(target.routing.registerRoute).toHaveBeenCalled();
    expect(summary.applied).toEqual([]); // NOT reported as success
    expect(summary.skipped).toBe(1);
    expect(state.applied).toEqual([]);
  });

  it("releasing claims: bridge-ip registration and withdrawal converge to an empty publish set", async () => {
    // Bridge-ip register: a previous published-port generation's claim must be
    // released when the route no longer dials a host port.
    state.dueApply = [binding()];
    const target = edge();
    await reconcileServerDiscovery(SERVER(), "org_1", { edge: target });
    expect(convergeTargetHostPortClaimsUnlocked).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "discovery:dsb_1", desiredPublishes: [] }),
    );
  });

  it("falls back from an unreachable rootless bridge to the live published port", async () => {
    state.dueApply = [binding()];
    const target = edge();
    const view = { ...liveView(state.dueApply[0]),
      publishedPorts: [{ containerPort: 3000, hostPort: 18080, hostIp: "127.0.0.1" }] };
    vi.mocked(target.runtime!.getDiscoveryContainerView!).mockResolvedValue(view);
    vi.mocked(target.routing.probeUpstream!).mockImplementation(async (host) =>
      host === "127.0.0.1" ? { ok: true } : { ok: false, reason: "no_route" });
    const summary = await reconcileServerDiscovery(SERVER(), "org_1", { edge: target });
    expect(summary.failed).toEqual([]);
    expect(target.routing.probeUpstream).toHaveBeenNthCalledWith(1, "172.20.0.5", 3000);
    expect(target.routing.probeUpstream).toHaveBeenNthCalledWith(2, "127.0.0.1", 18080);
    expect(target.routing.registerRoute).toHaveBeenCalledWith(expect.objectContaining({ targetUrl: "http://127.0.0.1:18080" }));
    expect(state.applied).toEqual([{ serviceKey: "id:my-app", generation: 2 }]);
    expect(state.dueApply[0].upstreamStrategy).toBe("published-port");
  });

  it("writes no route or certificate when Edge cannot reach any candidate", async () => {
    state.dueApply = [binding()];
    const target = edge();
    vi.mocked(target.routing.probeUpstream!).mockResolvedValue({ ok: false, reason: "timeout" });
    const summary = await reconcileServerDiscovery(SERVER(), "org_1", { edge: target });
    expect(summary.failed[0].reason).toContain("No upstream reachable from Openship Edge");
    expect(target.routing.registerRoute).not.toHaveBeenCalled();
    expect(manageDomainSsl).not.toHaveBeenCalled();
    expect(state.applied).toEqual([]);
  });

  it("refuses an upstream that disappeared after its successful probe", async () => {
    state.dueApply = [binding()];
    const target = edge();
    vi.mocked(target.runtime!.getDiscoveryContainerView!)
      .mockResolvedValueOnce(liveView(state.dueApply[0]))
      .mockResolvedValueOnce(null);
    const summary = await reconcileServerDiscovery(SERVER(), "org_1", { edge: target });
    expect(summary.failed[0].reason).toContain("no longer running");
    expect(target.routing.registerRoute).not.toHaveBeenCalled();
  });

  it("never falls back to probing from the control plane when Edge lacks a probe", async () => {
    state.dueApply = [binding()];
    const target = edge();
    delete target.routing.probeUpstream;
    const summary = await reconcileServerDiscovery(SERVER(), "org_1", { edge: target });
    expect(summary.failed[0].reason).toContain("serving Edge cannot probe");
    expect(target.routing.registerRoute).not.toHaveBeenCalled();
  });
});

import {
  convergeTargetHostPortClaimsUnlocked,
  prepareTargetPinnedHostPorts,
  withHostPortTargetLock,
} from "../deployments/pinned-host-ports";
import { reserveObservedLoopbackPublishes } from "../deployments/observed-host-port-claims";
vi.mock("../deployments/pinned-host-ports", () => ({
  withHostPortTargetLock: vi.fn((_target: unknown, fn: () => Promise<void>) => fn()),
  prepareTargetPinnedHostPorts: vi.fn(async () => {}),
  convergeTargetHostPortClaimsUnlocked: vi.fn(async () => ({})),
}));
vi.mock("../deployments/observed-host-port-claims", () => ({
  reserveObservedLoopbackPublishes: vi.fn(async () => {}),
  loopbackHostPortFromUrl: vi.fn(() => null),
}));

function SERVER() {
  return "srv_reconcile";
}
