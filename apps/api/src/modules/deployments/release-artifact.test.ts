import { describe, expect, it } from "vitest";
import type { Deployment } from "@repo/db";
import {
  classifyMountedReleaseHostPath,
  cleanupUsesRemoveImage,
  dockerImageGcRef,
  freezeMountedReleaseContract,
  isFilesystemArtifactRef,
  isMountedReleaseRow,
  isProtectedMountedReleaseFilesystem,
  isProtectedMountedReleasePath,
  isSingleReleaseTree,
  markReleaseTreeReadOnlyCommand,
  mountedReleaseTreeRef,
  readMountedReleaseSnapshot,
  retainedMountedReleaseIds,
  stagedReleaseCleanupPaths,
} from "./release-artifact";
import { mountedReleaseVolume } from "./mounted-release.config";

const asDep = (row: Partial<Deployment>) => row as Deployment;

const hostRoot = "/var/lib/openship/mounted-releases/proj_1";
const releaseDir = `${hostRoot}/releases/dep_new`;

const baseConfig = {
  enabled: true,
  serviceId: "svc_app",
  serviceName: "app",
  containerPath: "/srv/app",
  sharedPaths: ["storage"],
  reloadCommand: "kill -HUP 1",
  healthPath: "/health",
  healthPort: 8080,
  retain: 3,
};

describe("release filesystem typing", () => {
  it("treats host paths as trees, not Docker images", () => {
    expect(isFilesystemArtifactRef(releaseDir)).toBe(true);
    expect(isFilesystemArtifactRef("openship/app:bld_1")).toBe(false);
    expect(cleanupUsesRemoveImage("image", releaseDir)).toBe(false);
    expect(cleanupUsesRemoveImage("image", "openship/app:bld_1")).toBe(true);
    expect(cleanupUsesRemoveImage("artifact", releaseDir)).toBe(false);
  });

  it("does not expose a path or release-lane row to image GC", () => {
    const pathRow = asDep({
      id: "dep_path",
      imageRef: releaseDir,
      meta: { deploymentLane: "runtime" },
    });
    const laneRow = asDep({
      id: "dep_rel",
      imageRef: "openship/app:bld_1",
      meta: { deploymentLane: "release", artifactKind: "mounted-tree" },
    });
    expect(dockerImageGcRef(pathRow)).toBeNull();
    expect(dockerImageGcRef(laneRow)).toBeNull();
    expect(dockerImageGcRef(laneRow, "openship/app:bld_1")).toBeNull();
    expect(
      dockerImageGcRef(asDep({ id: "dep_img", imageRef: "openship/app:bld_1", meta: {} })),
    ).toBe("openship/app:bld_1");
  });

  it("resolves the tree from meta even when imageRef is null", () => {
    const dep = asDep({
      id: "dep_new",
      imageRef: null,
      meta: {
        deploymentLane: "release",
        artifactKind: "mounted-tree",
        mountedReleaseRoot: releaseDir,
      },
    });
    expect(isMountedReleaseRow(dep)).toBe(true);
    expect(mountedReleaseTreeRef(dep)).toBe(releaseDir);
  });

  it("never treats the project host root as this row's tree", () => {
    const dep = asDep({
      id: "dep_new",
      imageRef: null,
      meta: {
        deploymentLane: "release",
        artifactKind: "mounted-tree",
        mountedReleaseRoot: hostRoot,
      },
    });
    expect(isSingleReleaseTree(hostRoot)).toBe(false);
    expect(isSingleReleaseTree(releaseDir, "dep_new")).toBe(true);
    expect(isProtectedMountedReleaseFilesystem(hostRoot)).toBe(true);
    expect(isProtectedMountedReleaseFilesystem(`${hostRoot}/shared`)).toBe(true);
    expect(isProtectedMountedReleaseFilesystem(`${hostRoot}/current`)).toBe(true);
    expect(isProtectedMountedReleaseFilesystem(`${hostRoot}/releases`)).toBe(true);
    expect(isProtectedMountedReleaseFilesystem(releaseDir)).toBe(false);
    expect(mountedReleaseTreeRef(dep)).toBeNull();
    expect(mountedReleaseTreeRef(asDep({ id: "dep_new", imageRef: hostRoot, meta: {} }))).toBeNull();
    expect(() => markReleaseTreeReadOnlyCommand(hostRoot)).toThrow();
  });
});

