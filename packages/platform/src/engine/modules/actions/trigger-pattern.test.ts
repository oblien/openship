import { describe, expect, it } from "vitest";
import { matchesActionPattern as match, matchesActionFilters } from "./trigger-pattern";

describe("GitHub trigger filters", () => {
  it("matches paths and branch ranges using GitHub glob syntax", () => {
    for (const path of ["index.ts", "src/index.ts", "a/b/c.ts"])
      expect(match("**/*.ts", path)).toBe(true);
    expect(match("src/*.ts", "src/nested/a.ts")).toBe(false);
    expect(match("releases/[0-9]+.[0-9]+", "releases/12.3")).toBe(true);
    expect(match("releases/[0-9]+.[0-9]+", "releases/latest")).toBe(false);
    expect(match("README.md?", "README.m")).toBe(true);
    expect(match("literal\\*", "literal*")).toBe(true);
  });
  it("respects ordered negations and only ignores a change when every path is ignored", () => {
    expect(matchesActionFilters(["**", "!docs/**", "docs/api/**"], ["docs/readme.md"])).toBe(false);
    expect(matchesActionFilters(["**", "!docs/**", "docs/api/**"], ["docs/api/intro.md"])).toBe(
      true,
    );
    expect(matchesActionFilters(["docs/**"], ["docs/a.md"], true)).toBe(false);
    expect(matchesActionFilters(["docs/**"], ["docs/a.md", "src/app.ts"], true)).toBe(true);
    expect(() => match("[z-a]", "z")).toThrow();
    expect(() => match("*".repeat(513), "a")).toThrow();
  });
});
