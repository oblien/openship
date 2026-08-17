/**
 * Code-release trees must never be collected or destroyed as Docker images.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { repos } from "@repo/db";

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
const { mountedReleaseHostRoot } = await import("../deployments/mounted-release.config");
const { seedDeployment, seedOrg, seedProject } = await import("../../../test/helpers/seed");

describe("project cleanup of mounted release trees", () => {
  let project: Awaited<ReturnType<typeof seedProject>>;

  beforeEach(async () => {
    const org = await seedOrg();
    project = await seedProject(org.organizationId, { rollbackWindow: 1 });
  });

  it("collects a host-path imageRef as an artifact, never an image", async () => {
    const dep = await seedDeployment(project, {
      imageRef: null,
      meta: { deploymentLane: "release", artifactKind: "mounted-tree" },
    });
    const tree = `${mountedReleaseHostRoot(project.id)}/releases/${dep.id}`;
    await repos.deployment.updateStatus(dep.id, dep.status, {
      imageRef: tree,
      meta: { deploymentLane: "release", artifactKind: "mounted-tree", mountedReleaseRoot: tree },
    });
    const row = (await repos.deployment.findById(dep.id))!;
    const manifest = await collectDeploymentManifest(row, project, { protectRetained: false });
    expect(manifest.resources.some((r) => r.type === "image" && r.ref.startsWith("/"))).toBe(false);
    expect(manifest.resources.some((r) => r.type === "artifact" && r.ref === tree)).toBe(true);
  });

  it("collects a null-imageRef tree from meta.mountedReleaseRoot", async () => {
    const dep = await seedDeployment(project, {
      imageRef: null,
      meta: { deploymentLane: "release", artifactKind: "mounted-tree" },
    });
    const hostRoot = mountedReleaseHostRoot(project.id);
    const tree = `${hostRoot}/releases/${dep.id}`;
    await repos.deployment.updateStatus(dep.id, dep.status, {
      imageRef: null,
      meta: {
        deploymentLane: "release",
        artifactKind: "mounted-tree",
        mountedReleaseRoot: tree,
        mountedRelease: {
          artifactKind: "mounted-tree",
          config: { enabled: true, containerPath: "/srv" },
          sharedPaths: ["storage"],
          runtimeDeploymentId: "dep_rt",
          hostRoot,
          releaseDir: tree,
        },
      },
    });
    const row = (await repos.deployment.findById(dep.id))!;
    const manifest = await collectDeploymentManifest(row, project, { protectRetained: false });
    expect(manifest.resources.filter((r) => r.type === "image")).toEqual([]);
    expect(manifest.resources.some((r) => r.type === "artifact" && r.ref === tree)).toBe(true);
  });

  it("does not collect the project host root on cancel/cleanup", async () => {
    const hostRoot = mountedReleaseHostRoot(project.id);
    const dep = await seedDeployment(project, {
      status: "cancelled",
      imageRef: null,
      meta: {
        deploymentLane: "release",
        artifactKind: "mounted-tree",
        mountedReleaseRoot: hostRoot,
      },
    });
    const manifest = await collectDeploymentManifest(dep, project, { protectRetained: false });
    const refs = manifest.resources.map((r) => r.ref);
    expect(refs).not.toContain(hostRoot);
    expect(refs).not.toContain(`${hostRoot}/shared`);
    expect(refs).not.toContain(`${hostRoot}/current`);
    expect(refs).not.toContain(`${hostRoot}/releases`);
    expect(
      manifest.resources.some(
        (r) => r.type === "artifact" && r.ref === `${hostRoot}/releases/${dep.id}`,
      ),
    ).toBe(true);
  });
});
