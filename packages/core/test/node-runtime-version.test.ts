import { describe, it, expect } from "vitest";
import { nodeImageForEngine } from "../src/node-runtime-version";
describe("Node engine image selection", () => {
  it.each([
    [">=24", "node:24"],
    ["24.x", "node:24"],
    ["^24.2.0", "node:24.2"],
    ["24.2.1", "node:24.2.1"],
    [">=20", "node:22"],
    [">=24 <25", "node:24"],
    ["22 || 24", "node:22"],
    ["banana", "node:22"],
    ["24; echo nope", "node:22"],
  ])("selects a compatible tag for %s", (range, image) =>
    expect(nodeImageForEngine("node:22", range)).toBe(image),
  );
  it("keeps Bun, other languages and explicit variant tags unchanged", () => {
    for (const image of ["oven/bun:latest", "ruby:3.4", "node:22-alpine"])
      expect(nodeImageForEngine(image, ">=24")).toBe(image);
  });
});
