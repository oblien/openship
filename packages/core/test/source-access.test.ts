import { describe, it, expect } from "vitest";
import {
  WHOLE_REPO,
  normalizeRepoPath,
  normalizeRepoPattern,
  matchesAny,
  isAncestorOfAny,
  entryVisible,
  grantsWholeRepo,
  parseSourceAccessScope,
  serializeSourceAccessScope,
  scopeIsSubset,
} from "../src/source-access";

/**
 * This module is the security core of per-repo source access: every content read
 * is gated by `matchesAny`, and every directory listing is filtered by
 * `entryVisible`. A false positive here hands out file contents the owner never
 * granted, so the negative cases matter more than the positive ones.
 */

describe("normalizeRepoPath — refuses what it cannot reason about", () => {
  it("rejects traversal outright rather than resolving it", () => {
    // Resolving would hide a caller bug or an attack; denying surfaces both.
    expect(normalizeRepoPath("../etc/passwd")).toBeNull();
    expect(normalizeRepoPath("src/../../etc/passwd")).toBeNull();
    expect(normalizeRepoPath("src/..")).toBeNull();
    expect(normalizeRepoPath("a/b/../c")).toBeNull();
  });

  it("rejects NUL and backslashes", () => {
    expect(normalizeRepoPath("src/a\0b")).toBeNull();
    expect(normalizeRepoPath("src\\a")).toBeNull();
  });

  it("strips harmless noise: leading slash, doubled slashes, ./", () => {
    expect(normalizeRepoPath("/src/a.ts")).toBe("src/a.ts");
    expect(normalizeRepoPath("src//a.ts")).toBe("src/a.ts");
    expect(normalizeRepoPath("./src/a.ts")).toBe("src/a.ts");
    expect(normalizeRepoPath("src/./a.ts")).toBe("src/a.ts");
  });

  it("maps the repo root to the empty string", () => {
    expect(normalizeRepoPath("")).toBe("");
    expect(normalizeRepoPath("/")).toBe("");
    expect(normalizeRepoPath(".")).toBe("");
  });

  it("rejects absurd depth and length", () => {
    expect(normalizeRepoPath("a/".repeat(65) + "b")).toBeNull();
    expect(normalizeRepoPath("a".repeat(1025))).toBeNull();
  });
});

describe("normalizeRepoPattern", () => {
  it("rejects an embedded ** as ambiguous", () => {
    expect(normalizeRepoPattern("sr**c")).toBeNull();
    expect(normalizeRepoPattern("src/a**b")).toBeNull();
  });

  it("accepts * and ** as whole segments", () => {
    expect(normalizeRepoPattern("src/**")).toBe("src/**");
    expect(normalizeRepoPattern("src/*.ts")).toBe("src/*.ts");
    expect(normalizeRepoPattern("**")).toBe("**");
  });

  it("rejects an empty pattern — it grants nothing, so say so loudly", () => {
    expect(normalizeRepoPattern("")).toBeNull();
    expect(normalizeRepoPattern("/")).toBeNull();
  });

  it("rejects traversal", () => {
    expect(normalizeRepoPattern("../**")).toBeNull();
  });
});

