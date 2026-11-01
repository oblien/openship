import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Retention prune, the part that can destroy data.
 *
 * Two invariants worth a test:
 *
 *   1. The window/pin arithmetic — the active release and pinned releases are
 *      never purged, and pinned ones don't consume the window budget.
 *   2. A purge NEVER removes an image another retained release still points at.
 *      A rollback restore re-deploys its source release's own tag, so two rows
 *      legitimately share one image; purging by row alone would then delete the
 *      image the live release is running.
 *   3. `artifact_retained_at` and the filesystem AGREE. Clearing that column is
 *      the claim "nothing of this release is on disk any more", and the two ways
 *      to break it are symmetrical lies: a row claiming an artifact it destroyed,
 *      and a row claiming to have reclaimed one that is still there. The second
 *      is what a swallowed removal failure produces, and the disk never comes
 *      back — nothing revisits a release once the column is null.
 */

const h = vi.hoisted(() => ({
  project: null as Record<string, unknown> | null,
  ready: [] as Array<Record<string, unknown>>,
  /** deploymentId → service_deployment rows (per-service images). */
  serviceRows: {} as Record<string, Array<{ imageRef: string | null; containerId?: string | null; serviceName?: string | null }>>,
  purged: [] as Array<{ id: string; imageRef: string | null }>,
  purgedContainers: [] as Array<string | null>,
  /** Per-service artifact refs the prune asked the runtime to destroy. */
  destroyed: [] as string[],
  /** Deployment ids whose `runtime.purge` rejects. */
  purgeFails: new Set<string>(),
  /** Artifact refs whose `runtime.destroy` rejects. */
  destroyFails: new Set<string>(),
  destroyHangs: new Set<string>(),
  retainedCleared: [] as string[],
  instanceWindow: 5,
  serviceReadFails: new Set<string>(),
  inFlight: false,
  disk: [] as Array<{ totalBytes: number | null; freeBytes: number | null }>,
  diskReads: 0,
  ownedImages: [] as string[],
  resolutions: [] as string[],
  remoteExecutor: { exec: async () => "" },
  localExecutor: { exec: async () => "" },
  diskExecutors: [] as unknown[],
}));

vi.mock("@repo/db", () => ({
  withAdvisoryLock: async (_key: string, fn: () => Promise<unknown>) => fn(),
  repos: {
    project: {
      findById: async () => h.project,
      update: async () => {},
    },
    deployment: {
      listPendingRoleHandovers: async () => [],
      listForRetention: async () => h.ready,
      listInFlightByProject: async () => h.inFlight ? [{}] : [],
      findById: async (id: string) => h.ready.find((d) => d.id === id),
      setArtifactRetainedAt: async (id: string, at: Date | null) => {
        if (at === null) {
          h.retainedCleared.push(id);
          const row = h.ready.find(dep => dep.id === id);
          if (row) row.artifactRetainedAt = null;
        }
      },
      setContainerId: async () => {},
      setPinned: async () => {},
      countPinned: async () => 0,
    },
    service: {
      listByDeployment: async (id: string) => {
        if (h.serviceReadFails.has(id)) throw new Error("service inventory unavailable");
        return h.serviceRows[id] ?? [];
      },
    },
    instanceSettings: {
      get: async () => ({ defaultRollbackWindow: h.instanceWindow }),
    },
    member: { listByOrganization: async () => [] },
  },
}));

