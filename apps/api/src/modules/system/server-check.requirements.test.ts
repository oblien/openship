import { describe, expect, it } from "vitest";
import { resolveRequiredComponents } from "./server-check.requirements";

describe("remote server requirements", () => {
  it("requires Docker even when the control plane runs in bare mode", () => {
    expect(resolveRequiredComponents()).toEqual(["docker", "git"]);
  });
});
