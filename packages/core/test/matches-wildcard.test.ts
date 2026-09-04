import { describe, it, expect } from "vitest";
import { matchesWildcard } from "../src/utils";

describe("matchesWildcard", () => {
  it("matches exact strings case-insensitively by default", () => {
    expect(matchesWildcard("main", "main")).toBe(true);
    expect(matchesWildcard("MAIN", "main")).toBe(true);
    expect(matchesWildcard("main", "develop")).toBe(false);
  });

  it("handles case-sensitive flag when specified", () => {
    expect(matchesWildcard("main", "MAIN", true)).toBe(false);
    expect(matchesWildcard("Main", "Main", true)).toBe(true);
  });

  it("handles * wildcard at end", () => {
    expect(matchesWildcard("v*", "v1.0.0")).toBe(true);
    expect(matchesWildcard("v*", "V2.3.4")).toBe(true);
    expect(matchesWildcard("v*", "1.0.0")).toBe(false);
    expect(matchesWildcard("release/*", "release/v1.0.0")).toBe(true);
    expect(matchesWildcard("release/*", "main")).toBe(false);
  });

  it("handles * wildcard at start", () => {
    expect(matchesWildcard("*-prod", "site-prod")).toBe(true);
    expect(matchesWildcard("*-prod", "site-staging")).toBe(false);
  });

  it("handles * in the middle", () => {
    expect(matchesWildcard("release-*-final", "release-v1.0-final")).toBe(true);
    expect(matchesWildcard("release-*-final", "release-v1.0-beta")).toBe(false);
  });

  it("handles standalone * wildcard matching everything", () => {
    expect(matchesWildcard("*", "anything")).toBe(true);
    expect(matchesWildcard("*", "v1.2.3")).toBe(true);
  });

  it("handles special characters without regex injection", () => {
    expect(matchesWildcard("v1.0.*", "v1.0.1")).toBe(true);
    expect(matchesWildcard("v1.0.*", "v1.0.10")).toBe(true);
    expect(matchesWildcard("v1.0.*", "v1.1.0")).toBe(false);
    expect(matchesWildcard("[feat]*", "[feat] new button")).toBe(true);
    expect(matchesWildcard("(v1)*", "(v1) test")).toBe(true);
  });

  it("handles empty pattern or text", () => {
    expect(matchesWildcard("", "")).toBe(true);
    expect(matchesWildcard("", "abc")).toBe(false);
    expect(matchesWildcard("abc", "")).toBe(false);
  });
});
