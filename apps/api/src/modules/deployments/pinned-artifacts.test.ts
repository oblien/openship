import { describe, it, expect } from "vitest";
import {
  hasPinnedArtifacts,
  pinnedAppImage,
  pinnedImageForService,
  refreshAppDeploymentId,
  snapshotNeedsGitSource,
  withoutPinnedArtifacts,
} from "./pinned-artifacts";

describe("pinned artifact lookup", () => {
  const snapshot = {
    handoverImages: { web: "openship/app-web:bld_1", api: "  ", db: "postgres:16" },
    handoverAppImage: "openship/app:bld_1",
  };

  it("resolves a service's pinned image by NAME", () => {
    expect(pinnedImageForService(snapshot, "web")).toBe("openship/app-web:bld_1");
    expect(pinnedImageForService(snapshot, "db")).toBe("postgres:16");
  });

  it("treats blank / missing / unknown as not pinned", () => {
    expect(pinnedImageForService(snapshot, "api")).toBeUndefined();
    expect(pinnedImageForService(snapshot, "nope")).toBeUndefined();
    expect(pinnedImageForService(snapshot, null)).toBeUndefined();
    expect(pinnedImageForService(null, "web")).toBeUndefined();
    expect(pinnedAppImage({ handoverAppImage: " " })).toBeUndefined();
    expect(pinnedAppImage(undefined)).toBeUndefined();
  });

  it("reports whether anything at all is pinned", () => {
    expect(hasPinnedArtifacts(snapshot)).toBe(true);
    expect(hasPinnedArtifacts({ handoverImages: { web: "  " } })).toBe(false);
    expect(hasPinnedArtifacts({})).toBe(false);
    expect(hasPinnedArtifacts({ refreshAppDeploymentId: "dep_live" })).toBe(true);
  });

  it("strips both fields and leaves the rest of the snapshot alone", () => {
    const stripped = withoutPinnedArtifacts({
      ...snapshot,
      refreshAppDeploymentId: "dep_live",
      hasBuild: true,
    });
    expect(stripped).toEqual({ hasBuild: true });
  });

  it("normalizes the active deployment marker", () => {
    expect(refreshAppDeploymentId({ refreshAppDeploymentId: " dep_live " })).toBe("dep_live");
    expect(refreshAppDeploymentId({ refreshAppDeploymentId: " " })).toBeUndefined();
  });
});

describe("snapshotNeedsGitSource — the clone / token / GitHub-access gate", () => {
  const repo = "https://github.com/acme/app.git";

  it("single app: a git repo needs source normally, not when its image is pinned", () => {
    expect(snapshotNeedsGitSource({ repoUrl: repo, hasBuild: true })).toBe(true);
    expect(
      snapshotNeedsGitSource({ repoUrl: repo, hasBuild: true, handoverAppImage: "openship/app:1" }),
    ).toBe(false);
    expect(
      snapshotNeedsGitSource({
        repoUrl: repo,
        hasBuild: true,
        refreshAppDeploymentId: "dep_live",
      }),
    ).toBe(false);
  });

  it("#538-A: a Dockerfile app (hasBuild=false) STILL clones its git repo for build context", () => {
    // The bug: `hasBuild !== false` dropped the clone token for a docker stack,
    // whose detector-assigned hasBuild is false yet still needs the repo. The
    // clone decision is the SOURCE axis, independent of whether a build runs.
    expect(snapshotNeedsGitSource({ repoUrl: repo, framework: "docker", hasBuild: false })).toBe(
      true,
    );
    // Explicit source/build overrides reach the same answer.
    expect(snapshotNeedsGitSource({ source: "git", build: "dockerfile", hasBuild: false })).toBe(
      true,
    );
  });

  it("no git source (upload / local dir / release / image) needs no clone", () => {
    // A bare hasBuild flag with no repo signal is NOT a git source.
    expect(snapshotNeedsGitSource({ hasBuild: true })).toBe(false);
    expect(snapshotNeedsGitSource({ hasBuild: false })).toBe(false);
    // A staged local directory is not cloned.
    expect(snapshotNeedsGitSource({ localPath: "/srv/app", hasBuild: true })).toBe(false);
    // A folder upload is not cloned.
    expect(snapshotNeedsGitSource({ uploadWorkspaceId: "up_1", hasBuild: true })).toBe(false);
    // A release/dist tarball deploys verbatim.
    expect(snapshotNeedsGitSource({ releaseVersion: "1.2.3", hasBuild: true })).toBe(false);
    // An explicit image source is never cloned.
    expect(snapshotNeedsGitSource({ source: "image", repoUrl: repo })).toBe(false);
  });

  it("compose: a registry-image-only stack clones nothing", () => {
    expect(
      snapshotNeedsGitSource({
        composeServices: [{ name: "db" }, { name: "cache" }],
      }),
    ).toBe(false);
  });

  it("compose: a buildable service needs source unless it's pinned", () => {
    const services = [{ name: "web", build: "./web" }, { name: "db" }];
    expect(snapshotNeedsGitSource({ composeServices: services })).toBe(true);
    expect(
      snapshotNeedsGitSource({
        composeServices: services,
        handoverImages: { web: "openship/app-web:bld_1" },
      }),
    ).toBe(false);
  });

  it("compose: ONE unpinned buildable service is enough to need source", () => {
    expect(
      snapshotNeedsGitSource({
        composeServices: [
          { name: "web", build: "./web" },
          { name: "api", kind: "monorepo" },
        ],
        handoverImages: { web: "openship/app-web:bld_1" },
      }),
    ).toBe(true);
  });

  it("compose: disabled services don't force a clone", () => {
    expect(
      snapshotNeedsGitSource({
        composeServices: [
          { name: "web", build: "./web", enabled: false },
          { name: "db" },
        ],
      }),
    ).toBe(false);
  });

  it("compose: a monorepo sub-app or a dockerfile row counts as buildable", () => {
    expect(snapshotNeedsGitSource({ composeServices: [{ name: "app", kind: "monorepo" }] })).toBe(
      true,
    );
    expect(
      snapshotNeedsGitSource({ composeServices: [{ name: "app", dockerfile: "Dockerfile" }] }),
    ).toBe(true);
  });
});
