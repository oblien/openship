import { describe, expect, it } from "vitest";
import { getRuntimeImage } from "../src/stacks";

describe("Node runtime image pinning", () => {
  it.each(["node", "express", "nextjs"] as const)(
    "keeps the selected Node version for %s",
    (stack) => {
      expect(getRuntimeImage(stack, "npm", "node:24")).toBe("node:24");
    },
  );
  it.each([
    "node:24-bookworm",
    "node:24-alpine",
    "docker.io/library/node:24",
    `node:24@sha256:${"a".repeat(64)}`,
  ])("preserves the full image reference: %s", (image) => {
    expect(getRuntimeImage("node", "npm", image)).toBe(image);
  });
  it("keeps unrelated, invalid and Bun runtime selection unchanged", () => {
    for (const image of [undefined, "acme/node:24", "node:24 && echo wrong", "ruby:3.4"])
      expect(getRuntimeImage("node", "npm", image)).toBe("node:22");
    expect(getRuntimeImage("node", "bun", "node:24")).toBe("oven/bun:latest");
    expect(getRuntimeImage("static", "npm", "node:24")).toBe(getRuntimeImage("static", "npm"));
    expect(getRuntimeImage("django", "pip", "node:24")).toBe("python:3.12-slim");
  });
});
