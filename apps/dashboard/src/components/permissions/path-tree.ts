/**
 * Path-tree logic for the source-access picker — the pure part.
 *
 * The API returns a repo's tree FLAT and recursive (`{path, type}[]`). This turns
 * that into a nested, searchable, collapsible structure and answers the question
 * each row needs: is this path granted, is it covered by a broader rule already,
 * or is it untouched?
 *
 * Kept pure and DOM-free so the three fiddly behaviours — coverage, search with
 * ancestor reveal, and what pattern a click produces — are unit-tested rather than
 * eyeballed.
 */

import { matchesAny, normalizeRepoPattern, WHOLE_REPO } from "@repo/core";

export interface FlatEntry {
  path: string;
  type: "file" | "dir";
}

export interface TreeNode {
  /** Full repo-relative path, e.g. "src/lib/api.ts". */
  path: string;
  /** Last segment, for display. */
  name: string;
  isDirectory: boolean;
  children: TreeNode[];
}

/**
 * Nest a flat path list.
 *
 * Intermediate directories are synthesised: GitHub's tree includes `tree` entries,
 * but the contents fallback for a truncated repo may not, and a file whose parent
 * is missing must still be reachable rather than silently dropped.
 */
export function buildTree(entries: readonly FlatEntry[]): TreeNode[] {
  const byPath = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];

  const ensureDir = (path: string): TreeNode => {
    const existing = byPath.get(path);
    if (existing) return existing;
    const segments = path.split("/");
    const node: TreeNode = {
      path,
      name: segments[segments.length - 1]!,
      isDirectory: true,
      children: [],
    };
    byPath.set(path, node);
    if (segments.length === 1) roots.push(node);
    else ensureDir(segments.slice(0, -1).join("/")).children.push(node);
    return node;
  };

  // Directories first so a file never creates a dir node that later needs merging.
  for (const e of entries) if (e.type === "dir") ensureDir(e.path);

  for (const e of entries) {
    if (e.type === "dir") continue;
    const segments = e.path.split("/");
    const node: TreeNode = {
      path: e.path,
      name: segments[segments.length - 1]!,
      isDirectory: false,
      children: [],
    };
    if (byPath.has(e.path)) continue; // a dir already claims this path
    byPath.set(e.path, node);
    if (segments.length === 1) roots.push(node);
    else ensureDir(segments.slice(0, -1).join("/")).children.push(node);
  }

  sortNodes(roots);
  return roots;
}

/** Directories before files, then case-insensitive by name — the familiar order. */
function sortNodes(nodes: TreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
  for (const n of nodes) if (n.children.length > 0) sortNodes(n.children);
}

/**
 * The pattern selecting this node. A directory grants its whole subtree (`src/**`),
 * a file grants exactly itself — which is precisely the distinction the matcher
 * enforces, so the click and the rule can't disagree.
 */
export function patternFor(node: Pick<TreeNode, "path" | "isDirectory">): string {
  return node.isDirectory ? `${node.path}/**` : node.path;
}

export type NodeState =
  /** This exact rule is in the list — clicking removes it. */
  | "selected"
  /** A broader rule already grants it — clicking does nothing useful. */
  | "covered"
  /** Not granted. */
  | "off";

/**
 * How a row should render.
 *
 * `covered` is the state that makes the tree honest: with `src/**` selected,
 * `src/a.ts` IS readable, and showing it as unchecked would be a lie. It is shown
 * as covered-and-locked instead, so the only way to narrow it is to remove the
 * broader rule — which is also the only thing that would actually narrow access.
 */
export function nodeState(
  node: Pick<TreeNode, "path" | "isDirectory">,
  selected: readonly string[],
): NodeState {
  const own = patternFor(node);
  if (selected.includes(own)) return "selected";
  // Whole-repo selection covers everything.
  if (selected.some((p) => normalizeRepoPattern(p) === WHOLE_REPO)) return "covered";
  // Otherwise: does any OTHER rule already match this path?
  const others = selected.filter((p) => p !== own);
  if (others.length === 0) return "off";
  return matchesAny(node.path, others) ? "covered" : "off";
}

/**
 * Toggle a node, returning the next rule list.
 *
 * Selecting a directory drops any rules it now subsumes — leaving `src/a.ts`
 * alongside a fresh `src/**` would show two rules that mean one thing, and the
 * summary would read as if the narrower one still constrained something.
 */
export function toggleNode(
  node: Pick<TreeNode, "path" | "isDirectory">,
  selected: readonly string[],
): string[] {
  const own = patternFor(node);
  if (selected.includes(own)) return selected.filter((p) => p !== own);
  const kept = selected.filter((p) => {
    if (p === own) return false;
    // Drop rules the new one subsumes. Compare the rule's literal reach by
    // probing its own path form.
    const probe = p.endsWith("/**") ? p.slice(0, -3) : p;
    return !matchesAny(probe, [own]);
  });
  return [...kept, own];
}

/* ── Search ─────────────────────────────────────────────────────────────────── */

export interface SearchResult {
  /** Nodes to render, pruned to matches and the directories leading to them. */
  nodes: TreeNode[];
  /** Directories that must be open for the matches to be visible. */
  expand: Set<string>;
  matchCount: number;
}

/**
 * Filter the tree to paths matching `query`, keeping the directories that lead to
 * each match so results stay in context rather than as a flat list of basenames.
 *
 * Case-insensitive substring over the FULL path, so "api/user" finds nested files
 * that a name-only search would miss.
 */
export function searchTree(nodes: readonly TreeNode[], query: string): SearchResult {
  const q = query.trim().toLowerCase();
  if (!q) return { nodes: [...nodes], expand: new Set(), matchCount: 0 };

  const expand = new Set<string>();
  let matchCount = 0;

  const walk = (list: readonly TreeNode[]): TreeNode[] => {
    const out: TreeNode[] = [];
    for (const node of list) {
      const selfMatch = node.path.toLowerCase().includes(q);
      const kids = node.children.length > 0 ? walk(node.children) : [];
      if (selfMatch) matchCount++;
      if (selfMatch || kids.length > 0) {
        // A matching directory keeps its real children so it can be opened;
        // a directory kept only for its descendants shows just those.
        out.push({ ...node, children: selfMatch && kids.length === 0 ? node.children : kids });
        if (kids.length > 0) expand.add(node.path);
      }
    }
    return out;
  };

  return { nodes: walk(nodes), expand, matchCount };
}