vi.mock("@repo/platform/engine/lib/deployment-runtime", async () => {
  const { DockerRuntime } = await import("@repo/adapters");
  const resolve = async (dep: { id: string; meta?: { testHost?: string; withoutExecutor?: boolean } }) => {
    h.resolutions.push(dep.id);
    return ({
    serverId: null,
    hostPortTarget: { targetKey: dep.meta?.testHost ?? "host-1", stable: dep.meta?.testHost !== "unverified" },
    runtime: Object.assign(Object.create(DockerRuntime.prototype), {
      name: "docker",
      connectionOptions: {
        executor: dep.meta?.testHost === "local" || dep.meta?.withoutExecutor ? undefined : h.remoteExecutor,
      },
      supports: (cap: string) => cap === "rollback",
      purge: async (ref: { imageRef: string | null; containerId: string | null }) => {
        h.purged.push({ id: dep.id, imageRef: ref.imageRef });
        h.purgedContainers.push(ref.containerId);
        if (h.purgeFails.has(dep.id)) throw new Error(`purge refused for ${dep.id}`);
      },
      destroy: async (ref: string) => {
        h.destroyed.push(ref);
        if (h.destroyHangs.has(ref)) await new Promise<void>(() => {});
        if (h.destroyFails.has(ref)) throw new Error(`still present after rm -rf: ${ref}`);
      },
      listProjectImages: async () => h.ownedImages.map(ref => ({ repoTags: [ref] })),
      dispose: async () => {},
    }),
    });
  };
  return {
    resolveDeploymentRuntime: resolve,
    resolveDeploymentRuntimeForRead: resolve,
    acquireLocalHostExecutor: async () => h.localExecutor,
  };
});
vi.mock("@repo/platform/engine/lib/host-disk", () => ({
  getHostDisk: async (_serverId: unknown, _orgId: unknown, options: { executor?: unknown }) => {
    h.diskExecutors.push(options?.executor);
    h.diskReads++;
    return h.disk.length > 1 ? h.disk.shift()! : h.disk[0] ?? { totalBytes: null, freeBytes: null };
  },
}));
vi.mock("@repo/platform/engine/modules/deployments/image-gc", () => ({
  reapProjectImages: async () => ({ removed: 0, bytes: 0, skippedInUse: 0, errors: 0 }),
}));

// The orchestrator statically imports build.service (checkNoActiveBuild) and
// image-gc; stub the deploy-side one so importing it can't pull the whole build
// graph, and let the REAL computeKeepSet run — it's the thing under test here.
vi.mock("@repo/platform/engine/modules/deployments/build.service", () => ({
  checkNoActiveBuild: async () => {},
  triggerDeployment: async () => ({ deployment: { id: "new" } }),
}));

const { prune, reconcileProjectRetention } = await import("@repo/platform/engine/modules/deployments/rollback/rollback-orchestrator");

const dep = (over: Record<string, unknown>) => ({
  id: "d",
  organizationId: "org1",
  projectId: "p1",
  imageRef: null,
  containerId: "c",
  pinned: false,
  artifactRetainedAt: new Date(),
  status: "ready",
  ...over,
});

beforeEach(() => {
  h.purged = [];
  h.purgedContainers = [];
  h.destroyed = [];
  h.purgeFails = new Set();
  h.destroyFails = new Set();
  h.destroyHangs = new Set();
  h.retainedCleared = [];
  h.serviceRows = {};
  h.instanceWindow = 5;
  h.serviceReadFails = new Set();
  h.inFlight = false;
  h.disk = [];
  h.diskReads = 0;
  h.ownedImages = [];
  h.resolutions = [];
  h.diskExecutors = [];
  h.project = {
    id: "p1",
    organizationId: "org1",
    activeDeploymentId: "d5",
    rollbackWindow: 2,
    rollbackWindowComputed: null,
    snapshotSizeBytes: null,
    capacityMeasuredAt: null,
    defaultRollbackStrategy: "git",
  };
});

