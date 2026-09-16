import { describe, expect, it } from "vitest";

import { getBuildImage, getRuntimeImage, runtimeVersionFromImage } from "../src/stacks";

describe("Ruby image pinning", () => {
  it("uses the language default when the project pins nothing", () => {
    expect(getBuildImage("rails")).toBe("ruby:3.3-slim");
    expect(getRuntimeImage("rails")).toBe("ruby:3.3-slim");
  });

  it("pins the project's Ruby when one was detected", () => {
    expect(getBuildImage("rails", undefined, "3.4.1")).toBe("ruby:3.4.1-slim");
    expect(getRuntimeImage("rails", undefined, "3.4.1")).toBe("ruby:3.4.1-slim");
  });

  it("keeps build and runtime on the SAME tag", () => {
    // Bundler installs into a version-scoped path under BUNDLE_PATH, so a
    // runtime on a different Ruby finds no gems at all.
    expect(getBuildImage("rails", undefined, "3.2.2")).toBe(
      getRuntimeImage("rails", undefined, "3.2.2"),
    );
  });

  it("applies to sinatra too — it is the language, not the stack", () => {
    expect(getBuildImage("sinatra", undefined, "3.4.1")).toBe("ruby:3.4.1-slim");
  });

  it("ignores a version override for a non-Ruby stack", () => {
    expect(getBuildImage("nextjs", undefined, "3.4.1")).toBe("node:22");
    expect(getBuildImage("django", undefined, "3.4.1")).toBe("python:3.12-slim");
  });

  it("rejects anything that is not a plain X.Y[.Z]", () => {
    // The value comes from a file in the repo being deployed, so it is
    // attacker-controlled input to an image reference.
    for (const bad of ["3.3-slim && rm -rf /", "latest", "", "../../evil", "3"]) {
      expect(getBuildImage("rails", undefined, bad)).toBe("ruby:3.3-slim");
    }
  });
});

describe("runtimeVersionFromImage", () => {
  it("reads the version back out of a pinned Ruby image", () => {
    expect(runtimeVersionFromImage("ruby:3.4.1-slim")).toBe("3.4.1");
    expect(runtimeVersionFromImage("ruby:3.3-slim")).toBe("3.3");
  });

  it("returns undefined for a non-Ruby image or no image", () => {
    expect(runtimeVersionFromImage("node:22")).toBeUndefined();
    expect(runtimeVersionFromImage(undefined)).toBeUndefined();
    expect(runtimeVersionFromImage(null)).toBeUndefined();
    expect(runtimeVersionFromImage("")).toBeUndefined();
  });

  it("round-trips, so a stored buildImage can pin the runtime to match", () => {
    // This is how the deploy path keeps the two in lockstep: buildImage is
    // persisted on the project, runtimeImage is recomputed from it.
    const built = getBuildImage("rails", undefined, "3.4.1");
    expect(getRuntimeImage("rails", undefined, runtimeVersionFromImage(built))).toBe(built);
  });
});
