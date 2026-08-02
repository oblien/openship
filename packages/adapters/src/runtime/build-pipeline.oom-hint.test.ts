import { describe, expect, it } from "vitest";

import { detectBuildKillHint } from "./build-pipeline";

describe("detectBuildKillHint", () => {
  it("returns a NODE_OPTIONS hint for JavaScript heap OOM", () => {
    const hint = detectBuildKillHint(
      "FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory",
    );
    expect(hint).toContain("JavaScript heap memory");
    expect(hint).toContain("NODE_OPTIONS=--max-old-space-size=6144");
  });

  it("returns the generic kill hint for kernel OOM", () => {
    const hint = detectBuildKillHint("npm ERR! Killed\nCommand failed");
    expect(hint).toContain("ran out of memory during the build");
    expect(hint).not.toContain("NODE_OPTIONS");
  });

  it("returns null when there is no OOM signature", () => {
    expect(detectBuildKillHint("npm ERR! Missing script: build")).toBeNull();
    expect(detectBuildKillHint("")).toBeNull();
  });
});
