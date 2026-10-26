import { beforeEach, describe, expect, it, vi } from "vitest";
import { DockerRuntime } from "@repo/adapters";
import type { Deployment, Project } from "@repo/db";

const h = vi.hoisted(() => ({
  project: { id: "project-b", organizationId: "org", activeDeploymentId: "dep-b" as string | null },
  latest: undefined as Deployment | undefined,
  activeMissing: false,
  resolve: vi.fn(),
  runtime: undefined as unknown,
  keep: new Set<string>(),
}));

vi.mock("@repo/platform/engine/lib/active-deployment", () => ({
  findActiveDeployment: async () =>
    h.activeMissing
      ? undefined
      : {
          id: "dep-b",
          projectId: h.project.id,
          organizationId: h.project.organizationId,
          meta: {},
        },
}));
vi.mock("@repo/db", () => ({
  repos: { deployment: { findLatestByProject: async () => h.latest } },
}));
vi.mock("@repo/platform/engine/lib/deployment-runtime", () => ({
  resolveDeploymentRuntime: async (deployment: Deployment) => {
    h.resolve(deployment.id);
    return { runtime: h.runtime };
  },
}));
vi.mock("@repo/platform/engine/modules/deployments/retention-lock", () => ({
  withRetentionLock: async (_id: string, action: (project: unknown) => Promise<unknown>) =>
    action(h.project),
}));
vi.mock("@repo/platform/engine/modules/deployments/retained-artifacts", () => ({
  computeKeepSet: async () => h.keep,
}));
vi.mock("@repo/platform/engine/modules/deployments/release-retention", () => ({
  refreshRollbackCapacity: async () => {},
}));

import { reapProjectImages } from "@repo/platform/engine/modules/deployments/image-gc";

type Image = {
  Id: string;
  RepoTags: string[];
  Labels: Record<string, string>;
  Size: number;
  inUse?: boolean;
};

function daemon(images: Image[]) {
  const inventory = new Map(images.map((image) => [image.Id, image]));
  const pruneImages = vi.fn(async () => {
    // Docker's filtered prune has no knowledge of Openship's retained IDs.
    for (const image of inventory.values()) {
      if (
        image.Labels["openship.project"] === h.project.id &&
        !image.RepoTags.length &&
        !image.inUse
      )
        inventory.delete(image.Id);
    }
  });
  const remove = vi.fn(async (ref: string, options: { force?: boolean }) => {
    expect(options.force).toBe(false);
    const image =
      inventory.get(ref) ?? [...inventory.values()].find((entry) => entry.RepoTags.includes(ref));
    if (!image) throw Object.assign(new Error("No such image"), { statusCode: 404 });
    if (image.inUse) throw Object.assign(new Error("Image is in use"), { statusCode: 409 });
    if (ref === image.Id || image.RepoTags.length === 1) inventory.delete(image.Id);
    else image.RepoTags = image.RepoTags.filter((tag) => tag !== ref);
  });
  const runtime = Object.create(DockerRuntime.prototype) as DockerRuntime;
  Object.assign(runtime, {
    _docker: {
      listImages: async ({ filters }: { filters: { label: string[] } }) =>
        [...inventory.values()].filter((image) =>
          filters.label.every((label) => {
            const [key, value] = label.split("=");
            return image.Labels[key!] === value;
          }),
        ),
      getImage: (ref: string) => ({
        remove: (options: { force?: boolean }) => remove(ref, options),
      }),
      pruneImages,
    },
    dispose: async () => {},
  });
  h.runtime = runtime;
  return { inventory, pruneImages, remove };
}

function image(id: string, tags: string[] = [], projectId = h.project.id): Image {
  return { Id: id, RepoTags: tags, Labels: { "openship.project": projectId }, Size: 100 };
}

beforeEach(() => {
  h.keep.clear();
  h.project.activeDeploymentId = "dep-b";
  h.latest = undefined;
  h.activeMissing = false;
  h.resolve.mockClear();
});

