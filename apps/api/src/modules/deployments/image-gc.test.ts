import { describe, it, expect } from "vitest";
import type { Deployment } from "@repo/db";
import { kubernetesBuildImageTag } from "@repo/adapters";
import { computeKeepSet, selectImageRemovalRefs } from "@repo/platform/engine/modules/deployments/image-gc";

// Minimal deployment shape for the pure keep-set logic (loaders are injected, so
// no DB). Include the project/organization binding used by the shared ownership check.
const asDeps = (projectId: string, rows: Array<Partial<Deployment>>) =>
  rows.map(row => ({ projectId, organizationId: "org1", status: "ready", ...row })) as Deployment[];

describe("computeKeepSet", () => {
  it("protects only the newest retryable completed build without spending rollback history", async () => {
    const project = { id: "retry-project", organizationId: "org1", activeDeploymentId: "active", rollbackWindow: 1 };
    const receipt = (digit: string) => ({ completedBuildArtifacts: { version: 1, images: [
      { imageRef: `openship/app:bld_${digit}`, imageId: `sha256:${digit.repeat(64)}` },
    ] } });
    const rows = asDeps(project.id, [
      { id: "new-failed", status: "failed", artifactRetainedAt: new Date(), meta: receipt("a") },
      { id: "cancelled", status: "cancelled", artifactRetainedAt: new Date(), meta: receipt("b") },
      { id: "old-failed", status: "failed", artifactRetainedAt: new Date(), meta: receipt("c") },
      { id: "active", imageRef: "active-image" },
      { id: "history", imageRef: "history-image" },
    ]);
    const loaders = { listForRetention: async () => rows, listByDeployment: async () => [] };
    const keep = await computeKeepSet(project, loaders);
    expect(keep.has("openship/app:bld_a")).toBe(true);
    expect(keep.has(`sha256:${"a".repeat(64)}`)).toBe(true);
    expect(keep.has("openship/app:bld_b")).toBe(false);
    expect(keep.has("openship/app:bld_c")).toBe(false);
    expect(keep.has("history-image")).toBe(true);
    rows.unshift(...asDeps(project.id, [{ id: "new-success", imageRef: "new-success" }]));
    expect((await computeKeepSet(project, loaders)).has("openship/app:bld_a")).toBe(false);
  });

  it("keeps a completed image while its worker is deploying, but not after cancellation", async () => {
    const project = { id: "p", organizationId: "org1", activeDeploymentId: null, rollbackWindow: 0 };
    const [dep] = asDeps(project.id, [{ id: "worker", status: "deploying", artifactRetainedAt: new Date(), meta: {
      completedBuildArtifacts: { version: 1, images: [{ imageRef: "openship/app:bld_work", imageId: `sha256:${"a".repeat(64)}` }] },
    } }]);
    const loaders = { listForRetention: async () => [dep!], listByDeployment: async () => [] };
    expect((await computeKeepSet(project, loaders)).has("openship/app:bld_work")).toBe(true);
    dep!.status = "cancelled";
    expect((await computeKeepSet(project, loaders)).has("openship/app:bld_work")).toBe(false);
  });

  it("keeps active + newest rollbackWindow unpinned + all pinned; prunes older; unions dep + service imageRefs", async () => {
    const project = { id: "p1", organizationId: "org1", activeDeploymentId: "d5", rollbackWindow: 2 };
    // ready, newest first: d5 (active), d4, d3, d2 (pinned), d1 (oldest, unpinned)
    const ready = asDeps(project.id, [
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
      listForRetention: async () => ready,
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
    const project = { id: "p2", organizationId: "org1", activeDeploymentId: "dA", rollbackWindow: 1 };
    const keep = await computeKeepSet(project, {
      listForRetention: async () => asDeps(project.id, []),
      findById: async (id) => (id === "dA" ? asDeps(project.id, [{ id: "dA", imageRef: "img-dA", pinned: false }])[0] : undefined),
      listByDeployment: async (id) => (id === "dA" ? [{ imageRef: "svc-dA" }] : []),
    });
    expect(keep.has("img-dA")).toBe(true);
    expect(keep.has("svc-dA")).toBe(true);
  });

  it("rollbackWindow 0 keeps only the active + pinned", async () => {
    const project = { id: "p3", organizationId: "org1", activeDeploymentId: "d3", rollbackWindow: 0 };
    const ready = asDeps(project.id, [
      { id: "d3", imageRef: "img-d3", pinned: false },
      { id: "d2", imageRef: "img-d2", pinned: false },
      { id: "d1", imageRef: "img-d1", pinned: true },
    ]);
    const keep = await computeKeepSet(project, {
      listForRetention: async () => ready,
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

  it("removes an expired build tag even when its image also has a retained tag", () => {
    expect(selectImageRemovalRefs({ id: "shared", repoTags: ["openship/app-web:keep", "openship/app-web:bld_old"] }, keep))
      .toEqual(["openship/app-web:bld_old"]);
  });

  it("keeps a registry or operator tag inside the openship namespace", () => {
    expect(selectImageRemovalRefs({ id: "registry", repoTags: ["openship/agent:v1"] }, keep)).toEqual([]);
    expect(selectImageRemovalRefs({ id: "tagged", repoTags: ["openship/app:bld_old", "openship/app:production"] }, keep))
      .toEqual(["openship/app:bld_old"]);
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

  it("removes only a cluster build's exact local publish alias", () => {
    const alias = kubernetesBuildImageTag("ghcr.io/acme/app", "bld_1");
    const img = { id: "cluster-image", buildId: "bld_1", repoTags: [alias, "ghcr.io/acme/app:production", "operator/copy:latest"] };
    expect(selectImageRemovalRefs(img, keep, "ghcr.io/acme/app")).toEqual([alias]);
    expect(selectImageRemovalRefs(img, keep, "ghcr.io/acme/another")).toEqual([]);
    expect(selectImageRemovalRefs({ ...img, buildId: null }, keep, "ghcr.io/acme/app")).toEqual([]);
  });

  it("honors retained image ids and aliases for cluster builds too", () => {
    const alias = kubernetesBuildImageTag("ghcr.io/acme/app", "bld_1");
    const img = { id: "cluster-image", buildId: "bld_1", repoTags: [alias] };
    expect(selectImageRemovalRefs(img, new Set([img.id]), "ghcr.io/acme/app")).toEqual([]);
    expect(selectImageRemovalRefs(img, new Set([alias]), "ghcr.io/acme/app")).toEqual([]);
  });
});
