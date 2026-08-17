import { describe, expect, it } from "vitest";
import { ValidationError } from "./errors";
import { parseReleaseManifest } from "./release-manifest";

const valid = {
  version: 1,
  projectId: "proj_1",
  deploymentId: "dep_1",
  source: "local-upload",
  sha256: "a".repeat(64),
  sharedPaths: ["storage"],
  steps: [{ command: "true" }],
};

describe("parseReleaseManifest", () => {
  it("allowlists a versioned agent payload", () => {
    expect(parseReleaseManifest(valid)).toEqual({
      ...valid,
      sha256: "a".repeat(64),
    });
  });

  it("accepts a sha256: prefix and drops unknown keys", () => {
    const parsed = parseReleaseManifest({
      ...valid,
      sha256: `sha256:${"b".repeat(64)}`,
      cloneToken: "nope",
    });
    expect(parsed.sha256).toBe("b".repeat(64));
    expect(parsed).not.toHaveProperty("cloneToken");
  });

  it("refuses a bad digest or source", () => {
    expect(() => parseReleaseManifest({ ...valid, sha256: "short" })).toThrow(ValidationError);
    expect(() => parseReleaseManifest({ ...valid, source: "cloud" })).toThrow(ValidationError);
    expect(() => parseReleaseManifest({ ...valid, version: 2 })).toThrow(ValidationError);
  });
});
