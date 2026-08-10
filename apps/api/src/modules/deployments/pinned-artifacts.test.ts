import { describe, it, expect } from "vitest";
import {
  hasPinnedArtifacts,
  pinnedAppImage,
  pinnedImageForService,
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
  });

  it("strips both fields and leaves the rest of the snapshot alone", () => {
    const stripped = withoutPinnedArtifacts({ ...snapshot, hasBuild: true });
    expect(stripped).toEqual({ hasBuild: true });
  });
});

describe("snapshotNeedsGitSource — the clone / token / GitHub-access gate", () => {
  it("single app: needs source normally, not when its image is pinned", () => {
    expect(snapshotNeedsGitSource({ hasBuild: true })).toBe(true);
    expect(snapshotNeedsGitSource({ hasBuild: true, handoverAppImage: "openship/app:1" })).toBe(
      false,
    );
  });

  it("single app with the build disabled needs no source either way", () => {
    expect(snapshotNeedsGitSource({ hasBuild: false })).toBe(false);
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
