import { describe, it, expect } from "vitest";
import {
  DEPLOY_ONLY,
  toScope,
  fromScope,
  addPath,
  removePath,
  setTier,
  summarize,
  problems,
  grantsContent,
} from "./source-access";

/**
 * The picker's contract with the gate: what this file says a grant means must be
 * exactly what the server enforces. The cases that matter most are the ones where
 * a mistake would OVER-grant — an empty path list, a stale tier, a write surface
 * without the write verb.
 */

describe("deploy-only is the default and means no scope at all", () => {
  it("sends undefined, not an empty scope", () => {
    expect(toScope(DEPLOY_ONLY)).toBeUndefined();
    expect(grantsContent(DEPLOY_ONLY)).toBe(false);
  });

  it("summarises as a single deploy-only line", () => {
    expect(summarize(DEPLOY_ONLY)).toEqual([{ key: "deployOnly", tone: "neutral" }]);
  });
});

describe("toScope", () => {
  it("an empty path list at content tier means the WHOLE repo", () => {
    // "I chose content and added no paths" is an explicit whole-repo grant, which
    // is why the tier is stored rather than inferred from the list being empty.
    expect(toScope({ tier: "content", readPaths: [], writePaths: [] })).toEqual({
      v: 1,
      read: { paths: ["**"] },
    });
  });

  it("scopes read to the chosen globs", () => {
    expect(toScope({ tier: "content", readPaths: ["src/**", "package.json"], writePaths: [] })).toEqual({
      v: 1,
      read: { paths: ["src/**", "package.json"] },
    });
  });

  it("write tier carries both surfaces", () => {
    expect(
      toScope({ tier: "contentWrite", readPaths: ["src/**"], writePaths: ["src/gen/**"] }),
    ).toEqual({
      v: 1,
      read: { paths: ["src/**"] },
      write: { paths: ["src/gen/**"] },
    });
  });

  it("content tier never emits a write surface", () => {
    // Switching down from write must not leave a write scope behind.
    const scope = toScope({ tier: "content", readPaths: [], writePaths: ["src/**"] });
    expect(scope?.write).toBeUndefined();
  });
});

describe("fromScope — round-trip for editing", () => {
  it("no scope → deploy-only", () => {
    expect(fromScope(undefined)).toEqual(DEPLOY_ONLY);
    expect(fromScope(null)).toEqual(DEPLOY_ONLY);
    expect(fromScope({ v: 1 })).toEqual(DEPLOY_ONLY);
  });

  it("whole-repo read normalises back to an empty list", () => {
    expect(fromScope({ v: 1, read: { paths: ["**"] } })).toEqual({
      tier: "content",
      readPaths: [],
      writePaths: [],
    });
  });

  it("scoped read round-trips", () => {
    const sel = fromScope({ v: 1, read: { paths: ["src/**"] } });
    expect(sel).toEqual({ tier: "content", readPaths: ["src/**"], writePaths: [] });
    expect(toScope(sel)).toEqual({ v: 1, read: { paths: ["src/**"] } });
  });

  it("a write scope WITHOUT the write permission is shown as read-only", () => {
    // The server resolves writePaths to nothing on a read-only grant, so showing
    // write here would display access the gate refuses.
    const sel = fromScope(
      { v: 1, read: { paths: ["src/**"] }, write: { paths: ["src/**"] } },
      ["read"],
    );
    expect(sel.tier).toBe("content");
    expect(sel.writePaths).toEqual([]);
  });

  it("a write scope WITH the write permission shows write", () => {
    const sel = fromScope(
      { v: 1, read: { paths: ["src/**"] }, write: { paths: ["src/gen/**"] } },
      ["read", "write"],
    );
    expect(sel).toEqual({ tier: "contentWrite", readPaths: ["src/**"], writePaths: ["src/gen/**"] });
  });
});

