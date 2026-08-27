import { beforeEach, describe, expect, it, vi } from "vitest";
import { pickHostPort } from "@repo/adapters";
import {
  allocateAndReservePinnedHostPort,
  convergeTargetHostPortClaims,
  convergeTargetHostPortClaimsUnlocked,
  findOwnedPinnedHostPort,
  listTargetPinnedHostPorts,
  pinnedHostPortsToAvoid,
  prepareTargetPinnedHostPorts,
  releaseNewPinnedHostPortClaims,
  type PinnedHostPort,
} from "./pinned-host-ports";
import type { HostPortTargetIdentity } from "../../lib/host-port-target";

const claimRepo = vi.hoisted(() => ({
  reserve: vi.fn(),
  quarantine: vi.fn(),
  release: vi.fn(),
  releaseQuarantine: vi.fn(),
  list: vi.fn(),
}));

vi.mock("@repo/db", () => ({
  HOST_PORT_QUARANTINE_OWNER: "__host_port_quarantine__",
  HostPortClaimConflictError: class HostPortClaimConflictError extends Error {
    conflict: "port" | "owner";
    constructor(conflict: "port" | "owner") {
      super(conflict);
      this.conflict = conflict;
    }
  },
  repos: {
    hostPortClaim: {
      listHostPortClaims: claimRepo.list,
      reserveHostPortClaim: claimRepo.reserve,
      reserveQuarantinedHostPortClaim: claimRepo.quarantine,
      releaseHostPortClaim: claimRepo.release,
      releaseQuarantinedHostPortClaim: claimRepo.releaseQuarantine,
    },
  },
  withAdvisoryLock: async (_key: string, fn: () => Promise<unknown>) => fn(),
}));

const claims: PinnedHostPort[] = [
  { projectId: "single", serviceId: null, containerPort: null, port: 20001 },
  { projectId: "compose", serviceId: "api", containerPort: 3000, port: 20002 },
  { projectId: "compose", serviceId: "worker", containerPort: 4000, port: 20003 },
];

const localTarget: HostPortTargetIdentity = {
  targetKey: "local",
  legacyTargetKeys: [],
  stable: true,
};
const remoteTarget: HostPortTargetIdentity = {
  targetKey: `host:${"a".repeat(64)}`,
  legacyTargetKeys: ["server:srv-a"],
  stable: true,
};