describe("prune — window + pin arithmetic", () => {
  it("purges only unpinned releases beyond the window, never the active one", async () => {
    h.ready = [
      dep({ id: "d5", imageRef: "img5" }), // active
      dep({ id: "d4", imageRef: "img4" }), // window slot 1
      dep({ id: "d3", imageRef: "img3" }), // window slot 2
      dep({ id: "d2", imageRef: "img2", pinned: true }), // exempt, no budget
      dep({ id: "d1", imageRef: "img1" }), // overflow → purge
      dep({ id: "d0", imageRef: "img0" }), // overflow → purge
    ];

    const result = await prune("p1");

    expect(result.purged).toBe(2);
    expect(h.purged.map((p) => p.id).sort()).toEqual(["d0", "d1"]);
    expect(h.retainedCleared.sort()).toEqual(["d0", "d1"]);
  });

  it("skips releases whose artifact was already purged", async () => {
    h.ready = [
      dep({ id: "d5" }),
      dep({ id: "d4" }),
      dep({ id: "d3" }),
      dep({ id: "d2", imageRef: "img2", artifactRetainedAt: null }),
    ];
    const result = await prune("p1");
    expect(result.purged).toBe(0);
    expect(h.purged).toEqual([]);
  });

  it("falls back to the instance default when the project has no window set", async () => {
    h.project = { ...(h.project as object), rollbackWindow: null } as never;
    h.instanceWindow = 1;
    h.ready = [
      dep({ id: "d5", imageRef: "img5" }), // active
      dep({ id: "d4", imageRef: "img4" }), // the single window slot
      dep({ id: "d3", imageRef: "img3" }), // overflow
    ];
    await prune("p1");
    expect(h.purged.map((p) => p.id)).toEqual(["d3"]);
  });

  it("uses the configured default even when an older deploy saved an automatic window", async () => {
    h.project = {
      ...(h.project as object),
      rollbackWindow: null,
      rollbackWindowComputed: 3,
    } as never;
    h.instanceWindow = 1;
    h.ready = [
      dep({ id: "d5", imageRef: "img5" }),
      dep({ id: "d4", imageRef: "img4" }),
      dep({ id: "d3", imageRef: "img3" }),
      dep({ id: "d2", imageRef: "img2" }),
      dep({ id: "d1", imageRef: "img1" }),
    ];
    await prune("p1");
    expect(h.purged.map((p) => p.id)).toEqual(["d3", "d2", "d1"]);
  });
});

describe("prune — never deletes an image another retained release needs", () => {
  it("never sends a carried live container to purge", async () => {
    h.ready = [
      dep({ id: "d5", imageRef: "img-live", containerId: "shared-live" }),
      dep({ id: "d4", containerId: "old-4" }),
      dep({ id: "d3", containerId: "old-3" }),
      dep({ id: "d1", imageRef: "img-old", containerId: "shared-live" }),
    ];
    await prune("p1");
    expect(h.purgedContainers).toEqual([null]);
    expect(h.retainedCleared).toEqual(["d1"]);
  });

  it("does not purge anything when the retained service inventory cannot be read", async () => {
    h.ready = [
      dep({ id: "d5", imageRef: "compose" }),
      dep({ id: "d4" }),
      dep({ id: "d3" }),
      dep({ id: "d1", imageRef: "img-shared" }),
    ];
    h.serviceReadFails.add("d5");
    await expect(prune("p1")).rejects.toThrow("service inventory unavailable");
    expect(h.purged).toEqual([]);
    expect(h.retainedCleared).toEqual([]);
  });

  it("does not clear an overflow marker when its service inventory cannot be read", async () => {
    h.ready = [dep({ id: "d5" }), dep({ id: "d4" }), dep({ id: "d3" }), dep({ id: "d1" })];
    h.serviceReadFails.add("d1");
    expect(await prune("p1")).toEqual({ purged: 0, failed: 1 });
    expect(h.purged).toEqual([]);
    expect(h.retainedCleared).toEqual([]);
  });

  it("leaves unverified artifacts out of the past-release budget", async () => {
    h.ready = [
      dep({ id: "unknown", status: "reconciling", imageRef: "img-unverified" }),
      dep({ id: "d5" }), dep({ id: "d4" }), dep({ id: "d3" }), dep({ id: "d1" }),
    ];
    await prune("p1");
    expect(h.retainedCleared).toEqual(["d1"]);
  });

  it("withholds the image ref when the ACTIVE release shares the same tag", async () => {
    // Exactly the shape a rollback produces: d5 (the restore) reuses d1's image.
    h.ready = [
      dep({ id: "d5", imageRef: "img-shared" }), // active — the restore
      dep({ id: "d4", imageRef: "img4" }),
      dep({ id: "d3", imageRef: "img3" }),
      dep({ id: "d1", imageRef: "img-shared" }), // overflow — the restore's source
    ];

    const result = await prune("p1");

    // The row still gets purged (container + retention flag) …
    expect(result.purged).toBe(1);
    expect(h.retainedCleared).toEqual(["d1"]);
    // … but the shared IMAGE is withheld, so the live release keeps running.
    expect(h.purged).toEqual([{ id: "d1", imageRef: null }]);
  });

  it("withholds an image a PINNED release still points at", async () => {
    h.ready = [
      dep({ id: "d5", imageRef: "img5" }),
      dep({ id: "d4", imageRef: "img4" }),
      dep({ id: "d3", imageRef: "img3" }),
      dep({ id: "d2", imageRef: "img-keep", pinned: true }),
      dep({ id: "d1", imageRef: "img-keep" }),
    ];
    await prune("p1");
    expect(h.purged).toEqual([{ id: "d1", imageRef: null }]);
  });

  it("still removes an image nothing else references", async () => {
    h.ready = [
      dep({ id: "d5", imageRef: "img5" }),
      dep({ id: "d4", imageRef: "img4" }),
      dep({ id: "d3", imageRef: "img3" }),
      dep({ id: "d1", imageRef: "img-orphan" }),
    ];
    await prune("p1");
    expect(h.purged).toEqual([{ id: "d1", imageRef: "img-orphan" }]);
  });

  it("counts per-SERVICE images when deciding what's still needed", async () => {
    h.ready = [
      dep({ id: "d5", imageRef: "compose" }), // active compose release
      dep({ id: "d4", imageRef: "compose" }),
      dep({ id: "d3", imageRef: "compose" }),
      dep({ id: "d1", imageRef: "openship/app-web:bld_1" }),
    ];
    // The active release's `web` service runs the very tag d1 recorded.
    h.serviceRows = { d5: [{ serviceName: "web", imageRef: "openship/app-web:bld_1" }] };
    await prune("p1");
    expect(h.purged).toEqual([{ id: "d1", imageRef: null }]);
  });
});

