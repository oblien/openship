import { describe, expect, it } from "vitest";

import { buildNodeMaxOldSpaceMb, withBuildNodeOptions } from "../src/constants";

describe("buildNodeMaxOldSpaceMb", () => {
  it("derives 6144 from the default 8 GB build RAM", () => {
    expect(buildNodeMaxOldSpaceMb(8192)).toBe(6144);
  });

  it("floors at 2048 even when RAM is small", () => {
    expect(buildNodeMaxOldSpaceMb(1024)).toBe(2048);
    expect(buildNodeMaxOldSpaceMb(512)).toBe(2048);
  });

  it("leaves 512 MB headroom when that binds before the 75% ratio", () => {
    // 3000 * 0.75 = 2250, but 3000 - 512 = 2488 → min is 2250, then floor 2048 → 2250
    expect(buildNodeMaxOldSpaceMb(3000)).toBe(2250);
  });

  it("treats non-positive / NaN as a 2048 MB baseline", () => {
    expect(buildNodeMaxOldSpaceMb(0)).toBe(2048);
    expect(buildNodeMaxOldSpaceMb(-1)).toBe(2048);
    expect(buildNodeMaxOldSpaceMb(Number.NaN)).toBe(2048);
  });
});

describe("withBuildNodeOptions", () => {
  it("sets NODE_OPTIONS when absent", () => {
    expect(withBuildNodeOptions({ CI: "true" }, 8192)).toEqual({
      CI: "true",
      NODE_OPTIONS: "--max-old-space-size=6144",
    });
  });

  it("preserves an existing --max-old-space-size", () => {
    const env = { NODE_OPTIONS: "--max-old-space-size=4096 --no-warnings" };
    expect(withBuildNodeOptions(env, 8192)).toEqual(env);
  });

  it("preserves space-separated --max-old-space-size form", () => {
    const env = { NODE_OPTIONS: "--max-old-space-size 3072" };
    expect(withBuildNodeOptions(env, 8192)).toEqual(env);
  });

  it("appends the flag when other NODE_OPTIONS are present", () => {
    expect(withBuildNodeOptions({ NODE_OPTIONS: "--no-warnings" }, 8192)).toEqual({
      NODE_OPTIONS: "--no-warnings --max-old-space-size=6144",
    });
  });
});
