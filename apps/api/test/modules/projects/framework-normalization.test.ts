import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { FrameworkEnum } from "../../../src/modules/projects/project.schema";

describe("FrameworkEnum schema boundary normalization", () => {
  it("decodes raw framework labels like 'Static Site' to canonical stack IDs", () => {
    const decoded = Value.Decode(FrameworkEnum, "Static Site");
    expect(decoded).toBe("static");
  });

  it("decodes 'Next.js' to 'nextjs'", () => {
    const decoded = Value.Decode(FrameworkEnum, "Next.js");
    expect(decoded).toBe("nextjs");
  });

  it("passes through canonical stack IDs unchanged", () => {
    const decoded = Value.Decode(FrameworkEnum, "static");
    expect(decoded).toBe("static");
  });
});
