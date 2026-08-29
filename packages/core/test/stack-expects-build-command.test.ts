import { describe, expect, it } from "vitest";

import { STACKS, stackExpectsBuildCommand, type StackDefinition, type StackId } from "../src/stacks";

/**
 * Preflight warns when a project has `hasBuild` on but no build command. That's
 * only meaningful for a stack that HAS a build step — and the registry already
 * says which those are, so this predicate reads it instead of carrying a list.
 */
describe("stackExpectsBuildCommand", () => {
  it("is TRUE for stacks that declare a build step", () => {
    for (const id of ["nextjs", "vite", "django", "go", "rails", "springboot"] as const) {
      expect(stackExpectsBuildCommand(id), id).toBe(true);
    }
  });

  it("is FALSE for stacks that install and run", () => {
    // Express/Hono/node have no build step at all.
    for (const id of ["express", "hono", "koa", "node"] as const) {
      expect(stackExpectsBuildCommand(id), id).toBe(false);
    }
  });

  it("is FALSE for PHP: composer is the INSTALL step, the build step is optional assets", () => {
    expect(stackExpectsBuildCommand("laravel")).toBe(false);
    expect(stackExpectsBuildCommand("symfony")).toBe(false);
  });

  it("is FALSE for a Dockerfile project — its build lives in the repo's own image", () => {
    expect(stackExpectsBuildCommand("docker")).toBe(false);
  });

  it("is FALSE (never throws) for empty / unknown frameworks", () => {
    expect(stackExpectsBuildCommand(undefined)).toBe(false);
    expect(stackExpectsBuildCommand(null)).toBe(false);
    expect(stackExpectsBuildCommand("")).toBe(false);
    expect(stackExpectsBuildCommand("totally-made-up")).toBe(false);
  });

  it("tracks the registry, so a new stack needs no change here", () => {
    for (const id of Object.keys(STACKS) as StackId[]) {
      const declared = !!(STACKS[id] as StackDefinition).defaultBuildCommand;
      expect(stackExpectsBuildCommand(id), id).toBe(declared);
    }
  });
});
