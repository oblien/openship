import { describe, expect, it } from "vitest";

import { packageManagerEnsureCommand } from "../src/stacks";

describe("packageManagerEnsureCommand", () => {
  it("emits a corepack-enable prelude for pnpm and yarn (the PMs missing from base images)", () => {
    for (const pm of ["pnpm", "yarn"] as const) {
      const cmd = packageManagerEnsureCommand(pm);
      expect(cmd).toContain(`corepack enable ${pm}`);
      // Fallback chain: corepack-for-pm → corepack → global npm install.
      expect(cmd).toContain("|| corepack enable ||");
      expect(cmd).toContain(`npm i -g ${pm}`);
      // Fully swallowed so a missing corepack never fails the build.
      expect(cmd.endsWith("|| true")).toBe(true);
    }
  });

  it("emits a presence-check prelude for bun (corepack does not manage it)", () => {
    const cmd = packageManagerEnsureCommand("bun");
    // Checks first so the oven/bun image — which ships no npm — short-circuits
    // before the fallback can be reached.
    expect(cmd).toContain("command -v bun");
    expect(cmd.indexOf("command -v bun")).toBeLessThan(cmd.indexOf("npm i -g bun"));
    expect(cmd).toContain("npm i -g bun");
    expect(cmd.endsWith("|| true")).toBe(true);
    // corepack has no bun shim — asking it to enable one always fails.
    expect(cmd).not.toContain("corepack");
  });

  it("is a no-op for npm (present), unknown, and undefined", () => {
    for (const pm of ["npm", "go", "cargo", "pip", undefined] as const) {
      expect(packageManagerEnsureCommand(pm)).toBe("");
    }
  });
});
