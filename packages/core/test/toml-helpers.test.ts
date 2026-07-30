import { describe, expect, it } from "vitest";

import { extractStringArrayFromSection } from "../src/workspaces/toml-helpers";

describe("extractStringArrayFromSection", () => {
  it("extracts workspace members", () => {
    const toml = `
[workspace]
members = ["pkg-a", "pkg-b"]
`;
    expect(extractStringArrayFromSection(toml, "workspace", "members")).toEqual(["pkg-a", "pkg-b"]);
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
    expect(extractStringArrayFromSection(toml, "workspace", "members")).toEqual(["pkg\\\\]name"]);
  });

  it("ignores an apostrophe inside a comment", () => {
    const toml = `
[workspace]
members = [
  "pkg-a",  # don't put binaries here
  "pkg-b",
]
`;
    expect(extractStringArrayFromSection(toml, "workspace", "members")).toEqual(["pkg-a", "pkg-b"]);
  });

  it("ignores a closing bracket inside a comment", () => {
    const toml = `
[workspace]
members = [
  "pkg-a", # see docs] for details
  "pkg-b",
]
`;
    expect(extractStringArrayFromSection(toml, "workspace", "members")).toEqual(["pkg-a", "pkg-b"]);
  });

  it("does not collect quoted text inside a comment as a member", () => {
    const toml = `
[workspace]
members = [
  "pkg-a", # use "pkg-c" instead
  "pkg-b",
]
`;
    expect(extractStringArrayFromSection(toml, "workspace", "members")).toEqual(["pkg-a", "pkg-b"]);
  });

  it("keeps a # that is part of a string value", () => {
    const toml = `
[workspace]
members = ["pkg-a#1", "pkg[extra]#2"]
`;
    expect(extractStringArrayFromSection(toml, "workspace", "members")).toEqual([
      "pkg-a#1",
      "pkg[extra]#2",
    ]);
  });

  it("handles a comment-only line and a trailing comment", () => {
    const toml = `
[workspace]
members = [
  # "pkg-disabled" is commented out
  "pkg-a",
] # trailing
`;
    expect(extractStringArrayFromSection(toml, "workspace", "members")).toEqual(["pkg-a"]);
  });

  it("returns [] when a comment runs to EOF with the array unterminated", () => {
    const toml = `
[workspace]
members = [
  "pkg-a", # oops`;
    expect(extractStringArrayFromSection(toml, "workspace", "members")).toEqual([]);
  });
});
