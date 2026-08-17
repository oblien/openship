import { describe, expect, it } from "vitest";
import {
  applyReleasePreset,
  isReleasePresetId,
  prefixesFromPreset,
  RELEASE_PRESET_IDS,
  RELEASE_PRESETS,
} from "./release-presets";

describe("release presets", () => {
  it("exposes Laravel, static Next, Node, and Compose", () => {
    expect([...RELEASE_PRESET_IDS]).toEqual(["laravel", "next-static", "node", "compose"]);
  });

  it("Laravel declares staff/public prefixes and composer.lock", () => {
    expect(RELEASE_PRESETS.laravel.lockFiles).toContain("composer.lock");
    expect(prefixesFromPreset("laravel")).toEqual([
      { key: "staff", prefixes: ["apps/staff"] },
      { key: "public", prefixes: ["apps/public"] },
    ]);
    expect(applyReleasePreset("laravel").healthPath).toBe("/up");
  });

  it("unknown ids are not presets", () => {
    expect(isReleasePresetId("rails")).toBe(false);
    expect(prefixesFromPreset("rails")).toBeUndefined();
  });
});