describe("prune — the retention column never claims a reclaim that did not happen", () => {
  // A compose static release keeps its doc-root in the SERVICE row's imageRef, so
  // `runtime.purge` (which works off the deployment ref, "compose" for these) can
  // never see it. These directories are the release.
  const DIR_WEB = "/opt/openship/static/releases/d1-web";
  const DIR_DOCS = "/opt/openship/static/releases/d1-docs";

  const overflowWithServiceDirs = () => {
    h.ready = [
      dep({ id: "d5", imageRef: "compose" }), // active
      dep({ id: "d4", imageRef: "compose" }),
      dep({ id: "d3", imageRef: "compose" }),
      dep({ id: "d1", imageRef: "compose" }), // overflow
    ];
    h.serviceRows = {
      d1: [
        { serviceName: "web", imageRef: DIR_WEB },
        { serviceName: "docs", imageRef: DIR_DOCS },
      ],
    };
  };

  it("reclaims every service directory of an overflow release, then clears the column", async () => {
    overflowWithServiceDirs();

    const result = await prune("p1");

    expect(h.destroyed.sort()).toEqual([DIR_DOCS, DIR_WEB]);
    expect(result.purged).toBe(1);
    expect(h.retainedCleared).toEqual(["d1"]);
  });

  it("keeps the column set when a service directory refuses to go", async () => {
    overflowWithServiceDirs();
    h.destroyFails = new Set([DIR_WEB]);

    const result = await prune("p1");

    // The sibling is still attempted — one stuck directory must not strand the
    // rest of the release on disk.
    expect(h.destroyed.sort()).toEqual([DIR_DOCS, DIR_WEB]);
    // But `d1` still holds DIR_WEB, so it is not reclaimed and must not say it is.
    // The next prune retries it; a cleared column would never look again.
    expect(h.retainedCleared).toEqual([]);
    expect(result.purged).toBe(0);
  });

  it("keeps the column set when the runtime purge itself fails", async () => {
    // The runtime half of the same invariant: `BareRuntime.purge` /
    // `DockerRuntime.purge` used to swallow a genuine removal failure and resolve,
    // which read here as a completed reclaim. They throw now, and this is what
    // that throw has to buy.
    h.ready = [
      dep({ id: "d5", imageRef: "img5" }),
      dep({ id: "d4", imageRef: "img4" }),
      dep({ id: "d3", imageRef: "img3" }),
      dep({ id: "d1", imageRef: "openship/app:bld_1" }),
    ];
    h.purgeFails = new Set(["d1"]);

    const result = await prune("p1");

    expect(h.purged).toEqual([{ id: "d1", imageRef: "openship/app:bld_1" }]);
    expect(h.retainedCleared).toEqual([]);
    expect(result.purged).toBe(0);
  });

  it("a failure on one release does not stop the next one from being reclaimed", async () => {
    h.ready = [
      dep({ id: "d5", imageRef: "img5" }),
      dep({ id: "d4", imageRef: "img4" }),
      dep({ id: "d3", imageRef: "img3" }),
      dep({ id: "d1", imageRef: "openship/app:bld_1" }),
      dep({ id: "d0", imageRef: "openship/app:bld_0" }),
    ];
    h.purgeFails = new Set(["d1"]);

    const result = await prune("p1");

    expect(result.purged).toBe(1);
    expect(h.retainedCleared).toEqual(["d0"]);
  });
});