describe("project image retention on a shared Docker daemon (#1369)", () => {
  it("reclaims failed first-build leftovers without removing retained or foreign images", async () => {
    h.project.activeDeploymentId = null;
    h.latest = {
      id: "failed-first-build",
      projectId: h.project.id,
      organizationId: "org",
      status: "failed",
      meta: { deployTarget: "cloud" },
    } as Deployment;
    h.keep.add("openship/b:bld_retryable");
    const state = daemon([
      image("orphan", ["openship/b:bld_interrupted"]),
      image("retryable", ["openship/b:bld_retryable"]),
      { ...image("in-use", ["openship/b:bld_in_use"]), inUse: true },
      image("foreign", ["openship/a:bld_interrupted"], "project-a"),
    ]);

    expect(await reapProjectImages(h.project as Project)).toEqual({
      removed: 1,
      bytes: 100,
      skippedInUse: 1,
      errors: 0,
    });
    expect(h.resolve).toHaveBeenCalledWith("failed-first-build");
    expect([...state.inventory.keys()]).toEqual(["retryable", "in-use", "foreign"]);
    expect(state.pruneImages).not.toHaveBeenCalled();
  });

  it.each(["missing", "foreign-org", "foreign-project", "missing-active"])(
    "does not open an unverified fallback host (%s)",
    async (scenario) => {
      h.project.activeDeploymentId = scenario === "missing-active" ? "missing" : null;
      h.activeMissing = true;
      if (scenario !== "missing")
        h.latest = {
          id: "last-attempt",
          projectId: scenario === "foreign-project" ? "another-project" : h.project.id,
          organizationId: scenario === "foreign-org" ? "another-org" : "org",
          status: "failed",
          meta: {},
        } as Deployment;
      const state = daemon([image("orphan", ["openship/b:bld_interrupted"])]);

      expect(await reapProjectImages(h.project as Project)).toEqual({
        removed: 0,
        bytes: 0,
        skippedInUse: 0,
        errors: 0,
      });
      expect(h.resolve).not.toHaveBeenCalled();
      expect(state.remove).not.toHaveBeenCalled();
    },
  );

  it("does not invoke host-wide image prune after a registry-only deployment", async () => {
    const state = daemon([image("foreign", ["openship/a:bld_live"], "project-a")]);
    const result = await reapProjectImages(h.project as Project);

    expect(result).toEqual({ removed: 0, bytes: 0, skippedInUse: 0, errors: 0 });
    expect([...state.inventory.keys()]).toEqual(["foreign"]);
    // /images/prune sweeps containerd build/pull leases BEFORE label filtering,
    // even when the finished project has no locally built images at all.
    expect(state.pruneImages).not.toHaveBeenCalled();
    expect(state.remove).not.toHaveBeenCalled();
  });

  it("reclaims expired tags and dangling images once while preserving retained, foreign and in-use images", async () => {
    h.keep.add("sha256:retained-digest");
    h.keep.add("openship/b:bld_active");
    h.keep.add("openship/b:bld_pinned");
    const state = daemon([
      image("sha256:retained-digest"),
      image("active", ["openship/b:bld_active"]),
      image("pinned", ["openship/b:bld_pinned"]),
      image("expired", ["openship/b:bld_expired"]),
      image("dangling"),
      { ...image("in-use"), inUse: true },
      image("repurposed", ["openship/b:bld_old", "operator/keep:latest"]),
      image("foreign", [], "project-a"),
      image("base", ["alpine:3.20"], ""),
    ]);

    expect(await reapProjectImages(h.project as Project)).toEqual({
      removed: 3,
      bytes: 200,
      skippedInUse: 1,
      errors: 0,
    });
    expect([...state.inventory.keys()]).toEqual([
      "sha256:retained-digest",
      "active",
      "pinned",
      "in-use",
      "repurposed",
      "foreign",
      "base",
    ]);
    expect(state.inventory.get("repurposed")?.RepoTags).toEqual(["operator/keep:latest"]);
    expect(state.remove.mock.calls.map(([ref]) => ref)).toEqual([
      "openship/b:bld_expired",
      "dangling",
      "in-use",
      "openship/b:bld_old",
    ]);
    expect(state.pruneImages).not.toHaveBeenCalled();
  });
});