describe("matchesAny — fails closed", () => {
  it("an empty pattern list grants NOTHING (not everything)", () => {
    expect(matchesAny("package.json", [])).toBe(false);
  });

  it("a traversal path is denied even under a whole-repo grant", () => {
    expect(matchesAny("../secrets", [WHOLE_REPO])).toBe(false);
  });

  it("a malformed rule is ignored and never widens access", () => {
    expect(matchesAny("secrets.env", ["sr**c", "src/**"])).toBe(false);
  });

  it("** grants the whole repo", () => {
    expect(matchesAny("package.json", [WHOLE_REPO])).toBe(true);
    expect(matchesAny("a/b/c/d.ts", [WHOLE_REPO])).toBe(true);
  });

  it("* stays inside one segment", () => {
    expect(matchesAny("src/a.ts", ["src/*"])).toBe(true);
    expect(matchesAny("src/nested/a.ts", ["src/*"])).toBe(false);
    expect(matchesAny("src/a.ts", ["src/*.ts"])).toBe(true);
    expect(matchesAny("src/a.js", ["src/*.ts"])).toBe(false);
  });

  it("subtree: src/** covers src itself and everything below", () => {
    expect(matchesAny("src", ["src/**"])).toBe(true);
    expect(matchesAny("src/a.ts", ["src/**"])).toBe(true);
    expect(matchesAny("src/deep/nested/a.ts", ["src/**"])).toBe(true);
    // and nothing outside it
    expect(matchesAny("package.json", ["src/**"])).toBe(false);
    expect(matchesAny("srcx/a.ts", ["src/**"])).toBe(false);
  });

  it("an exact file grant matches only that file", () => {
    expect(matchesAny("package.json", ["package.json"])).toBe(true);
    expect(matchesAny("src/package.json", ["package.json"])).toBe(false);
  });

  it("is case-sensitive, because Git paths are", () => {
    expect(matchesAny("SRC/a.ts", ["src/**"])).toBe(false);
    expect(matchesAny("src/A.ts", ["src/a.ts"])).toBe(false);
  });

  it("mid-pattern ** spans any depth", () => {
    expect(matchesAny("a/b/c/target.ts", ["a/**/target.ts"])).toBe(true);
    expect(matchesAny("a/target.ts", ["a/**/target.ts"])).toBe(true);
    expect(matchesAny("a/b/other.ts", ["a/**/target.ts"])).toBe(false);
  });

  it("terminates on the classic exponential-backtracking pattern", () => {
    // `a*a*a*…*b` against a long run of `a` with no `b` is the case that makes a
    // naive recursive matcher hang. The two-pointer walk is O(n·m); if this ever
    // regresses to recursion, the suite times out rather than quietly slowing.
    expect(matchesAny("a".repeat(64), ["a*a*a*a*a*a*a*a*a*a*b"])).toBe(false);
    expect(matchesAny("a".repeat(64) + "b", ["a*a*a*a*a*a*a*a*a*a*b"])).toBe(true);
  });

  it("terminates on many stacked ** segments", () => {
    const deep = Array.from({ length: 30 }, (_, i) => `s${i}`).join("/");
    expect(matchesAny(`${deep}/x`, ["**/**/**/**/x"])).toBe(true);
    expect(matchesAny(`${deep}/x`, ["**/**/**/**/q"])).toBe(false);
  });
});

describe("isAncestorOfAny — what keeps a narrow grant discoverable", () => {
  it("the root is always an ancestor of a non-empty grant", () => {
    expect(isAncestorOfAny("", ["src/**"])).toBe(true);
  });

  it("a directory on the way to a grant is an ancestor", () => {
    expect(isAncestorOfAny("src", ["src/deep/a.ts"])).toBe(true);
    expect(isAncestorOfAny("src/deep", ["src/deep/a.ts"])).toBe(true);
  });

  it("an unrelated directory is not", () => {
    expect(isAncestorOfAny("docs", ["src/**"])).toBe(false);
    expect(isAncestorOfAny("srcx", ["src/**"])).toBe(false);
  });

  it("anything below a ** may match", () => {
    expect(isAncestorOfAny("src/whatever/deep", ["src/**"])).toBe(true);
  });

  it("no patterns → nothing is an ancestor", () => {
    expect(isAncestorOfAny("src", [])).toBe(false);
  });
});

describe("entryVisible — the listing filter", () => {
  const patterns = ["src/**"];

  it("shows a granted file", () => {
    expect(entryVisible("src/a.ts", false, patterns)).toBe(true);
  });

  it("shows a directory that leads to a grant", () => {
    expect(entryVisible("src", true, patterns)).toBe(true);
  });

  it("hides an ungranted file even when its parent is an ancestor", () => {
    // Listing the root with a src/** grant must not leak sibling filenames.
    expect(entryVisible("package.json", false, patterns)).toBe(false);
    expect(entryVisible("secrets.env", false, patterns)).toBe(false);
  });

  it("hides an unrelated directory", () => {
    expect(entryVisible("docs", true, patterns)).toBe(false);
  });

  it("the documented root-listing outcome: only src/ survives", () => {
    const root = [
      { path: "src", dir: true },
      { path: "docs", dir: true },
      { path: "package.json", dir: false },
      { path: ".env", dir: false },
    ];
    const visible = root.filter((e) => entryVisible(e.path, e.dir, patterns)).map((e) => e.path);
    expect(visible).toEqual(["src"]);
  });
});

