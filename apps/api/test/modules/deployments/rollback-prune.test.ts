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
 */

const h = vi.hoisted(() => ({
  project: null as Record<string, unknown> | null,
  ready: [] as Array<Record<string, unknown>>,
  /** deploymentId → service_deployment rows (per-service images). */
  serviceRows: {} as Record<string, Array<{ imageRef: string | null; serviceName?: string | null }>>,
  purged: [] as Array<{ id: string; imageRef: string | null }>,
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
