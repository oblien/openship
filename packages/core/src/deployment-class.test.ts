import { describe, expect, it } from "vitest";

import {
  classNeedsGitSource,
  resolveDeploymentClass,
  resolveWorkload,
  toBuildKind,
  toSourceKind,
  toWorkloadType,
} from "./deployment-class";

/**
 * The canonical three-axis resolver (issue #538). The load-bearing guarantees:
 *   - explicit `*Kind` overrides win over derivation;
 *   - derivation reproduces the exact pre-#538 behaviour, so every legacy row /
 *     frozen snapshot classifies as it did before;
 *   - `worker` is reachable ONLY through an explicit `workloadType`.
 */

describe("resolveWorkload", () => {
  it("maps the legacy hasServer boolean: false → static, everything else → web", () => {
    expect(resolveWorkload(undefined, true)).toBe("web");
    expect(resolveWorkload(undefined, false)).toBe("static");
    // Unknown/absent hasServer defaults to web (the historical create default).
    expect(resolveWorkload(undefined, undefined)).toBe("web");
    expect(resolveWorkload(undefined, null)).toBe("web");
  });

  it("an explicit workloadType wins over hasServer", () => {
    expect(resolveWorkload("worker", true)).toBe("worker");
    expect(resolveWorkload("worker", false)).toBe("worker");
    expect(resolveWorkload("static", true)).toBe("static");
    expect(resolveWorkload("web", false)).toBe("web");
  });

  it("worker is unreachable from legacy flags alone", () => {
    // No combination of the legacy boolean produces a worker — it has never had
    // a legacy encoding, so every pre-#538 row is web or static, never worker.
    expect(resolveWorkload(null, true)).not.toBe("worker");
    expect(resolveWorkload(null, false)).not.toBe("worker");
  });

  it("ignores a garbage workloadType and falls back to the legacy derivation", () => {
    expect(resolveWorkload("bogus", true)).toBe("web");
    expect(resolveWorkload("", false)).toBe("static");
  });
});

describe("resolveDeploymentClass — workload axis", () => {
  it("derives from hasServer when no explicit workloadType", () => {
    expect(resolveDeploymentClass({ hasServer: true }).workload).toBe("web");
    expect(resolveDeploymentClass({ hasServer: false }).workload).toBe("static");
  });

  it("honours an explicit worker", () => {
    expect(resolveDeploymentClass({ workloadType: "worker", hasServer: true }).workload).toBe(
      "worker",
    );
  });
});

describe("resolveDeploymentClass — source axis", () => {
  it("a real clone URL is a git source regardless of build", () => {
    expect(resolveDeploymentClass({ gitUrl: "https://github.com/a/b.git" }).source).toBe("git");
    expect(
      resolveDeploymentClass({ gitUrl: "https://github.com/a/b.git", hasBuild: false }).source,
    ).toBe("git");
  });

  it("a git provider with no URL still classifies as git (github/gitlab/bitbucket/self-hosted)", () => {
    expect(resolveDeploymentClass({ gitProvider: "github" }).source).toBe("git");
    expect(resolveDeploymentClass({ gitProvider: "gitlab" }).source).toBe("git");
    expect(resolveDeploymentClass({ gitProvider: "self-hosted" }).source).toBe("git");
  });

  it("uploads and local dirs are not cloned", () => {
    expect(resolveDeploymentClass({ isUpload: true }).source).toBe("upload");
    expect(resolveDeploymentClass({ gitProvider: "local" }).source).toBe("upload");
    // A bare local path with no repo is staged, not cloned.
    expect(resolveDeploymentClass({ localPath: "/srv/app" }).source).toBe("upload");
    // Nothing at all → nothing to fetch (matches pre-#538 "no repoUrl").
    expect(resolveDeploymentClass({}).source).toBe("upload");
  });

  it("releases and prebuilt images are the image source", () => {
    expect(resolveDeploymentClass({ isRelease: true }).source).toBe("image");
    expect(resolveDeploymentClass({ gitProvider: "release" }).source).toBe("image");
    expect(resolveDeploymentClass({ hasImageArtifact: true }).source).toBe("image");
  });

  it("an explicit sourceKind overrides derivation", () => {
    expect(
      resolveDeploymentClass({ gitUrl: "https://github.com/a/b.git", sourceKind: "image" }).source,
    ).toBe("image");
  });
});