describe("parse / serialize — fails closed", () => {
  it("treats malformed, empty, and unknown-version scopes as no access", () => {
    expect(parseSourceAccessScope(null)).toBeUndefined();
    expect(parseSourceAccessScope("")).toBeUndefined();
    expect(parseSourceAccessScope("not json")).toBeUndefined();
    expect(parseSourceAccessScope("[]")).toBeUndefined();
    expect(parseSourceAccessScope('{"v":1}')).toBeUndefined();
    // A future version must deny rather than be guessed at.
    expect(parseSourceAccessScope('{"v":2,"read":{"paths":["**"]}}')).toBeUndefined();
  });

  it("drops malformed patterns while keeping the valid ones", () => {
    const scope = parseSourceAccessScope('{"v":1,"read":{"paths":["src/**","../x","sr**c"]}}');
    expect(scope?.read?.paths).toEqual(["src/**"]);
  });

  it("round-trips and de-duplicates", () => {
    const json = serializeSourceAccessScope({
      v: 1,
      read: { paths: ["src/**", "src/**", "/package.json"] },
      write: { paths: ["src/gen/**"] },
    });
    const back = parseSourceAccessScope(json);
    expect(back?.read?.paths).toEqual(["src/**", "package.json"]);
    expect(back?.write?.paths).toEqual(["src/gen/**"]);
  });

  it("a scope granting nothing stores as null, not an empty object", () => {
    expect(serializeSourceAccessScope(undefined)).toBeNull();
    expect(serializeSourceAccessScope({ v: 1 })).toBeNull();
    expect(serializeSourceAccessScope({ v: 1, read: { paths: [] } })).toBeNull();
    expect(serializeSourceAccessScope({ v: 1, read: { paths: ["../bad"] } })).toBeNull();
  });
});

describe("grantsWholeRepo — the clone-token gate", () => {
  it("is true only for an all-** pattern", () => {
    expect(grantsWholeRepo([WHOLE_REPO])).toBe(true);
    expect(grantsWholeRepo(["**/**"])).toBe(true);
    expect(grantsWholeRepo(["src/**", "**"])).toBe(true);
  });

  it("is false for partial access — a clone cannot be path-filtered", () => {
    expect(grantsWholeRepo(["src/**"])).toBe(false);
    expect(grantsWholeRepo(["*"])).toBe(false); // one segment only
    expect(grantsWholeRepo(["package.json"])).toBe(false);
    expect(grantsWholeRepo([])).toBe(false);
    expect(grantsWholeRepo(["sr**c"])).toBe(false); // malformed → denies
  });
});

describe("scopeIsSubset — mint-time containment", () => {
  it("anything is within a whole-repo envelope", () => {
    expect(scopeIsSubset(["src/**"], [WHOLE_REPO])).toBe(true);
    expect(scopeIsSubset(["package.json"], [WHOLE_REPO])).toBe(true);
  });

  it("a narrower subtree is within a broader one", () => {
    expect(scopeIsSubset(["src/a/**"], ["src/**"])).toBe(true);
    expect(scopeIsSubset(["src/a.ts"], ["src/**"])).toBe(true);
  });

  it("a broader subtree is NOT within a narrower one", () => {
    expect(scopeIsSubset(["src/**"], ["src/a/**"])).toBe(false);
    expect(scopeIsSubset([WHOLE_REPO], ["src/**"])).toBe(false);
  });

  it("an unrelated path is not contained", () => {
    expect(scopeIsSubset(["docs/**"], ["src/**"])).toBe(false);
  });

  it("granting nothing is always a subset; an empty envelope contains nothing", () => {
    expect(scopeIsSubset([], ["src/**"])).toBe(true);
    expect(scopeIsSubset(["src/**"], [])).toBe(false);
  });
});
