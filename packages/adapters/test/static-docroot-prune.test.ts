import { describe, it, expect } from "vitest";
import {
  builderContextRoot,
  isExcludedDocRootEntry,
  staticBuilderOutputPath,
} from "../src/runtime/docker-build-plan";
import type { BuildConfig } from "../src/types";

/**
 * When a static project's doc-root IS its build context, our own build inputs get
 * published as site content.
 *
 * The zero-build "just files, index.html at the root" project has
 * `outputDirectory: "."` (see the `static` stack), so `staticBuilderOutputPath`
 * resolves to `/workspace` — the very directory `COPY . /workspace` filled. The
 * build context is pruned by `.dockerignore` and THEN the generated recipe is
 * written into it, so the extracted tree carried `.dockerignore` and
 * `Dockerfile.openship…` (and a tracked `.git`) at their own public URLs.
 *
 * Worse than the leak: those files COUNT as content. A repo with an allowlist
 * `.dockerignore` (`*` + `!src`) extracted to a tree holding only the two build
 * files, which passed the "doc-root is non-empty" check and deployed green as a
 * site that 404s every request.
 */

const config = (over: Partial<BuildConfig> = {}): BuildConfig =>
  ({
    sessionId: "bld_1",
    projectId: "p1",
    buildImage: "node:22",
    outputDirectory: ".",
    envVars: {},
    ...over,
  }) as BuildConfig;

describe("builderContextRoot vs staticBuilderOutputPath", () => {
  it("are the SAME path for a zero-build static — this is the risky case", () => {
    const c = config({ outputDirectory: "." });
    expect(staticBuilderOutputPath(c)).toBe(builderContextRoot(c));
  });

  it("are the same for an empty output directory too", () => {
    const c = config({ outputDirectory: "" });
    expect(staticBuilderOutputPath(c)).toBe(builderContextRoot(c));
  });

  it("DIVERGE once there is a real output directory — nothing to prune there", () => {
    // A build writes `dist/`; our Dockerfile and .dockerignore are never in it, so
    // the prune must not even run (and a project's own `dist/Dockerfile`, however
    // unlikely, is left alone).
    const c = config({ outputDirectory: "dist" });
    expect(staticBuilderOutputPath(c)).toBe("/workspace/dist");
    expect(builderContextRoot(c)).toBe("/workspace");
    expect(staticBuilderOutputPath(c)).not.toBe(builderContextRoot(c));
  });

  it("tracks rootDirectory for a monorepo sub-app", () => {
    const c = config({ outputDirectory: ".", rootDirectory: "apps/site" });
    expect(staticBuilderOutputPath(c)).toBe("/workspace/apps/site");
    expect(staticBuilderOutputPath(c)).toBe(builderContextRoot(c));
  });
});

describe("isExcludedDocRootEntry", () => {
  it("excludes our build inputs", () => {
    expect(isExcludedDocRootEntry(".dockerignore")).toBe(true);
    expect(isExcludedDocRootEntry("Dockerfile")).toBe(true);
    // The single-app generated name and the compose batch builder's per-service one
    // (`Dockerfile.openship.<sessionId>`) must BOTH be caught.
    expect(isExcludedDocRootEntry("Dockerfile.openship")).toBe(true);
    expect(isExcludedDocRootEntry("Dockerfile.openship.bld_1")).toBe(true);
    expect(isExcludedDocRootEntry("Dockerfile.prod")).toBe(true);
  });

  it("excludes .git — a published repo is full source history at a public URL", () => {
    expect(isExcludedDocRootEntry(".git")).toBe(true);
  });

  it("keeps real site content, including near-misses", () => {
    for (const name of [
      "index.html",
      "about.html",
      "assets",
      "dockerfile",
      "MyDockerfile",
      "Dockerfiles",
      ".well-known",
      ".gitignore",
    ]) {
      expect(isExcludedDocRootEntry(name)).toBe(false);
    }
  });
});
