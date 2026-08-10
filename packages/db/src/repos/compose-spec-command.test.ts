import { describe, expect, it } from "vitest";
import { composeSpecDiff, composeSpecsEqual, toComposeSpec } from "./service.repo";

/**
 * #332 drift stability: adding structured `commandArgv` must NOT make a legacy
 * row (stored with only the text `command`, argv null) read as drift against its
 * re-parse (same command, argv populated). `toComposeSpec` derives argv from the
 * text command so both canonicalize identically. A genuine argv change still
 * surfaces.
 */
describe("compose command drift stability (#332)", () => {
  it("legacy text command ≡ re-parsed command+argv (no phantom drift)", () => {
    const legacy = toComposeSpec({ command: "serve --host 0.0.0.0" }); // argv null → derived
    const reparsed = toComposeSpec({
      command: "serve --host 0.0.0.0",
      commandArgv: ["serve", "--host", "0.0.0.0"],
    });
    expect(composeSpecsEqual(legacy, reparsed)).toBe(true);
    expect(composeSpecDiff(legacy, reparsed).some((c) => c.field === "command" || c.field === "commandArgv")).toBe(false);
  });

  it("a genuine argv change is still flagged", () => {
    const before = toComposeSpec({ command: "serve --host 0.0.0.0", commandArgv: ["serve", "--host", "0.0.0.0"] });
    const after = toComposeSpec({ command: "serve --host ::", commandArgv: ["serve", "--host", "::"] });
    expect(composeSpecsEqual(before, after)).toBe(false);
    expect(composeSpecDiff(before, after).some((c) => c.field === "command" || c.field === "commandArgv")).toBe(true);
  });

  it("args-with-spaces: a real representation difference the old join lost is caught", () => {
    // old join stored "a b" (argv null → derived ["a","b"]); a genuine list ["a b"]
    const derivedFromLegacy = toComposeSpec({ command: "a b" });
    const genuineSingleArg = toComposeSpec({ command: "a b", commandArgv: ["a b"] });
    expect(composeSpecsEqual(derivedFromLegacy, genuineSingleArg)).toBe(false);
  });

  it("null command ≡ null command", () => {
    expect(composeSpecsEqual(toComposeSpec({}), toComposeSpec({}))).toBe(true);
  });
});
