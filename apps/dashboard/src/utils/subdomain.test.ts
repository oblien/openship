import { describe, expect, it } from "vitest";

import { normalizeSubdomain, normalizeSubdomainInput } from "./subdomain";

describe("normalizeSubdomain", () => {
  it("lowercases and hyphenates whitespace", () => {
    expect(normalizeSubdomain("My Project")).toBe("my-project");
  });

  it("falls back to the default when only symbols remain", () => {
    // "---" collapses to a single leading/trailing hyphen, which then gets
    // stripped entirely, leaving an empty string that must hit the fallback.
    expect(normalizeSubdomain("---")).toBe("project");
    expect(normalizeSubdomain("!!!")).toBe("project");
  });

  it("falls back to the default on an empty string", () => {
    expect(normalizeSubdomain("")).toBe("project");
  });

  it("honors a custom fallback argument", () => {
    expect(normalizeSubdomain("!!!", "custom")).toBe("custom");
  });

  it("strips non-ASCII characters as if they were separators", () => {
    // "é" is outside [a-z0-9], so it becomes a hyphen that then gets
    // trimmed off the end since nothing follows it.
    expect(normalizeSubdomain("café")).toBe("caf");
  });

  it("strips leading and trailing hyphens, unlike normalizeSubdomainInput", () => {
    expect(normalizeSubdomain("abc-")).toBe("abc");
  });
});

describe("normalizeSubdomainInput", () => {
  it("lowercases and collapses hyphen runs but does not trim ends", () => {
    expect(normalizeSubdomainInput("My Project")).toBe("my-project");
  });

  it("does not strip a trailing hyphen (differs from normalizeSubdomain)", () => {
    // This is the key behavioral split between the two functions: the
    // "input" variant is meant for live typing, so a trailing hyphen the
    // user just typed must survive instead of being eaten.
    expect(normalizeSubdomainInput("abc-")).toBe("abc-");
  });

  it("collapses a run of only hyphens down to one, with no fallback", () => {
    expect(normalizeSubdomainInput("---")).toBe("-");
  });

  it("has no fallback for symbol-only input, unlike normalizeSubdomain", () => {
    expect(normalizeSubdomainInput("!!!")).toBe("-");
  });

  it("returns an empty string unchanged for empty input", () => {
    expect(normalizeSubdomainInput("")).toBe("");
  });

  it("strips non-ASCII characters as if they were separators", () => {
    // Unlike normalizeSubdomain, the trailing hyphen this produces is kept
    // because normalizeSubdomainInput never strips leading/trailing hyphens.
    expect(normalizeSubdomainInput("café")).toBe("caf-");
  });
});
