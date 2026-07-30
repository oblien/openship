import { describe, it, expect } from "vitest";
import type { Deployment } from "@repo/db";
import { computeKeepSet, selectImageRemovalRefs } from "./image-gc";

// Minimal deployment shape for the pure keep-set logic (loaders are injected, so
// no DB). Casts keep the fixtures terse — computeKeepSet only reads id/imageRef/pinned.
const asDeps = (rows: Array<Partial<Deployment>>) => rows as unknown as Deployment[];

describe("computeKeepSet", () => {
  it("keeps active + newest rollbackWindow unpinned + all pinned; prunes older; unions dep + service imageRefs", async () => {
    const project = { id: "p1", activeDeploymentId: "d5", rollbackWindow: 2 };
    // ready, newest first: d5 (active), d4, d3, d2 (pinned), d1 (oldest, unpinned)
    const ready = asDeps([
      { id: "d5", imageRef: "compose", pinned: false }, // compose sentinel dep.imageRef
      { id: "d4", imageRef: "img-d4", pinned: false },
      { id: "d3", imageRef: "img-d3", pinned: false },
      { id: "d2", imageRef: "img-d2", pinned: true },
      { id: "d1", imageRef: "img-d1", pinned: false },
    ]);
    const sds: Record<string, Array<{ imageRef: string | null }>> = {
      d5: [{ imageRef: "svc-web-5" }, { imageRef: "svc-api-5" }],
      d4: [{ imageRef: "svc-web-4" }],
      d3: [{ imageRef: "svc-web-3" }],
      d2: [{ imageRef: "svc-web-2" }],
      d1: [{ imageRef: "svc-web-1" }],
    };

    const keep = await computeKeepSet(project, {
      listReadyOrderedDesc: async () => ready,
      findById: async (id) => ready.find((d) => d.id === id),
      listByDeployment: async (id) => sds[id] ?? [],
    });

    // Kept: active (d5), the 2 newest unpinned (d4, d3), and the pinned one (d2).
    for (const ref of ["svc-web-5", "svc-api-5", "img-d4", "svc-web-4", "img-d3", "svc-web-3", "img-d2", "svc-web-2"]) {
      expect(keep.has(ref)).toBe(true);
    }
    // Pruned: d1 (beyond the window, unpinned).
    expect(keep.has("img-d1")).toBe(false);
    expect(keep.has("svc-web-1")).toBe(false);
  });

  it("keeps the active deployment even when it's absent from the ready list", async () => {
    const project = { id: "p2", activeDeploymentId: "dA", rollbackWindow: 1 };
    const keep = await computeKeepSet(project, {
      listReadyOrderedDesc: async () => asDeps([]),
      findById: async (id) => (id === "dA" ? asDeps([{ id: "dA", imageRef: "img-dA", pinned: false }])[0] : undefined),
      listByDeployment: async (id) => (id === "dA" ? [{ imageRef: "svc-dA" }] : []),
    });
    expect(keep.has("img-dA")).toBe(true);
    expect(keep.has("svc-dA")).toBe(true);
  });

  it("rollbackWindow 0 keeps only the active + pinned", async () => {
    const project = { id: "p3", activeDeploymentId: "d3", rollbackWindow: 0 };
    const ready = asDeps([
      { id: "d3", imageRef: "img-d3", pinned: false },
      { id: "d2", imageRef: "img-d2", pinned: false },
      { id: "d1", imageRef: "img-d1", pinned: true },
    ]);
    const keep = await computeKeepSet(project, {
      listReadyOrderedDesc: async () => ready,
      findById: async (id) => ready.find((d) => d.id === id),
      listByDeployment: async () => [],
    });
    expect(keep.has("img-d3")).toBe(true); // active
    expect(keep.has("img-d1")).toBe(true); // pinned
    expect(keep.has("img-d2")).toBe(false); // beyond window(0), unpinned → pruned
  });
});

describe("selectImageRemovalRefs (never ruin an operator's image)", () => {
  const keep = new Set<string>(["openship/app-web:keep"]);

  it("keeps an image whose tag is in the keep-set", () => {
    expect(selectImageRemovalRefs({ id: "sha1", repoTags: ["openship/app-web:keep"] }, keep)).toEqual([]);
  });

  it("removes ONLY our openship tags (never by id) for a prunable built image", () => {
    expect(
      selectImageRemovalRefs({ id: "sha2", repoTags: ["openship/app-web:bld_old-svc_x"] }, keep),
    ).toEqual(["openship/app-web:bld_old-svc_x"]);
  });

  it("on a multi-tagged image, untags only ours and leaves the operator's tag", () => {
    const refs = selectImageRemovalRefs(
      { id: "sha3", repoTags: ["openship/app-web:bld_old-svc_x", "myteam/custom:latest"] },
      keep,
    );
    expect(refs).toEqual(["openship/app-web:bld_old-svc_x"]); // never "myteam/custom:latest", never "sha3"
  });

  it("NEVER touches an image left with only foreign tags (operator re-purposed it)", () => {
    expect(selectImageRemovalRefs({ id: "sha4", repoTags: ["postgres:16-alpine"] }, keep)).toEqual([]);
    expect(selectImageRemovalRefs({ id: "sha5", repoTags: ["myteam/thing:v2"] }, keep)).toEqual([]);
  });

  it("removes a truly dangling (untagged) labeled leftover by id", () => {
    expect(selectImageRemovalRefs({ id: "sha6", repoTags: [] }, keep)).toEqual(["sha6"]);
  });
});
