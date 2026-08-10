"use client";

/**
 * RepoPathTree — browse a repository and pick the paths a grant covers.
 *
 * Authoring globs in a text box means guessing at a structure you can't see, so
 * this lists the real tree: collapsible directories, search across full paths, and
 * a checkbox per row that emits exactly the pattern the server's matcher enforces
 * (`src/**` for a directory, the path itself for a file).
 *
 * One recursive fetch backs the whole thing — a request per directory would make
 * search impossible, since you can only filter what you've already loaded.
 *
 * All the fiddly logic (nesting, coverage, search with ancestor reveal) lives in
 * ./path-tree and is unit-tested; this file renders it.
 */

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, File, Folder, Loader2, Search, Check, Lock } from "lucide-react";
import { githubApi, getApiErrorMessage, type RepoTreeEntry } from "@/lib/api";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { buildTree, nodeState, searchTree, toggleNode, type TreeNode } from "./path-tree";

export interface RepoPathTreeProps {
  owner: string;
  /** Repo NAME (not owner/repo) whose tree is browsed. */
  repo: string;
  branch?: string;
  /** Current allow-list. Empty means "everything", which the caller renders. */
  selected: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  /**
   * Grow to the height the parent gives it instead of the standalone cap. The wide
   * two-column modal hands the tree a whole column, and a fixed 240px there would
   * waste the space the layout exists to provide.
   */
  fill?: boolean;
}

/** Matches ResourcePicker's checkbox at the smaller scale a dense tree needs. */
function TreeCheck({
  state,
  disabled,
  onClick,
  label,
}: {
  state: "selected" | "covered" | "off";
  disabled?: boolean;
  onClick: () => void;
  label: string;
}) {
  const covered = state === "covered";
  return (
    <button
      type="button"
      onClick={onClick}
      // A covered row is already granted by a broader rule; the only way to narrow
      // it is to remove that rule, so offering a click here would do nothing.
      disabled={disabled || covered}
      role="checkbox"
      aria-checked={state !== "off"}
      aria-label={label}
      title={covered ? label : undefined}
      className={`flex size-4 shrink-0 items-center justify-center rounded border-2 transition-colors disabled:cursor-not-allowed ${
        state === "selected"
          ? "border-primary bg-primary text-primary-foreground"
          : covered
            ? "border-primary/40 bg-primary/20 text-primary/70"
            : "border-border/60 hover:border-primary/60"
      }`}
    >
      {state === "selected" && <Check className="size-2.5" />}
      {covered && <Lock className="size-2.5" />}
    </button>
  );
}

function Row({
  node,
  depth,
  selected,
  expanded,
  onToggleExpand,
  onToggleSelect,
  disabled,
  coveredLabel,
}: {
  node: TreeNode;
  depth: number;
  selected: string[];
  expanded: Set<string>;
  onToggleExpand: (path: string) => void;
  onToggleSelect: (node: TreeNode) => void;
  disabled?: boolean;
  coveredLabel: string;
}) {
  const state = nodeState(node, selected);
  const isOpen = expanded.has(node.path);
  const hasChildren = node.isDirectory && node.children.length > 0;

  return (
    <>
      <div
        className="flex items-center gap-2 rounded-md px-1.5 py-1 transition-colors hover:bg-muted/40"
        // Indent by depth rather than nesting containers, so long paths never
        // create a horizontal scroll cascade.
        style={{ paddingInlineStart: `${depth * 14 + 6}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={() => onToggleExpand(node.path)}
            className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
            aria-label={node.name}
          >
            {isOpen ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5 rtl:rotate-180" />
            )}
          </button>
        ) : (
          <span className="size-[18px] shrink-0" />
        )}

        <TreeCheck
          state={state}
          disabled={disabled}
          onClick={() => onToggleSelect(node)}
          label={state === "covered" ? interpolate(coveredLabel, { path: node.path }) : node.path}
        />

        {node.isDirectory ? (
          <Folder className="size-3.5 shrink-0 text-muted-foreground/70" />
        ) : (
          <File className="size-3.5 shrink-0 text-muted-foreground/50" />
        )}

        <span
          className={`truncate font-mono text-[13px] ${
            state === "off" ? "text-muted-foreground" : "text-foreground"
          }`}
        >
          {node.name}
        </span>
      </div>

      {hasChildren &&
        isOpen &&
        node.children.map((child) => (
          <Row
            key={child.path}
            node={child}
            depth={depth + 1}
            selected={selected}
            expanded={expanded}
            onToggleExpand={onToggleExpand}
            onToggleSelect={onToggleSelect}
            disabled={disabled}
            coveredLabel={coveredLabel}
          />
        ))}
    </>
  );
}

export function RepoPathTree({
  owner,
  repo,
  branch,
  selected,
  onChange,
  disabled,
  fill = false,
}: RepoPathTreeProps) {
  const { t } = useI18n();
  const copy = t.widgets.permissions.sourceAccess as unknown as Record<string, string>;

  const [entries, setEntries] = useState<RepoTreeEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setError(null);
    githubApi
      .getRepoTree(owner, repo, branch)
      .then((res) => {
        if (!cancelled) setEntries(res?.data ?? []);
      })
      .catch((err) => {
        if (!cancelled) setError(getApiErrorMessage(err, copy.treeError));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, repo, branch]);

  const tree = useMemo(() => buildTree(entries ?? []), [entries]);
  const result = useMemo(() => searchTree(tree, query), [tree, query]);

  // While searching, the matches' ancestors are force-opened; the user's own
  // open/closed state is preserved for when the query clears.
  const effectiveExpanded = useMemo(
    () => (query.trim() ? new Set([...expanded, ...result.expand]) : expanded),
    [query, expanded, result.expand],
  );

  const toggleExpand = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <div className={fill ? "flex min-h-0 flex-1 flex-col gap-2" : "space-y-2"}>
      <div className="relative shrink-0">
        <Search className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={copy.searchPaths}
          disabled={disabled || !entries}
          className="w-full rounded-lg bg-background py-1.5 pe-2.5 ps-8 text-[13px] text-foreground ring-1 ring-inset ring-border/60 placeholder:text-muted-foreground/60 focus:outline-none focus:ring-primary/50 disabled:opacity-50"
        />
      </div>

      <div
        className={`overflow-y-auto rounded-lg bg-background/40 p-1 ring-1 ring-inset ring-border/40 ${
          fill ? "min-h-[260px] max-h-[44vh] flex-1" : "max-h-[240px]"
        }`}
      >
        {error ? (
          <p className="px-2 py-6 text-center text-[13px] text-destructive">{error}</p>
        ) : !entries ? (
          <p className="flex items-center justify-center gap-2 px-2 py-6 text-[13px] text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            {copy.treeLoading}
          </p>
        ) : result.nodes.length === 0 ? (
          <p className="px-2 py-6 text-center text-[13px] text-muted-foreground">
            {query.trim() ? copy.treeNoMatch : copy.treeEmpty}
          </p>
        ) : (
          result.nodes.map((node) => (
            <Row
              key={node.path}
              node={node}
              depth={0}
              selected={selected}
              expanded={effectiveExpanded}
              onToggleExpand={toggleExpand}
              onToggleSelect={(n) => onChange(toggleNode(n, selected))}
              disabled={disabled}
              coveredLabel={copy.treeCovered}
            />
          ))
        )}
      </div>
    </div>
  );
}
