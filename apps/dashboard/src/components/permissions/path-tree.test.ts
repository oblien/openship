import { describe, it, expect } from "vitest";
import {
  buildTree,
  patternFor,
  nodeState,
  toggleNode,
  searchTree,
  type FlatEntry,
} from "./path-tree";

const REPO: FlatEntry[] = [
  { path: "src", type: "dir" },
  { path: "src/lib", type: "dir" },
  { path: "src/lib/api.ts", type: "file" },
  { path: "src/lib/user.ts", type: "file" },
  { path: "src/index.ts", type: "file" },
  { path: "docs", type: "dir" },
  { path: "docs/readme.md", type: "file" },
  { path: "package.json", type: "file" },
  { path: ".env", type: "file" },
];

const find = (nodes: ReturnType<typeof buildTree>, path: string): any => {
  for (const n of nodes) {
    if (n.path === path) return n;
    const hit = find(n.children, path);
    if (hit) return hit;
  }
  return undefined;
};

describe("buildTree", () => {
  it("nests by path and puts directories before files", () => {
    const tree = buildTree(REPO);
    expect(tree.map((n) => n.path)).toEqual(["docs", "src", ".env", "package.json"]);
    expect(find(tree, "src")!.children.map((n: any) => n.path)).toEqual([
      "src/lib",
      "src/index.ts",
    ]);
  });

  it("synthesises missing intermediate directories", () => {
    // A truncated-repo fallback can list a deep file with no parent `tree` entry;
    // dropping it would hide real paths from the picker.
    const tree = buildTree([{ path: "a/b/c/deep.ts", type: "file" }]);
    expect(tree.map((n) => n.path)).toEqual(["a"]);
    expect(find(tree, "a/b/c")!.isDirectory).toBe(true);
    expect(find(tree, "a/b/c/deep.ts")!.name).toBe("deep.ts");
  });

  it("keeps names as the last segment, not the full path", () => {
    expect(find(buildTree(REPO), "src/lib/api.ts")!.name).toBe("api.ts");
  });
});

describe("patternFor — a click must produce what the matcher enforces", () => {
  it("a directory grants its whole subtree", () => {
    expect(patternFor({ path: "src", isDirectory: true })).toBe("src/**");
  });

  it("a file grants exactly itself", () => {
    expect(patternFor({ path: "package.json", isDirectory: false })).toBe("package.json");
  });
});

describe("nodeState — covered is what keeps the tree honest", () => {
  const file = { path: "src/lib/api.ts", isDirectory: false };
  const dir = { path: "src", isDirectory: true };

  it("off when nothing grants it", () => {
    expect(nodeState(file, [])).toBe("off");
    expect(nodeState(file, ["docs/**"])).toBe("off");
  });

  it("selected when its own exact rule is present", () => {
    expect(nodeState(file, ["src/lib/api.ts"])).toBe("selected");
    expect(nodeState(dir, ["src/**"])).toBe("selected");
  });

  it("covered when a broader rule already grants it", () => {
    // Showing this as unchecked would claim it is not readable, which is false.
    expect(nodeState(file, ["src/**"])).toBe("covered");
    expect(nodeState(file, ["**"])).toBe("covered");
    expect(nodeState(dir, ["**"])).toBe("covered");
  });

  it("a directory is covered by a rule over its parent", () => {
    expect(nodeState({ path: "src/lib", isDirectory: true }, ["src/**"])).toBe("covered");
  });

  it("selected wins over covered for the exact rule", () => {
    // Both apply; the row must offer removal of its OWN rule.
    expect(nodeState(dir, ["src/**", "**"])).toBe("selected");
  });
});

describe("toggleNode", () => {
  it("adds the node's pattern", () => {
    expect(toggleNode({ path: "src", isDirectory: true }, [])).toEqual(["src/**"]);
  });

  it("removes it when already selected", () => {
    expect(toggleNode({ path: "src", isDirectory: true }, ["src/**", "docs/**"])).toEqual([
      "docs/**",
    ]);
  });

  it("drops rules the new one subsumes", () => {
    // Keeping src/lib/api.ts next to a fresh src/** would show two rules that mean
    // one thing, and the summary would imply the narrow one still constrains.
    const next = toggleNode({ path: "src", isDirectory: true }, [
      "src/lib/api.ts",
      "src/lib/**",
      "docs/**",
    ]);
    expect(next).toEqual(["docs/**", "src/**"]);
  });

  it("leaves unrelated rules alone", () => {
    expect(toggleNode({ path: "docs", isDirectory: true }, ["src/**"])).toEqual([
      "src/**",
      "docs/**",
    ]);
  });
});

describe("searchTree", () => {
  const tree = buildTree(REPO);

  it("empty query returns everything and expands nothing", () => {
    const r = searchTree(tree, "");
    expect(r.nodes).toHaveLength(tree.length);
    expect(r.expand.size).toBe(0);
  });

  it("keeps the directories leading to a match, so results stay in context", () => {
    const r = searchTree(tree, "api.ts");
    expect(r.nodes.map((n) => n.path)).toEqual(["src"]);
    expect(find(r.nodes, "src/lib/api.ts")).toBeDefined();
    // and those directories are opened
    expect([...r.expand]).toEqual(expect.arrayContaining(["src", "src/lib"]));
  });

  it("matches on the FULL path, not just the basename", () => {
    // "lib/user" is only findable if the whole path is searched.
    const r = searchTree(tree, "lib/user");
    expect(find(r.nodes, "src/lib/user.ts")).toBeDefined();
    expect(r.matchCount).toBe(1);
  });

  it("is case-insensitive", () => {
    expect(find(searchTree(tree, "API.TS").nodes, "src/lib/api.ts")).toBeDefined();
  });

  it("a matching directory keeps its children so it can be opened", () => {
    const r = searchTree(tree, "docs");
    expect(find(r.nodes, "docs/readme.md")).toBeDefined();
  });

  it("prunes non-matching branches entirely", () => {
    const r = searchTree(tree, "readme");
    expect(r.nodes.map((n) => n.path)).toEqual(["docs"]);
    expect(find(r.nodes, "src")).toBeUndefined();
  });

  it("no match yields nothing", () => {
    const r = searchTree(tree, "zzzz");
    expect(r.nodes).toEqual([]);
    expect(r.matchCount).toBe(0);
  });
});
