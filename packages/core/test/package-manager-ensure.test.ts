import { describe, expect, it } from "vitest";
import { packageManagerEnsureCommand } from "../src/stacks";

describe("packageManagerEnsureCommand", () => {
  it.each(["npm", "pnpm", "yarn", "bun"])(
    "uses the shared selection and verification contract for %s",
    (manager) => {
      const command = packageManagerEnsureCommand(manager);
      expect(command).toContain("Package-manager verification failed");
      expect(command).toContain("COREPACK_ENABLE_AUTO_PIN=0");
      expect(command).not.toContain("|| true");
      expect(command).not.toContain("\n");
    },
  );
  it("does not alter non-JavaScript package managers", () => {
    for (const manager of ["pip", "cargo", "go", "composer", undefined])
      expect(packageManagerEnsureCommand(manager)).toBe("");
  });
});