describe("addPath — validated with the server's own matcher", () => {
  it("normalises as it adds", () => {
    expect(addPath([], "/src/").paths).toEqual(["src"]);
    expect(addPath([], "./src/**").paths).toEqual(["src/**"]);
  });

  it("rejects traversal and ambiguous globs", () => {
    expect(addPath([], "../etc").error).toBe("invalid");
    expect(addPath([], "sr**c").error).toBe("invalid");
    expect(addPath([], "").error).toBe("invalid");
  });

  it("rejects duplicates, including after normalisation", () => {
    expect(addPath(["src/**"], "src/**").error).toBe("duplicate");
    expect(addPath(["src/**"], "/src/**").error).toBe("duplicate");
  });

  it("leaves the list untouched on error", () => {
    expect(addPath(["src/**"], "../x").paths).toEqual(["src/**"]);
  });

  it("removePath removes exactly one rule", () => {
    expect(removePath(["src/**", "docs/**"], "src/**")).toEqual(["docs/**"]);
  });
});

describe("setTier keeps entered paths so exploring levels is not lossy", () => {
  it("retains paths across a tier switch", () => {
    const sel = { tier: "content" as const, readPaths: ["src/**"], writePaths: ["src/gen/**"] };
    expect(setTier(sel, "deploy").readPaths).toEqual(["src/**"]);
    expect(setTier(setTier(sel, "deploy"), "content").readPaths).toEqual(["src/**"]);
  });

  it("but deploy tier still sends no scope regardless of retained paths", () => {
    const sel = setTier({ tier: "content", readPaths: ["src/**"], writePaths: [] }, "deploy");
    expect(toScope(sel)).toBeUndefined();
  });
});

describe("summarize", () => {
  it("whole-repo read allows clone tokens", () => {
    const lines = summarize({ tier: "content", readPaths: [], writePaths: [] });
    expect(lines.map((l) => l.key)).toEqual(["readWholeRepo", "cloneAllowed"]);
  });

  it("scoped read warns that clone tokens are blocked", () => {
    // A clone can't be path-filtered, so scoping read also disables local builds.
    // Saying it here beats discovering it when a deploy fails.
    const lines = summarize({ tier: "content", readPaths: ["src/**"], writePaths: [] });
    expect(lines.map((l) => l.key)).toEqual(["readScoped", "cloneBlockedByScope"]);
    expect(lines.find((l) => l.key === "cloneBlockedByScope")?.tone).toBe("warn");
  });

  it("whole-repo write is flagged as the widest option", () => {
    const lines = summarize({ tier: "contentWrite", readPaths: [], writePaths: [] });
    expect(lines.map((l) => l.key)).toEqual(["readWholeRepo", "writeWholeRepo", "cloneAllowed"]);
    expect(lines.find((l) => l.key === "writeWholeRepo")?.tone).toBe("warn");
  });

  it("carries the paths for interpolation", () => {
    const lines = summarize({ tier: "content", readPaths: ["src/**", "docs/**"], writePaths: [] });
    expect(lines[0]?.paths).toEqual(["src/**", "docs/**"]);
  });
});

describe("problems — a toggle that would do nothing is blocked", () => {
  it("write tier without the write permission is a problem", () => {
    expect(problems({ tier: "contentWrite", readPaths: [], writePaths: [] }, ["read"])).toEqual([
      "writeNeedsWritePermission",
    ]);
  });

  it("write tier with write or admin is fine", () => {
    expect(problems({ tier: "contentWrite", readPaths: [], writePaths: [] }, ["read", "write"])).toEqual([]);
    expect(problems({ tier: "contentWrite", readPaths: [], writePaths: [] }, ["admin"])).toEqual([]);
  });

  it("lower tiers have no permission requirement", () => {
    expect(problems({ tier: "content", readPaths: [], writePaths: [] }, ["read"])).toEqual([]);
    expect(problems(DEPLOY_ONLY, [])).toEqual([]);
  });
});