describe("mounted release contract snapshot", () => {
  it("freezes config so later project edits are ignored", () => {
    const live = { ...baseConfig, sharedPaths: ["storage"] };
    const frozen = freezeMountedReleaseContract({
      config: live,
      commitSha: "abc123",
      lockHashes: { "composer.lock": "aa".repeat(32) },
      artifactSource: "local-upload",
      artifactSha256: "bb".repeat(32),
      runtimeDeploymentId: "dep_runtime",
      hostRoot,
      releaseDir,
    });
    live.reloadCommand = "systemctl reload php";
    live.healthPort = 9999;
    live.sharedPaths!.push("cache");
    live.serviceId = "svc_other";

    expect(frozen.config.reloadCommand).toBe("kill -HUP 1");
    expect(frozen.reloadCommand).toBe("kill -HUP 1");
    expect(frozen.healthPort).toBe(8080);
    expect(frozen.sharedPaths).toEqual(["storage"]);
    expect(frozen.serviceId).toBe("svc_app");
    expect(frozen.config.serviceId).toBe("svc_app");

    const dep = asDep({
      meta: { mountedRelease: frozen, deploymentLane: "release", artifactKind: "mounted-tree" },
    });
    const read = readMountedReleaseSnapshot(dep);
    expect(read?.reloadCommand).toBe("kill -HUP 1");
    expect(read?.sharedPaths).toEqual(["storage"]);
    expect(read?.runtimeDeploymentId).toBe("dep_runtime");
    expect(read?.lockHashes).toEqual({ "composer.lock": "aa".repeat(32) });
    expect(read?.artifactSource).toBe("local-upload");
    expect(read?.artifactSha256).toBe("bb".repeat(32));
  });
});

describe("activation chmod and failed-tree cleanup", () => {
  it("marks only the release tree read-only and leaves shared writable", () => {
    const cmd = markReleaseTreeReadOnlyCommand(releaseDir);
    expect(cmd).toContain(releaseDir);
    expect(cmd).toMatch(/chmod -R a-w /);
    expect(cmd).not.toContain(`${hostRoot} `);
    expect(isProtectedMountedReleasePath(hostRoot, `${hostRoot}/shared`)).toBe(true);
    expect(isProtectedMountedReleasePath(hostRoot, `${hostRoot}/shared/uploads`)).toBe(true);
    expect(
      mountedReleaseVolume({
        id: "proj_1",
        mountedRelease: { enabled: true, containerPath: "/srv/app" },
      } as never),
    ).not.toMatch(/:ro$/);
  });

  it("removes a failed tree plus incoming and auth dirs", () => {
    expect(
      stagedReleaseCleanupPaths({
        ready: false,
        incoming: `${hostRoot}/.incoming-dep_new`,
        authDir: `${hostRoot}/.auth-dep_new`,
        releaseDir,
      }),
    ).toEqual([`${hostRoot}/.incoming-dep_new`, `${hostRoot}/.auth-dep_new`, releaseDir]);
    expect(
      stagedReleaseCleanupPaths({
        ready: true,
        incoming: `${hostRoot}/.incoming-dep_new`,
        authDir: `${hostRoot}/.auth-dep_new`,
        releaseDir,
      }),
    ).toEqual([`${hostRoot}/.incoming-dep_new`, `${hostRoot}/.auth-dep_new`]);
  });
});

describe("periodic host sweep", () => {
  it("drops leftover incoming/auth and unused trees; never shared or retained", () => {
    const keep = retainedMountedReleaseIds({
      readyNewestFirst: [
        asDep({ id: "dep_new", pinned: false, meta: { deploymentLane: "release" } }),
        asDep({ id: "dep_old", pinned: false, meta: { deploymentLane: "release" } }),
        asDep({ id: "dep_pin", pinned: true, meta: { deploymentLane: "release" } }),
      ],
      activeReleaseId: "dep_new",
      inFlightIds: ["dep_building"],
      retain: 1,
    });
    expect(keep.has("dep_new")).toBe(true);
    expect(keep.has("dep_pin")).toBe(true);
    expect(keep.has("dep_building")).toBe(true);
    expect(keep.has("dep_old")).toBe(false);

    expect(classifyMountedReleaseHostPath(hostRoot, `${hostRoot}/.incoming-dep_old`, keep)).toBe(
      "remove",
    );
    expect(classifyMountedReleaseHostPath(hostRoot, `${hostRoot}/.auth-dep_building`, keep)).toBe(
      "keep",
    );
    expect(classifyMountedReleaseHostPath(hostRoot, `${hostRoot}/releases/dep_old`, keep)).toBe(
      "remove",
    );
    expect(classifyMountedReleaseHostPath(hostRoot, `${hostRoot}/releases/dep_new`, keep)).toBe(
      "keep",
    );
    expect(classifyMountedReleaseHostPath(hostRoot, `${hostRoot}/shared`, keep)).toBe("keep");
    expect(classifyMountedReleaseHostPath(hostRoot, `${hostRoot}/builder-cache`, keep)).toBe("keep");
    expect(classifyMountedReleaseHostPath(hostRoot, `${hostRoot}/current`, keep)).toBe("keep");
    expect(classifyMountedReleaseHostPath(hostRoot, hostRoot, keep)).toBe("keep");
    expect(classifyMountedReleaseHostPath(hostRoot, `${hostRoot}/releases`, keep)).toBe("keep");
  });
});
