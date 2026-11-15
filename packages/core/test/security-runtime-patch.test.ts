import { describe, expect, it } from "vitest";
import { securityRuntimeImages } from "../src/updates/runtime-patch";
import { managedRuntimeImage } from "../src/runtime-image";

const bun = {
  runtime: "bun",
  currentVersion: "1.3.1",
  fixed: ">=1.4.4",
  buildImage: "oven/bun:1.3.1-alpine",
  runtimeImage: "oven/bun:1.3.1-alpine",
};
describe("security runtime image selection", () => {
  it("changes both Bun stages to a signed fixed version while retaining the distribution", () => {
    expect(securityRuntimeImages(bun)).toEqual({
      version: "1.4.4",
      buildImage: "oven/bun:1.4.4-alpine",
      runtimeImage: "oven/bun:1.4.4-alpine",
    });
  });
  it("uses the fixed range for the running Node major, including disjoint ranges", () => {
    expect(
      securityRuntimeImages({
        runtime: "node",
        currentVersion: "22.22.0",
        fixed: ">=22.23.4 <23 || >=24.22.1 <25 || >=26.12.1",
        buildImage: "docker.io/library/node:22-bookworm",
        runtimeImage: "node:22-bookworm-slim",
      }),
    ).toEqual({
      version: "22.23.4",
      buildImage: "node:22.23.4-bookworm",
      runtimeImage: "node:22.23.4-bookworm-slim",
    });
  });
  it("does not downgrade a saved newer runtime to the advisory minimum", () => {
    expect(securityRuntimeImages({ ...bun, runtimeImage: "oven/bun:1.5.0-alpine" })?.version).toBe(
      "1.5.0",
    );
  });
  it("does not silently cross major versions or change interpreters", () => {
    expect(securityRuntimeImages({ ...bun, fixed: ">=2.0.0" })).toBeNull();
    expect(securityRuntimeImages({ ...bun, runtimeImage: "oven/bun:2" })).toBeNull();
    expect(securityRuntimeImages({ ...bun, buildImage: "node:22" })).toBeNull();
  });
  it.each([
    "ghcr.io/customer/bun:1.3.1",
    "evil.test/oven/bun:1.3.1",
    "oven/bun:canary",
    "oven/bun:1.4.4-canary.1",
    "oven/bun:1.3.1;whoami",
  ])("never rewrites custom images or prerelease tags: %s", (runtimeImage) => {
    expect(securityRuntimeImages({ ...bun, runtimeImage })).toBeNull();
  });
  it("recognizes an exact managed version even after the builder pins its digest", () => {
    expect(
      managedRuntimeImage(`registry-1.docker.io/oven/bun:1.4.4-debian@sha256:${"a".repeat(64)}`),
    ).toMatchObject({ runtime: "bun", version: "1.4.4", variant: "-debian" });
    expect(managedRuntimeImage("oven/bun:1-alpine")?.version).toBeNull();
  });
});
