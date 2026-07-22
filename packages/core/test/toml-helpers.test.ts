import { describe, expect, it } from "vitest";

import { extractStringArrayFromSection } from "../src/workspaces/toml-helpers";

describe("extractStringArrayFromSection", () => {
  it("extracts workspace members", () => {
    const toml = `
[workspace]
members = ["pkg-a", "pkg-b"]
`;
    expect(extractStringArrayFromSection(toml, "workspace", "members")).toEqual([
      "pkg-a",
      "pkg-b",
    ]);
  });

  it("ignores values in later sections", () => {
    const toml = `
[workspace]
members = ["pkg-a"]

[dependencies]
members = ["should-not-appear"]
`;
    expect(extractStringArrayFromSection(toml, "workspace", "members")).toEqual(["pkg-a"]);
  });

  it("handles strings that end with an escaped backslash", () => {
    const toml = `
[workspace]
members = ["pkg\\\\"]
`;
    expect(extractStringArrayFromSection(toml, "workspace", "members")).toEqual(["pkg\\\\"]);
  });

  it("handles strings with an escaped backslash followed by a closing bracket", () => {
    const toml = `
[workspace]
members = ["pkg\\\\]name"]
`;
    expect(extractStringArrayFromSection(toml, "workspace", "members")).toEqual([
      "pkg\\\\]name",
    ]);
  });
});
