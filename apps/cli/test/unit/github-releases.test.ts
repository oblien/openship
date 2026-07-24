import { describe, expect, it } from "vitest";

import { assetUrl, RELEASES, REPO } from "../../src/lib/github-releases";

describe("github-releases constants", () => {
  it("points at the oblien/openship releases page", () => {
    expect(REPO).toBe("oblien/openship");
    expect(RELEASES).toBe("https://github.com/oblien/openship/releases");
  });
});

describe("assetUrl", () => {
  it("builds a release download URL from a tag + asset name", () => {
    expect(assetUrl("v1.2.3", "Openship-arm64.dmg")).toBe(
      "https://github.com/oblien/openship/releases/download/v1.2.3/Openship-arm64.dmg",
    );
  });
});
