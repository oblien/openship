import { describe, expect, it } from "vitest";
import { getBuildImage, getRuntimeImage } from "../src/stacks";

describe("Ruby image pinning", () => {
  it.each(["rails", "sinatra"] as const)("keeps %s build and runtime on the declared Ruby", (stack) => {
    const image = getBuildImage(stack, "bundler", "3.4.1");
    expect(image).toBe("ruby:3.4.1-slim");
    expect(getRuntimeImage(stack, "bundler", image)).toBe(image);
  });
  it.each([
    "ruby:3.4.1-slim", "ruby:3.3", "ruby:3.2.2-alpine3.20", "ruby:3.4-bookworm",
    "docker.io/library/ruby:3.4.1-alpine", "public.ecr.aws/docker/library/ruby:3.4.1",
    `ruby:3.4.1-slim@sha256:${"a".repeat(64)}`,
  ])("retains the full builder reference at runtime: %s", (image) => {
    expect(getRuntimeImage("rails", "bundler", image)).toBe(image);
  });
  it.each([undefined, null, "", "node:22", "acme/ruby:3.4.1", "ruby:3.4.1 && echo wrong", "ruby:3.4.1@oops"])(
    "keeps the default for absent or unrelated/invalid builder references: %s", (image) => {
      expect(getRuntimeImage("rails", "bundler", image)).toBe("ruby:3.3-slim");
    },
  );
  it("does not apply a Ruby pin to other languages", () => {
    expect(getBuildImage("nextjs", undefined, "3.4.1")).toBe("node:22");
    expect(getBuildImage("django", undefined, "3.4.1")).toBe("python:3.12-slim");
    expect(getRuntimeImage("nextjs", "bun", "ruby:3.4.1")).toBe("oven/bun:1.4.4");
  });
  it.each(["3.3-slim && echo wrong", "latest", "", "../../evil", "3", "3.4.1.5", "3.4.1-preview1"])(
    "rejects a nonnumeric detected pin: %s", (version) => {
      expect(getBuildImage("rails", undefined, version)).toBe("ruby:3.3-slim");
    },
  );
});
