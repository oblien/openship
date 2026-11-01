import { describe, expect, it } from "vitest";
import { getRuntimeImage } from "../src/stacks";

describe("Node runtime image pinning", () => {
  it("keeps a selected toolchain for an undetected app without changing static or Docker defaults", () => {
    const image = `node:22-bookworm-slim@sha256:${"b".repeat(64)}`;
    expect(getRuntimeImage("unknown", "npm", image)).toBe(image);
    expect(getRuntimeImage("unknown", "npm", "node:22 && echo bad")).toBe("ubuntu:22.04");
    expect(getRuntimeImage("docker", "npm", image)).toBe(getRuntimeImage("docker", "npm"));
  });
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
    `node@sha256:${"a".repeat(64)}`,
    `node:24@sha256:${"a".repeat(64)}`,
  ])("preserves the full image reference: %s", (image) => {
    expect(getRuntimeImage("node", "npm", image)).toBe(image);
  });
  it("keeps unrelated, invalid and Bun runtime selection unchanged", () => {
    for (const image of [
      undefined,
      "acme/node:24",
      "registry.example/node:24",
      "acme/library/node:24",
      "node:24 && echo wrong",
      "ruby:3.4",
    ])
      expect(getRuntimeImage("node", "npm", image)).toBe("node:22");
    expect(getRuntimeImage("node", "bun", "node:24")).toBe("oven/bun:1.4.4");
    expect(getRuntimeImage("static", "npm", "node:24")).toBe(getRuntimeImage("static", "npm"));
    expect(getRuntimeImage("django", "pip", "node:24")).toBe("python:3.12-slim");
  });
});
