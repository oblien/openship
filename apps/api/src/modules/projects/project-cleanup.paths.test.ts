/**
 * Code-release trees must never be collected or destroyed as Docker images.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/deployment-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/deployment-runtime")>();
  const { DockerRuntime } = await import("@repo/adapters");
  return {
    ...actual,
    resolveDeploymentRuntime: async () => ({
      runtime: Object.create(DockerRuntime.prototype) as never,
    }),
  };
});

const { collectDeploymentManifest } = await import("./project-cleanup.service");
const { seedDeployment, seedOrg, seedProject } = await import("../../../test/helpers/seed");

const TREE = "/var/lib/openship/mounted-releases/proj_x/releases/dep_rel";

describe("project cleanup of mounted release trees", () => {
  let project: Awaited<ReturnType<typeof seedProject>>;

  beforeEach(async () => {
    const org = await seedOrg();
    project = await seedProject(org.organizationId, { rollbackWindow: 1 });
  });

  it("collects a host-path imageRef as an artifact, never an image", async () => {
    const dep = await seedDeployment(project, {
      imageRef: TREE,
      meta: {
        deploymentLane: "release",
        artifactKind: "mounted-tree",
        mountedReleaseRoot: TREE,
      },
    });
    const manifest = await collectDeploymentManifest(dep, project, { protectRetained: false });
    expect(manifest.resources.some((r) => r.type === "image" && r.ref.startsWith("/"))).toBe(false);
    expect(manifest.resources.some((r) => r.type === "artifact" && r.ref === TREE)).toBe(true);
  });

  it("collects a null-imageRef tree from meta.mountedReleaseRoot", async () => {
    const dep = await seedDeployment(project, {
      imageRef: null,
      meta: {
        deploymentLane: "release",
        artifactKind: "mounted-tree",
        mountedReleaseRoot: TREE,
        mountedRelease: {
          artifactKind: "mounted-tree",
          config: { enabled: true, containerPath: "/srv" },
          sharedPaths: ["storage"],
          runtimeDeploymentId: "dep_rt",
          hostRoot: "/var/lib/openship/mounted-releases/proj_x",
          releaseDir: TREE,
        },
      },
    });
    const manifest = await collectDeploymentManifest(dep, project, { protectRetained: false });
    expect(manifest.resources.filter((r) => r.type === "image")).toEqual([]);
    expect(manifest.resources.some((r) => r.type === "artifact" && r.ref === TREE)).toBe(true);
  });
});
