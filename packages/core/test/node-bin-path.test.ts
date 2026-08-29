import { describe, expect, it } from "vitest";

import { nodeBinDirs, nodeBinPathExport } from "../src/stacks";

describe("nodeBinDirs", () => {
  it("maps each root to its node_modules/.bin for every JS package manager", () => {
    for (const pm of ["npm", "yarn", "pnpm", "bun"] as const) {
      expect(nodeBinDirs(pm, ["/workspace/apps/web", "/workspace"])).toEqual([
        "/workspace/apps/web/node_modules/.bin",
        "/workspace/node_modules/.bin",
      ]);
    }
  });

  it("keeps roots in the given order — nearest first, hoisted workspace root second", () => {
    const dirs = nodeBinDirs("pnpm", ["/workspace/apps/web", "/workspace"]);
    expect(dirs[0]).toContain("/apps/web/");
  });

  it("drops duplicates so a root-level app does not list the same dir twice", () => {
    expect(nodeBinDirs("bun", ["/workspace", "/workspace"])).toEqual([
      "/workspace/node_modules/.bin",
    ]);
  });

  it("tolerates a trailing slash on a root", () => {
    expect(nodeBinDirs("npm", ["/workspace/"])).toEqual(["/workspace/node_modules/.bin"]);
  });

  it("is empty for every non-node package manager and for undefined", () => {
    for (const pm of ["go", "cargo", "pip", "poetry", "composer", "maven", "dotnet", "mix", "unknown", undefined] as const) {
      expect(nodeBinDirs(pm, ["/workspace"]), String(pm)).toEqual([]);
    }
  });
});

describe("nodeBinPathExport", () => {
  it("prepends the bin dirs and preserves the inherited PATH", () => {
    // "$PATH" stays double-quoted so the shell still expands it; the dirs are
    // single-quoted so a path with a space survives as one word.
    expect(nodeBinPathExport("bun", ["/workspace"])).toBe(
      `export PATH='/workspace/node_modules/.bin':"$PATH"`,
    );
  });

  it("quotes a root containing a space", () => {
    expect(nodeBinPathExport("npm", ["/a b/web"])).toBe(
      `export PATH='/a b/web/node_modules/.bin':"$PATH"`,
    );
  });

  it("is a no-op for non-node package managers, so a Go/Python build gains no dead PATH entries", () => {
    for (const pm of ["go", "pip", undefined] as const) {
      expect(nodeBinPathExport(pm, ["/workspace"])).toBe("");
    }
  });
});
