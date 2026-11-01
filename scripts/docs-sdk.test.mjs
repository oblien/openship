import { describe, expect, test } from "bun:test";
import { sdkSurface } from "./docs-surface.mjs";

describe("public SDK documentation inventory", () => {
  test("includes remote-only operations once and keeps shared operations on both surfaces", () => {
    const groups = sdkSurface();
    const method = (group, name) =>
      groups.find((item) => item.group === group)?.methods.find((item) => item.name === name);
    expect(method("projects", "get")?.surfaces).toEqual(["native", "remote"]);
    expect(method("mail", "renewCertificate")?.surfaces).toEqual(["remote"]);
    expect(method("migrations", "cutover")?.surfaces).toEqual(["remote"]);
    expect(method("instance", "exportData")?.surfaces).toEqual(["remote"]);
    expect(method("terminal", "openService")?.surfaces).toEqual(["remote"]);
    const keys = groups.flatMap((group) =>
      group.methods.map((entry) => `${group.group}.${entry.name}`),
    );
    expect(new Set(keys).size).toBe(keys.length);
    expect(groups.some((group) => group.group === "http" || group.group === "options")).toBe(false);
  }, 30_000);
});
