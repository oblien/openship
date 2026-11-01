import { describe, expect, it } from "vitest";
import { bunBuildImage, declaredPackageManagerPin } from "../src/package-manager-version";
import { getBuildImage, getRuntimeImage } from "../src/stacks";

describe("declared package-manager versions", () => {
  it("uses the same explicit version for Bun build and runtime", () => {
    const image = bunBuildImage({ packageManager: "bun@1.2.10" });
    expect(image).toBe("oven/bun:1.2.10");
    expect(getRuntimeImage("nextjs", "bun", image)).toBe(image);
    expect(getBuildImage("nextjs", "bun")).toBe("oven/bun:1.4.4");
  });
  it("retains explicit official Bun image variants and digests", () => {
    const image = `docker.io/oven/bun:1.2.10-alpine@sha256:${"a".repeat(64)}`;
    expect(getRuntimeImage("node", "bun", image)).toBe(image);
    expect(getRuntimeImage("node", "bun", "untrusted.example/oven/bun:1.2.10")).toBe(
      "oven/bun:1.4.4",
    );
  });
  it("does not drop an unsupported Bun integrity constraint", () => {
    expect(() => bunBuildImage({ packageManager: `bun@1.2.10+sha256.${"a".repeat(64)}` })).toThrow(
      "integrity",
    );
  });
  it("honors explicit pins before devEngines fallback", () => {
    expect(
      declaredPackageManagerPin(
        {
          packageManager: "npm@10.9.2",
          devEngines: { packageManager: { name: "npm", version: "9.9.4" } },
        },
        "npm",
      ),
    ).toBe("npm@10.9.2");
  });
});