const storedClaim = (id: string, targetKey: string, input: PinnedHostPort) => ({
  id,
  targetKey,
  ...input,
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

describe("pinnedHostPortsToAvoid", () => {
  beforeEach(() => {
    claimRepo.reserve.mockReset();
    claimRepo.quarantine.mockReset();
    claimRepo.list.mockReset();
    claimRepo.release.mockReset().mockResolvedValue(true);
    claimRepo.releaseQuarantine.mockReset().mockResolvedValue(true);
    claimRepo.reserve.mockImplementation(async (input) => ({
      id: "hpc_test",
      ...input,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    }));
    claimRepo.quarantine.mockImplementation(async (input) => ({
      id: "hpc_quarantine",
      ...input,
      projectId: "__host_port_quarantine__",
      serviceId: "__host_port_quarantine__",
      containerPort: input.port,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    }));
  });

  it("reads legacy server aliases until a canonical port supersedes them", async () => {
    claimRepo.list.mockImplementation(async (targetKey: string) =>
      targetKey.startsWith("host:")
        ? [
            {
              ...claims[0],
              id: "canonical",
              targetKey,
              createdAt: new Date(0),
              updatedAt: new Date(0),
            },
          ]
        : [
            {
              ...claims[0],
              id: "same-port-legacy",
              targetKey,
              createdAt: new Date(0),
              updatedAt: new Date(0),
            },
            {
              ...claims[1],
              id: "legacy-only",
              targetKey,
              createdAt: new Date(0),
              updatedAt: new Date(0),
            },
          ],
    );

    const found = await listTargetPinnedHostPorts(remoteTarget);
    expect(found.map((claim) => claim.id)).toEqual(["canonical", "legacy-only"]);
  });

  it("quarantines an edge port under the canonical key even when a legacy alias claims it", async () => {
    claimRepo.list.mockImplementation(async (targetKey: string) =>
      targetKey.startsWith("server:")
        ? [
            {
              ...claims[0],
              id: "legacy",
              targetKey,
              createdAt: new Date(0),
              updatedAt: new Date(0),
            },
          ]
        : [],
    );
    claimRepo.quarantine.mockImplementationOnce(async (input) => ({
      id: "quarantine",
      ...input,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    }));

    await prepareTargetPinnedHostPorts({
      target: remoteTarget,
      edgeProxy: { listLoopbackUpstreamPortsStrict: async () => new Set([20001]) },
    });

    expect(claimRepo.quarantine).toHaveBeenCalledWith({
      targetKey: remoteTarget.targetKey,
      port: 20001,
    });
  });

  it("blocks allocation preparation when edge inventory is inconclusive", async () => {
    const failure = new Error("edge config unreadable");
    await expect(
      prepareTargetPinnedHostPorts({
        target: remoteTarget,
        edgeProxy: { listLoopbackUpstreamPortsStrict: async () => Promise.reject(failure) },
      }),
    ).rejects.toBe(failure);
    expect(claimRepo.quarantine).not.toHaveBeenCalled();
  });

  it("refuses claims when the remote target has only a mutable connection identity", async () => {
    const scan = vi.fn(async () => new Set<number>());
    await expect(
      prepareTargetPinnedHostPorts({
        target: { ...remoteTarget, stable: false },
        edgeProxy: { listLoopbackUpstreamPortsStrict: scan },
      }),
    ).rejects.toThrow("no stable host identity");
    expect(scan).not.toHaveBeenCalled();
    expect(claimRepo.quarantine).not.toHaveBeenCalled();
  });

  it("prefers an exact container claim and uses a legacy scalar only when allowed", () => {
    expect(
      findOwnedPinnedHostPort(claims, {
        projectId: "compose",
        serviceId: "api",
        containerPort: 3000,
      })?.port,
    ).toBe(20002);

    const legacy: PinnedHostPort[] = [
      { projectId: "compose", serviceId: "legacy", containerPort: null, port: 20004 },
    ];
    const owner = { projectId: "compose", serviceId: "legacy", containerPort: 8080 };
    expect(findOwnedPinnedHostPort(legacy, owner)).toBeUndefined();
    expect(findOwnedPinnedHostPort(legacy, owner, { allowLegacyContainerPort: true })?.port).toBe(
      20004,
    );
  });

  it("never treats a quarantine sentinel as reusable, even for an imported matching id", () => {
    const quarantine: PinnedHostPort[] = [
      {
        projectId: "__host_port_quarantine__",
        serviceId: "__host_port_quarantine__",
        containerPort: 20005,
        port: 20005,
      },
    ];
    const owner = {
      projectId: "__host_port_quarantine__",
      serviceId: "__host_port_quarantine__",
      containerPort: 20005,
    };

    expect(findOwnedPinnedHostPort(quarantine, owner)).toBeUndefined();
    expect(pinnedHostPortsToAvoid(quarantine, { ...owner, port: 20005 }).has(20005)).toBe(true);
  });

  it("reserves every offline-capable database claim by default", () => {
    expect([...pinnedHostPortsToAvoid(claims)].sort()).toEqual([20001, 20002, 20003]);
  });

  it("releases only the carried claim owned by the service being redeployed", () => {
    const avoid = pinnedHostPortsToAvoid(claims, {
      projectId: "compose",
      serviceId: "api",
      containerPort: 3000,
      port: 20002,
    });

    expect(avoid.has(20002)).toBe(false);
    expect(avoid.has(20001)).toBe(true);
    expect(avoid.has(20003)).toBe(true);
  });

  it("does not release a port that another owner also claims", () => {
    const duplicate = [
      ...claims,
      { projectId: "other", serviceId: "web", containerPort: 3000, port: 20002 },
    ] satisfies PinnedHostPort[];

    expect(
      pinnedHostPortsToAvoid(duplicate, {
        projectId: "compose",
        serviceId: "api",
        containerPort: 3000,
        port: 20002,
      }).has(20002),
    ).toBe(true);
  });

  it("does not release an unowned preferred port", () => {
    expect(
      pinnedHostPortsToAvoid(claims, {
        projectId: "compose",
        serviceId: "missing",
        containerPort: 3000,
        port: 20001,
      }).has(20001),
    ).toBe(true);
  });

  it("makes the allocator skip a pinned port even when no container is listening", () => {
    expect(pickHostPort(new Set(), { avoid: pinnedHostPortsToAvoid(claims) })).toBe(20000);

    const firstRangePortClaimed: PinnedHostPort[] = [
      { projectId: "offline", serviceId: "api", containerPort: 3000, port: 20000 },
    ];
    expect(pickHostPort(new Set(), { avoid: pinnedHostPortsToAvoid(firstRangePortClaimed) })).toBe(
      20001,
    );
  });

  it("blocks GHSA-284v-9jw3-jfhx when only a stale edge vhost still names the port", async () => {
    const canonicalClaims: Array<ReturnType<typeof storedClaim>> = [];
    claimRepo.list.mockImplementation(async (targetKey: string) =>
      targetKey === localTarget.targetKey ? canonicalClaims : [],
    );
    claimRepo.quarantine.mockImplementationOnce(async ({ targetKey, port }) => {
      const quarantine = storedClaim("stale-edge-quarantine", targetKey, {
        projectId: "__host_port_quarantine__",
        serviceId: "__host_port_quarantine__",
        containerPort: port,
        port,
      });
      canonicalClaims.push(quarantine);
      return quarantine;
    });

    // Project A's container is stopped/crash-looping: the live-listener scan
    // below is intentionally empty. Its forgotten vhost is the only remaining
    // evidence that 20000 must not be handed to project B.
    const claimsAfterEdgeInventory = await prepareTargetPinnedHostPorts({
      target: localTarget,
      edgeProxy: { listLoopbackUpstreamPortsStrict: async () => new Set([20000]) },
    });
    const allocation = await allocateAndReservePinnedHostPort({
      target: localTarget,
      claims: claimsAfterEdgeInventory,
      owner: { projectId: "project-b", serviceId: "echo", containerPort: 8080 },
      allocate: async (options) => ({
        port: pickHostPort(new Set(), options),
        scanned: true,
      }),
    });

    expect(claimRepo.quarantine).toHaveBeenCalledWith({ targetKey: "local", port: 20000 });
    expect(allocation.port).toBe(20001);
    expect(claimRepo.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project-b", port: 20001 }),
    );
  });

  it("lets a service keep its own carried port when nobody else claims it", () => {
    const avoid = pinnedHostPortsToAvoid(claims, {
      projectId: "compose",
      serviceId: "api",
      containerPort: 3000,
      port: 20002,
    });

    expect(pickHostPort(new Set(), { preferred: 20002, avoid })).toBe(20002);
  });

  it("allocates around a stopped owner and commits the new claim before returning", async () => {
    const events: string[] = [];
    claimRepo.reserve.mockImplementationOnce(async (input) => {
      events.push("reserved");
      return {
        id: "hpc_new",
        ...input,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      };
    });

    const result = await allocateAndReservePinnedHostPort({
      target: localTarget,
      claims: [{ projectId: "stopped", serviceId: null, containerPort: 3000, port: 20000 }],
      owner: { projectId: "new", serviceId: null, containerPort: 3000 },
      allocate: async (options) => {
        events.push("allocated");
        return { port: pickHostPort(new Set(), options), scanned: true };
      },
    });

    expect(result.port).toBe(20001);
    expect(events).toEqual(["allocated", "reserved"]);
    expect(claimRepo.reserve).toHaveBeenCalledWith({
      targetKey: "local",
      projectId: "new",
      serviceId: null,
      containerPort: 3000,
      port: 20001,
    });
  });

  it("reuses an occupied port only when the target claim proves exact ownership", async () => {
    const owner = { projectId: "compose", serviceId: "api", containerPort: 3000 };
    const result = await allocateAndReservePinnedHostPort({
      target: remoteTarget,
      claims,
      owner,
      cachedPreferred: 29999,
      allocate: async (options) => ({
        port: pickHostPort(new Set([20002]), options),
        scanned: true,
      }),
    });

    expect(result.port).toBe(20002);
    expect(claimRepo.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ targetKey: remoteTarget.targetKey, ...owner, port: 20002 }),
    );
  });

  it("preserves null as a legacy claim identity instead of treating it as missing", async () => {
    const legacy: PinnedHostPort = {
      projectId: "legacy",
      serviceId: "api",
      containerPort: null,
      port: 20004,
    };
    await allocateAndReservePinnedHostPort({
      target: localTarget,
      claims: [legacy],
      owner: { projectId: "legacy", serviceId: "api", containerPort: 8080 },
      allowLegacyContainerPort: true,
      allocate: async (options) => ({
        port: pickHostPort(new Set(), options),
        scanned: true,
      }),
    });

    expect(claimRepo.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ containerPort: null, port: 20004 }),
    );
  });

  it("rolls back only claims created by an unrouted failed activation", async () => {
    const fresh = await allocateAndReservePinnedHostPort({
      target: localTarget,
      claims: [],
      owner: { projectId: "new", serviceId: "api", containerPort: 3000 },
      allocate: async () => ({ port: 20010, scanned: true }),
    });
    const carried = await allocateAndReservePinnedHostPort({
      target: localTarget,
      claims: [{ projectId: "old", serviceId: "api", containerPort: 3000, port: 20011 }],
      owner: { projectId: "old", serviceId: "api", containerPort: 3000 },
      allocate: async () => ({ port: 20011, scanned: true }),
    });

    await expect(releaseNewPinnedHostPortClaims(localTarget, [fresh, carried])).resolves.toBe(1);
    expect(claimRepo.release).toHaveBeenCalledTimes(1);
    expect(claimRepo.release).toHaveBeenCalledWith(
      expect.objectContaining({
        targetKey: "local",
        projectId: "new",
        serviceId: "api",
        containerPort: 3000,
        port: 20010,
      }),
    );
  });

  it("converges canonical and legacy claims only after a fresh strict edge scan", async () => {
    const projectId = "project-a";
    const canonical = remoteTarget.targetKey;
    const legacy = remoteTarget.legacyTargetKeys[0]!;
    const desired = storedClaim("desired", canonical, {
      projectId,
      serviceId: "api",
      containerPort: 3000,
      port: 20010,
    });
    claimRepo.list.mockImplementation(async (targetKey: string) =>
      targetKey === canonical
        ? [
            desired,
            storedClaim("observed-current", canonical, {
              projectId,
              serviceId: "worker",
              containerPort: 4000,
              port: 20011,
            }),
            storedClaim("stale-current", canonical, {
              projectId,
              serviceId: "old",
              containerPort: 5000,
              port: 20012,
            }),
            storedClaim("foreign", canonical, {
              projectId: "project-b",
              serviceId: "api",
              containerPort: 3000,
              port: 20013,
            }),
            storedClaim("observed-quarantine", canonical, {
              projectId: "__host_port_quarantine__",
              serviceId: "__host_port_quarantine__",
              containerPort: 20014,
              port: 20014,
            }),
            storedClaim("stale-quarantine", canonical, {
              projectId: "__host_port_quarantine__",
              serviceId: "__host_port_quarantine__",
              containerPort: 20015,
              port: 20015,
            }),
          ]
        : [
            storedClaim("desired-legacy", legacy, {
              projectId,
              serviceId: "api",
              containerPort: 3000,
              port: 20010,
            }),
            storedClaim("stale-legacy", legacy, {
              projectId,
              serviceId: "old-legacy",
              containerPort: 6000,
              port: 20016,
            }),
            storedClaim("observed-legacy", legacy, {
              projectId,
              serviceId: "live-legacy",
              containerPort: 7000,
              port: 20017,
            }),
            storedClaim("foreign-legacy", legacy, {
              projectId: "project-b",
              serviceId: "worker",
              containerPort: 4000,
              port: 20018,
            }),
            storedClaim("stale-quarantine-legacy", legacy, {
              projectId: "__host_port_quarantine__",
              serviceId: "__host_port_quarantine__",
              containerPort: 20019,
              port: 20019,
            }),
            storedClaim("observed-quarantine-legacy", legacy, {
              projectId: "__host_port_quarantine__",
              serviceId: "__host_port_quarantine__",
              containerPort: 20020,
              port: 20020,
            }),
          ],
    );
    const events: string[] = [];
    claimRepo.reserve.mockImplementation(async (input) => {
      events.push("reserve");
      return storedClaim("desired", input.targetKey, {
        projectId: input.projectId,
        serviceId: input.serviceId,
        containerPort: input.containerPort,
        port: input.port,
      });
    });
    claimRepo.release.mockImplementation(async () => {
      events.push("release-workload");
      return true;
    });
    claimRepo.releaseQuarantine.mockImplementation(async () => {
      events.push("release-quarantine");
      return true;
    });
    const scan = vi.fn(async (opts?: { refresh?: boolean }) => {
      events.push("scan");
      expect(opts).toEqual({ refresh: true });
      return new Set([20010, 20011, 20014, 20017, 20020]);
    });

    const result = await convergeTargetHostPortClaims({
      target: remoteTarget,
      projectId,
      desiredPublishes: [{ serviceId: "api", containerPort: 3000, hostPort: 20010 }],
      edgeProxy: { listLoopbackUpstreamPortsStrict: scan },
    });

    expect(events.slice(0, 2)).toEqual(["reserve", "scan"]);
    expect(result.released).toBe(5);
    expect(result.retained.map((claim) => claim.id)).toEqual([
      "desired",
      "observed-current",
      "observed-legacy",
    ]);
    expect(claimRepo.release).toHaveBeenCalledTimes(3);
    expect(claimRepo.release).toHaveBeenCalledWith(
      expect.objectContaining({ targetKey: legacy, port: 20010, projectId }),
    );
    expect(claimRepo.release).not.toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project-b" }),
    );
    expect(claimRepo.releaseQuarantine).toHaveBeenCalledTimes(2);
    expect(claimRepo.releaseQuarantine).not.toHaveBeenCalledWith(
      expect.objectContaining({ port: 20014 }),
    );
    expect(claimRepo.releaseQuarantine).not.toHaveBeenCalledWith(
      expect.objectContaining({ port: 20020 }),
    );
  });

  it("releases nothing when the required post-write edge refresh is inconclusive", async () => {
    const failure = new Error("edge config unreadable");
    const scan = vi.fn(async () => Promise.reject(failure));

    await expect(
      convergeTargetHostPortClaimsUnlocked({
        target: localTarget,
        projectId: "project-a",
        desiredPublishes: [{ serviceId: null, containerPort: 3000, hostPort: 20010 }],
        edgeProxy: { listLoopbackUpstreamPortsStrict: scan },
      }),
    ).rejects.toBe(failure);

    expect(claimRepo.reserve).toHaveBeenCalledTimes(1);
    expect(scan).toHaveBeenCalledWith({ refresh: true });
    expect(claimRepo.list).not.toHaveBeenCalled();
    expect(claimRepo.release).not.toHaveBeenCalled();
    expect(claimRepo.releaseQuarantine).not.toHaveBeenCalled();
  });

  it("releases nothing if a desired reservation disappears before the claim read-back", async () => {
    claimRepo.list.mockResolvedValue([
      storedClaim("stale-current", "local", {
        projectId: "project-a",
        serviceId: "old",
        containerPort: 4000,
        port: 20011,
      }),
    ]);

    await expect(
      convergeTargetHostPortClaimsUnlocked({
        target: localTarget,
        projectId: "project-a",
        desiredPublishes: [{ serviceId: "api", containerPort: 3000, hostPort: 20010 }],
        edgeProxy: { listLoopbackUpstreamPortsStrict: async () => new Set<number>() },
      }),
    ).rejects.toThrow("disappeared before convergence completed");

    expect(claimRepo.release).not.toHaveBeenCalled();
    expect(claimRepo.releaseQuarantine).not.toHaveBeenCalled();
  });

  it("validates the complete desired claim set before reserving or scanning", async () => {
    const scan = vi.fn(async () => new Set<number>());

    await expect(
      convergeTargetHostPortClaimsUnlocked({
        target: localTarget,
        projectId: "project-a",
        desiredPublishes: [
          { serviceId: "api", containerPort: 3000, hostPort: 20010 },
          { serviceId: "worker", containerPort: 4000, hostPort: 20010 },
        ],
        edgeProxy: { listLoopbackUpstreamPortsStrict: scan },
      }),
    ).rejects.toThrow("one host port to multiple owners");
    await expect(
      convergeTargetHostPortClaimsUnlocked({
        target: localTarget,
        projectId: "project-a",
        desiredPublishes: [
          { serviceId: "api", containerPort: 3000, hostPort: 20010 },
          { serviceId: "api", containerPort: 3000, hostPort: 20011 },
        ],
        edgeProxy: { listLoopbackUpstreamPortsStrict: scan },
      }),
    ).rejects.toThrow("one owner to multiple host ports");

    expect(claimRepo.reserve).not.toHaveBeenCalled();
    expect(scan).not.toHaveBeenCalled();
    expect(claimRepo.list).not.toHaveBeenCalled();
  });

  it("plans the whole cleanup before deleting and fails closed on malformed quarantine", async () => {
    claimRepo.list.mockResolvedValue([
      storedClaim("stale-current", "local", {
        projectId: "project-a",
        serviceId: null,
        containerPort: 3000,
        port: 20010,
      }),
      storedClaim("malformed-quarantine", "local", {
        projectId: "__host_port_quarantine__",
        serviceId: "__host_port_quarantine__",
        containerPort: 3000,
        port: 20011,
      }),
    ]);

    await expect(
      convergeTargetHostPortClaimsUnlocked({
        target: localTarget,
        projectId: "project-a",
        desiredPublishes: [],
        edgeProxy: { listLoopbackUpstreamPortsStrict: async () => new Set<number>() },
      }),
    ).rejects.toThrow("Malformed host-port quarantine claim");

    expect(claimRepo.release).not.toHaveBeenCalled();
    expect(claimRepo.releaseQuarantine).not.toHaveBeenCalled();
  });
});
