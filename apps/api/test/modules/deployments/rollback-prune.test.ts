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
  serviceRows: {} as Record<string, Array<{ imageRef: string | null; serviceName?: string | null }>>,
  purged: [] as Array<{ id: string; imageRef: string | null }>,
  /** Per-service artifact refs the prune asked the runtime to destroy. */
  destroyed: [] as string[],
  /** Deployment ids whose `runtime.purge` rejects. */
  purgeFails: new Set<string>(),
  /** Artifact refs whose `runtime.destroy` rejects. */
  destroyFails: new Set<string>(),
  retainedCleared: [] as string[],
  instanceWindow: 5,
}));

vi.mock("@repo/db", () => ({
  repos: {
    project: {
      findById: async () => h.project,
      update: async () => {},
    },
    deployment: {
      listReadyOrderedDesc: async () => h.ready,
      findById: async (id: string) => h.ready.find((d) => d.id === id),
      setArtifactRetainedAt: async (id: string, at: Date | null) => {
        if (at === null) h.retainedCleared.push(id);
      },
      setContainerId: async () => {},
      setPinned: async () => {},
      countPinned: async () => 0,
    },
    service: {
      listByDeployment: async (id: string) => h.serviceRows[id] ?? [],
    },
    instanceSettings: {
      get: async () => ({ defaultRollbackWindow: h.instanceWindow }),
    },
    member: { listByOrganization: async () => [] },
  },
}));

vi.mock("../../../src/lib/deployment-runtime", () => ({
  resolveDeploymentRuntime: async (dep: { id: string }) => ({
    runtime: {
      name: "docker",
      supports: (cap: string) => cap === "rollback",
      purge: async (ref: { imageRef: string | null }) => {
        h.purged.push({ id: dep.id, imageRef: ref.imageRef });
        if (h.purgeFails.has(dep.id)) throw new Error(`purge refused for ${dep.id}`);
      },
      destroy: async (ref: string) => {
        h.destroyed.push(ref);
        if (h.destroyFails.has(ref)) throw new Error(`still present after rm -rf: ${ref}`);
      },
      dispose: async () => {},
    },
  }),
}));

// The orchestrator statically imports build.service (checkNoActiveBuild) and
// image-gc; stub the deploy-side one so importing it can't pull the whole build
// graph, and let the REAL computeKeepSet run — it's the thing under test here.
vi.mock("../../../src/modules/deployments/build.service", () => ({
  checkNoActiveBuild: async () => {},
  triggerDeployment: async () => ({ deployment: { id: "new" } }),
}));

const { prune } = await import("../../../src/modules/deployments/rollback");

const dep = (over: Record<string, unknown>) => ({
  id: "d",
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
  h.destroyed = [];
  h.purgeFails = new Set();
  h.destroyFails = new Set();
  h.retainedCleared = [];
  h.serviceRows = {};
  h.instanceWindow = 5;
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

  it("prefers the disk-sized auto window over the instance default", async () => {
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
      dep({ id: "d1", imageRef: "img1" }), // only this one overflows a window of 3
    ];
    await prune("p1");
    expect(h.purged.map((p) => p.id)).toEqual(["d1"]);
  });
});

describe("prune — never deletes an image another retained release needs", () => {
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