describe("prune — recorded runtime roles", () => {
  const roles = (...ids: string[]) =>
    ids.map((containerId, index) => ({
      role: "worker",
      replica: index + 1,
      containerId,
    }));

  it("protects roles referenced by active, pinned, retained and reconciling releases", async () => {
    h.ready = [
      dep({ id: "d5", roleContainers: roles("active-worker") }),
      dep({ id: "d4", roleContainers: roles("retained-worker") }),
      dep({ id: "d3" }),
      dep({ id: "pinned", pinned: true, roleContainers: roles("pinned-worker") }),
      dep({ id: "uncertain", status: "reconciling", roleContainers: roles("uncertain-worker") }),
      dep({
        id: "d1",
        containerId: "active-worker",
        roleContainers: roles(
          "active-worker",
          "retained-worker",
          "pinned-worker",
          "uncertain-worker",
          "expired-worker",
          "expired-worker",
        ),
      }),
    ];

    expect(await prune("p1")).toEqual({ purged: 1, failed: 0 });
    expect(h.destroyed).toEqual(["expired-worker"]);
    expect(h.purgedContainers).toEqual([null]);
    expect(h.retainedCleared).toEqual(["d1"]);
  });

  it("keeps failed role cleanup retryable and still attempts its sibling roles", async () => {
    h.ready = [
      dep({ id: "d5" }),
      dep({ id: "d4" }),
      dep({ id: "d3" }),
      dep({ id: "d1", roleContainers: roles("stuck-worker", "other-worker") }),
    ];
    h.destroyFails.add("stuck-worker");

    expect(await prune("p1")).toEqual({ purged: 0, failed: 1 });
    expect(h.destroyed).toEqual(["stuck-worker", "other-worker"]);
    expect(h.retainedCleared).toEqual([]);

    h.destroyFails.clear();
    expect(await prune("p1")).toEqual({ purged: 1, failed: 0 });
    expect(h.retainedCleared).toEqual(["d1"]);
    expect(h.destroyed.filter((id) => id === "stuck-worker")).toHaveLength(2);
  });

  it("bounds a hanging role cleanup using its frozen stop grace without clearing the retry marker", async () => {
    vi.useFakeTimers();
    try {
      h.ready = [
        dep({ id: "d5" }),
        dep({ id: "d4" }),
        dep({ id: "d3" }),
        dep({
          id: "d1",
          roleContainers: roles("stuck-worker", "other-worker"),
          meta: {
            roles: [{ name: "worker", kind: "worker", command: "run", stopGracePeriod: "90s" }],
          },
        }),
      ];
      h.destroyHangs.add("stuck-worker");
      const result = prune("p1");
      await vi.advanceTimersByTimeAsync(119_000);
      expect(h.destroyed).toEqual(["stuck-worker", "other-worker"]);
      expect(h.purged).toEqual([]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await result).toEqual({ purged: 0, failed: 1 });
      expect(h.retainedCleared).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("automatic rollback storage pressure", () => {
  const GB = 1024 ** 3;
  const low = { totalBytes: 25 * GB, freeBytes: GB };
  const enough = { totalBytes: 25 * GB, freeBytes: 6 * GB };
  const image = (id: string) => `openship/app:bld_${id}`;
  function automatic() {
    h.project!.rollbackWindow = null;
    h.ready = [
      dep({ id: "d5", imageRef: image("d5") }),
      ...["d4", "d3", "d2", "d1"].map((id) =>
        dep({
          id,
          imageRef: image(id),
          commitSha: "a".repeat(40),
          meta: { repoUrl: "https://github.com/example/app.git" },
        }),
      ),
    ];
    h.ownedImages = ["d5", "d4", "d3", "d2", "d1"].map(image);
    h.disk = [low, enough];
  }

  it("reclaims the oldest rebuildable release and stops when real free space recovers", async () => {
    automatic();
    const result = await reconcileProjectRetention("p1");
    expect(result.purged).toBe(1);
    expect(h.purged).toEqual([{ id: "d1", imageRef: image("d1") }]);
    expect(h.purgedContainers).toEqual([null]);
    expect(h.retainedCleared).toEqual(["d1"]);
    expect(h.ready.find((row) => row.id === "d1")!.commitSha).toBe(
      "a".repeat(40),
    );
    expect(h.diskReads).toBe(2);
    expect(h.resolutions).toEqual(["d5", "d1"]);
  });

  it("uses fresh measurements rather than counting shared image sizes as reclaimed bytes", async () => {
    automatic();
    h.disk = [low, low, enough];
    expect((await reconcileProjectRetention("p1")).purged).toBe(2);
    expect(h.retainedCleared).toEqual(["d1", "d2"]);
    expect(
      h.ready.find((row) => row.id === "d5")!.artifactRetainedAt,
    ).toBeInstanceOf(Date);
  });

  it("normalizes legacy refs before protecting containers and unowned service images", async () => {
    automatic();
    Object.assign(h.ready.find((row) => row.id === "d1")!, {
      containerId: " old-main ",
      roleContainers: [{ role: "worker", replica: 1, containerId: " old-worker " }],
    });
    h.serviceRows.d1 = [
      {
        serviceName: "external",
        containerId: " old-service ",
        imageRef: " ghcr.io/example/custom:v1 ",
      },
    ];
    await reconcileProjectRetention("p1");
    expect(h.retainedCleared).toEqual(["d1"]);
    expect(h.destroyed).toEqual([]);
    expect(h.purgedContainers).toEqual([null, null]);
    expect(h.purged).toEqual([
      { id: "d1", imageRef: image("d1") },
      { id: "d1", imageRef: null },
    ]);
  });

  it("protects shared live service images, pins, and unverified releases", async () => {
    automatic();
    h.ready.find((row) => row.id === "d2")!.pinned = true;
    h.ready.find((row) => row.id === "d3")!.status = "reconciling";
    h.serviceRows.d5 = [{ serviceName: "web", imageRef: image("d1") }];
    h.disk = [low];
    await reconcileProjectRetention("p1");
    expect(h.retainedCleared).toEqual(["d1", "d4"]);
    expect(h.purged[0]).toEqual({ id: "d1", imageRef: null });
    expect(h.purgedContainers.every((ref) => ref === null)).toBe(true);
  });

  it("preserves shared references from legacy history without an archive marker", async () => {
    automatic();
    Object.assign(h.ready.find((row) => row.id === "d2")!, {
      imageRef: image("d1"),
      meta: null,
      artifactRetainedAt: null,
    });
    await reconcileProjectRetention("p1");
    expect(h.purged).toEqual([{ id: "d1", imageRef: null }]);
    expect(h.destroyed).toEqual([]);
  });

  it("does not reclaim history on a previous deployment host", async () => {
    automatic();
    h.ready.find((row) => row.id === "d1")!.meta = {
      repoUrl: "https://github.com/example/app.git",
      testHost: "previous-host",
    };
    await reconcileProjectRetention("p1");
    expect(h.retainedCleared).toEqual(["d2"]);
  });

  it("measures local Docker through the host channel without selecting a server alias", async () => {
    automatic();
    for (const row of h.ready) {
      row.meta = { ...(row.meta as object), testHost: "local" };
    }
    await reconcileProjectRetention("p1");
    expect(h.retainedCleared).toEqual(["d1"]);
    expect(h.diskExecutors).toEqual([h.localExecutor, h.localExecutor]);
  });

  it("defers pressure cleanup if the verified remote runtime has no executor", async () => {
    automatic();
    h.ready.find((row) => row.id === "d5")!.meta = { withoutExecutor: true };
    await reconcileProjectRetention("p1");
    expect(h.retainedCleared).toEqual([]);
    expect(h.diskReads).toBe(0);
  });

  it("preserves artifacts when the execution host identity cannot be verified", async () => {
    automatic();
    h.ready.find((row) => row.id === "d5")!.meta = { testHost: "unverified" };
    await reconcileProjectRetention("p1");
    expect(h.retainedCleared).toEqual([]);
    expect(h.diskReads).toBe(0);
  });

  it.each([true, false])(
    "requires an immutable registry source without a rebuild commit (%s)",
    async (immutable) => {
      automatic();
      Object.assign(h.ready.find((row) => row.id === "d1")!, {
        commitSha: null,
        meta: {
          releaseImageRef: immutable
            ? `ghcr.io/example/app@sha256:${"a".repeat(64)}`
            : "ghcr.io/example/app:latest",
        },
      });
      await reconcileProjectRetention("p1");
      expect(h.retainedCleared).toEqual([immutable ? "d1" : "d2"]);
    },
  );

  it("reclaims managed static release files while preserving their rebuild configuration", async () => {
    automatic();
    Object.assign(h.ready.find((row) => row.id === "d1")!, {
      containerId: "/opt/openship/static/releases/d1",
      imageRef: null,
    });
    await reconcileProjectRetention("p1");
    expect(h.retainedCleared).toEqual(["d1"]);
    expect(h.purgedContainers).toEqual(["/opt/openship/static/releases/d1"]);
    expect(h.ready.find((row) => row.id === "d1")!.meta).toHaveProperty(
      "repoUrl",
    );
  });

  it("stops when a fresh disk measurement becomes unavailable", async () => {
    automatic();
    h.disk = [low, { totalBytes: null, freeBytes: null }];
    await reconcileProjectRetention("p1");
    expect(h.retainedCleared).toEqual(["d1"]);
  });

  it.each(["upload", "missing-config", "redacted", "foreign-image"])(
    "preserves a %s release",
    async (kind) => {
      automatic();
      const candidate = h.ready.find((row) => row.id === "d1")!;
      if (kind === "upload")
        candidate.meta = {
          repoUrl: "https://github.com/example/app.git",
          localPath: "/uploads/source",
        };
      if (kind === "missing-config") candidate.meta = null;
      if (kind === "redacted")
        candidate.meta = {
          repoUrl: "https://github.com/example/app.git",
          composeServices: [{ name: "web", environment: { TOKEN: "***" } }],
        };
      if (kind === "foreign-image")
        h.ownedImages = h.ownedImages.filter((ref) => ref !== image("d1"));
      await reconcileProjectRetention("p1");
      expect(h.retainedCleared).toEqual(["d2"]);
      expect(candidate.artifactRetainedAt).toBeInstanceOf(Date);
    },
  );

  it.each([0, 2, 5])(
    "keeps explicit retention %i authoritative",
    async (window) => {
      automatic();
      h.project!.rollbackWindow = window;
      await reconcileProjectRetention("p1");
      expect(h.diskReads).toBe(0);
      expect(h.retainedCleared.length).toBe(Math.max(0, 4 - window));
    },
  );

  it.each([
    enough,
    { totalBytes: null, freeBytes: null },
    { totalBytes: 25 * GB, freeBytes: -1 },
  ])("preserves artifacts without confirmed pressure (%j)", async (disk) => {
    automatic();
    h.disk = [disk];
    await reconcileProjectRetention("p1");
    expect(h.retainedCleared).toEqual([]);
  });

  it("defers everything while a deployment still owns this project", async () => {
    automatic();
    h.inFlight = true;
    await reconcileProjectRetention("p1");
    expect(h.retainedCleared).toEqual([]);
    expect(h.diskReads).toBe(0);
  });

  it("keeps a failed reclaim retryable and does not evict a newer release", async () => {
    automatic();
    h.purgeFails.add("d1");
    expect((await reconcileProjectRetention("p1")).errors).toBe(1);
    expect(h.retainedCleared).toEqual([]);
    expect(h.purged.map((row) => row.id)).toEqual(["d1"]);
    h.purgeFails.clear();
    h.disk = [low, enough];
    await reconcileProjectRetention("p1");
    expect(h.retainedCleared).toEqual(["d1"]);
  });
});