describe("resolveDeploymentClass — build axis", () => {
  it("a docker framework is always a dockerfile build", () => {
    expect(resolveDeploymentClass({ framework: "docker", gitUrl: "x" }).build).toBe("dockerfile");
    // Even with hasBuild=false (the detector default for docker) — this is #538-A.
    expect(
      resolveDeploymentClass({ framework: "docker", gitUrl: "x", hasBuild: false }).build,
    ).toBe("dockerfile");
  });

  it("an image source has nothing to build (prebuilt)", () => {
    expect(resolveDeploymentClass({ isRelease: true }).build).toBe("prebuilt");
    expect(resolveDeploymentClass({ hasImageArtifact: true }).build).toBe("prebuilt");
  });

  it("a static workload builds as static", () => {
    expect(resolveDeploymentClass({ gitUrl: "x", hasServer: false }).build).toBe("static");
    expect(resolveDeploymentClass({ gitUrl: "x", workloadType: "static" }).build).toBe("static");
  });

  it("a normal web app from git is a buildpack build", () => {
    expect(resolveDeploymentClass({ gitUrl: "x", hasServer: true }).build).toBe("buildpack");
  });

  it("an explicit buildKind overrides derivation", () => {
    expect(
      resolveDeploymentClass({ gitUrl: "x", hasServer: true, buildKind: "dockerfile" }).build,
    ).toBe("dockerfile");
  });
});

describe("classNeedsGitSource", () => {
  it("is true iff the source axis is git", () => {
    expect(classNeedsGitSource({ source: "git", build: "buildpack", workload: "web" })).toBe(true);
    expect(classNeedsGitSource({ source: "git", build: "dockerfile", workload: "worker" })).toBe(
      true,
    );
    expect(classNeedsGitSource({ source: "image", build: "prebuilt", workload: "web" })).toBe(
      false,
    );
    expect(classNeedsGitSource({ source: "upload", build: "static", workload: "static" })).toBe(
      false,
    );
  });
});

describe("narrowing helpers reject unknown values", () => {
  it("toWorkloadType", () => {
    expect(toWorkloadType("worker")).toBe("worker");
    expect(toWorkloadType("bogus")).toBeUndefined();
    expect(toWorkloadType(null)).toBeUndefined();
  });
  it("toSourceKind", () => {
    expect(toSourceKind("git")).toBe("git");
    expect(toSourceKind("nope")).toBeUndefined();
  });
  it("toBuildKind", () => {
    expect(toBuildKind("dockerfile")).toBe("dockerfile");
    expect(toBuildKind("nope")).toBeUndefined();
  });
});

describe("legacy row / pre-#538 snapshot fallback (missing triple → derive)", () => {
  it("a legacy web app row classifies web/git/buildpack", () => {
    expect(
      resolveDeploymentClass({
        gitUrl: "https://github.com/a/b.git",
        gitProvider: "github",
        hasServer: true,
        hasBuild: true,
      }),
    ).toEqual({ source: "git", build: "buildpack", workload: "web" });
  });

  it("a legacy static site row classifies static/git/static", () => {
    expect(
      resolveDeploymentClass({
        gitUrl: "https://github.com/a/b.git",
        hasServer: false,
      }),
    ).toEqual({ source: "git", build: "static", workload: "static" });
  });

  it("a legacy Dockerfile app row classifies web/git/dockerfile even with hasBuild=false", () => {
    expect(
      resolveDeploymentClass({
        gitUrl: "https://github.com/a/b.git",
        framework: "docker",
        hasServer: true,
        hasBuild: false,
      }),
    ).toEqual({ source: "git", build: "dockerfile", workload: "web" });
  });
});
