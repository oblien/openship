import { describe, it, expect } from "vitest";
import { COMPOSE_SENTINEL, isArtifactRef, isRealContainerRef, usableRef } from "./container-ref";

/**
 * `deployment.container_id` and `*.image_ref` are polymorphic columns: each can
 * hold a Docker container id, an image tag, the `compose` sentinel, or — for a
 * static deploy — a host DIRECTORY. Nothing in the schema says which, so every
 * consumer that picks a runtime VERB from one of those columns depends on these
 * predicates being right.
 *
 * `isArtifactRef` is the one that was missing. The teardown collector classified
 * by the RUNTIME's class instead of the ref's shape, so a static doc-root was
 * handed to `removeImage`, whose failure is not a 404 and therefore blocked
 * project deletion permanently (issue #640).
 */

describe("isArtifactRef", () => {
  it("recognises the directories a static deploy stores", () => {
    expect(isArtifactRef("/opt/openship/static/releases/dep_1")).toBe(true);
    expect(isArtifactRef("/opt/openship/static/.builds/bld_1-svc_1")).toBe(true);
  });

  it("never mistakes an image tag for a path", () => {
    // THE distinction: a tag may contain slashes but can never START with one.
    expect(isArtifactRef("openship/my-app:bld_1")).toBe(false);
    expect(isArtifactRef("ghcr.io/org/img:v1")).toBe(false);
    expect(isArtifactRef("postgres:16-alpine")).toBe(false);
  });

  it("never mistakes a container id for a path", () => {
    expect(isArtifactRef("3f1a9c2b4d5e6f70")).toBe(false);
  });

  it("answers false for the sentinel and for nothing at all", () => {
    // The sentinel is not a reference to anything, so it is not an artifact either
    // — it routes through `usableRef`, which is the single place that knows.
    expect(isArtifactRef(COMPOSE_SENTINEL)).toBe(false);
    expect(isArtifactRef(null)).toBe(false);
    expect(isArtifactRef(undefined)).toBe(false);
    expect(isArtifactRef("")).toBe(false);
    expect(isArtifactRef("   ")).toBe(false);
  });

  it("trims, because these values come out of stored columns", () => {
    expect(isArtifactRef("  /opt/openship/static/releases/dep_1  ")).toBe(true);
  });

  it("agrees with the other predicates on the same value", () => {
    const path = "/opt/openship/static/releases/dep_1";
    expect(usableRef(path)).toBe(path);
    // A path IS actionable — it is just actionable by `destroy`, not `removeImage`.
    expect(isRealContainerRef(path)).toBe(true);
  });
});
