"use client";

/**
 * SourceAccessModal — per-repo source access, as a dedicated surface.
 *
 * Shared by the member-grants editor (ResourcePicker's GitHub tab) and the MCP
 * consent screen, because both are answering the same question and must answer it
 * identically: given this repo, how far in may the grantee read, and may they write?
 *
 * All state logic lives in ./source-access (pure, unit-tested). This file is only
 * rendering + wiring, matching the split used by mcp-access-templates.ts and
 * confirm-server-access.ts — so the rules can be tested without a DOM and can't
 * drift between the picker and the gate that enforces them.
 *
 * The summary is derived from the SELECTION, not from a list of tools, so it can
 * never go stale the way a capability digest can when a route is retagged.
 */

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Plus, X, AlertTriangle, Check, ChevronDown, Search } from "lucide-react";
import type { SourceAccessScope } from "@repo/core";
import { permissionsApi, type Permission } from "@/lib/api";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { LevelSwitch, type LevelOption } from "./LevelSwitch";
import { RepoPathTree } from "./RepoPathTree";
import {
  DEPLOY_ONLY,
  SOURCE_TIERS,
  addPath,
  fromScope,
  problems,
  removePath,
  setTier,
  summarize,
  toScope,
  type PathError,
  type SourceSelection,
  type SourceTierId,
  type SummaryKey,
} from "./source-access";

/**
 * Summary line → i18n key. Explicit rather than derived from the key name: a
 * derived lookup silently renders the raw identifier ("cloneBlockedByScope") when
 * the names drift, and this text is what an operator reads before granting access.
 * Typed as Record<SummaryKey, …> so adding a line without copy fails the build.
 */
const SUMMARY_COPY_KEY: Record<SummaryKey, string> = {
  deployOnly: "summaryDeployOnly",
  readWholeRepo: "summaryReadWholeRepo",
  readScoped: "summaryReadScoped",
  writeWholeRepo: "summaryWriteWholeRepo",
  writeScoped: "summaryWriteScoped",
  cloneAllowed: "summaryCloneAllowed",
  cloneBlockedByScope: "summaryCloneBlocked",
};

export interface SourceAccessModalProps {
  /** Rendered inline; the caller owns the open/close state. */
  open: boolean;
  onClose: () => void;
  /** "owner/repo" for a single repo, or the account login for a whole-account grant. */
  targetLabel: string;
  /**
   * True when this edits a `github_installation` grant — every repo under one
   * account. The rules are identical (the resolver treats both as a scope source);
   * only the subtitle changes, so the operator knows the breadth of what they're
   * about to allow.
   */
  wholeAccount?: boolean;
  /** The grant's VERB — gates whether the write tier is offered at all. */
  permissions: readonly Permission[];
  /** Existing scope when editing; omit for a new grant (⇒ deploy-only). */
  scope?: SourceAccessScope | null;
  /** Receives the scope to persist. `undefined` means deploy-only (no scope). */
  onApply: (scope: SourceAccessScope | undefined) => void;
}

/**
 * Repo picker for the browse target.
 *
 * A native <select> was wrong twice over: it renders in the OS chrome so it can't
 * follow the dark theme, and it offers no search — unusable for an account with
 * dozens of repos. This is a searchable popover over the same list.
 *
 * Deliberately not the Library's RepositoryList: that is a page-level grid with
 * visibility and sort controls, far too heavy for a secondary control inside an
 * already-dense dialog. Same data, right density.
 */
function RepoCombobox({
  repos,
  value,
  onChange,
  copy,
  labelId,
}: {
  repos: string[];
  value: string | null;
  onChange: (repo: string) => void;
  copy: Record<string, string>;
  labelId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  const close = () => {
    setOpen(false);
    setQuery("");
  };

  /**
   * Dismissal is bound to the document rather than drawn as a click-away overlay.
   * The overlay this replaces was `fixed inset-0` INSIDE the popover's own subtree,
   * which made it a descendant of the surrounding <label> — and since <button> is a
   * labelable element, label activation re-fired every dismissing click onto the
   * toggle, reopening the menu in the same tick it closed. The label is gone now,
   * but a listener can't be re-parented into that trap by a future wrapper, and it
   * also gets Escape and tab-away for free.
   *
   * Capture phase so a row's own click can't be swallowed first; Escape stops
   * propagating so it closes only this menu and not the dialog around it.
   */
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: Event) => {
      if (!rootRef.current?.contains(e.target as Node)) close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        // Focus the toggle BEFORE closing, while the search input still exists:
        // otherwise focus falls to <body> and a keyboard user restarts the tab
        // order. Moving it inside the root also keeps onBlur from double-closing.
        toggleRef.current?.focus();
        close();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  const matches = query.trim()
    ? repos.filter((r) => r.toLowerCase().includes(query.trim().toLowerCase()))
    : repos;

  return (
    <div
      ref={rootRef}
      className="relative"
      // Keyboard exit: tabbing past the last row leaves the menu behind otherwise.
      // A null relatedTarget (focus dropped to the body) is left alone, so a click
      // on the popover's own chrome doesn't close it out from under the pointer.
      onBlur={(e) => {
        if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) close();
      }}
    >
      <button
        ref={toggleRef}
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={labelId}
        className="flex items-center gap-1.5 rounded-lg bg-background px-2.5 py-1.5 font-mono text-[13px] text-foreground ring-1 ring-inset ring-border/60 transition-colors hover:ring-border"
      >
        {value ?? "—"}
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
      </button>

      {open && (
        <>
          <div className="absolute end-0 z-20 mt-1 w-64 overflow-hidden rounded-lg bg-card shadow-lg ring-1 ring-border/60">
            <div className="relative border-b border-border/50">
              <Search className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={copy.searchRepos}
                className="w-full bg-transparent py-2 pe-2.5 ps-8 text-[13px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
              />
            </div>
            <ul role="listbox" className="max-h-56 overflow-y-auto p-1">
              {matches.length === 0 ? (
                <li className="px-2 py-3 text-center text-[13px] text-muted-foreground">
                  {copy.noRepoMatch}
                </li>
              ) : (
                matches.map((r) => (
                  <li key={r} role="option" aria-selected={r === value}>
                    <button
                      type="button"
                      onClick={() => {
                        onChange(r);
                        close();
                      }}
                      className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 font-mono text-[13px] transition-colors hover:bg-muted/60 ${
                        r === value ? "text-foreground" : "text-muted-foreground"
                      }`}
                    >
                      <span className="truncate">{r}</span>
                      {r === value && <Check className="size-3.5 shrink-0" />}
                    </button>
                  </li>
                ))
              )}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}

/** The rules chosen for one surface, with a count/clear affordance. */
function PathChips({
  label,
  paths,
  onChange,
  copy,
}: {
  label: string;
  paths: string[];
  onChange: (next: string[]) => void;
  copy: Record<string, string>;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        {paths.length === 0 ? (
          <span className="text-[13px] text-muted-foreground">{copy.wholeRepo}</span>
        ) : (
          <button
            type="button"
            onClick={() => onChange([])}
            className="text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            {interpolate(copy.selectedCount, { count: String(paths.length) })} · {copy.clearPaths}
          </button>
        )}
      </div>

      {paths.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {paths.map((p) => (
            <li
              key={p}
              className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-muted/60 px-2 py-1 font-mono text-[13px] ring-1 ring-inset ring-border/50"
            >
              <span className="truncate">{p}</span>
              <button
                type="button"
                aria-label={interpolate(copy.removePath, { path: p })}
                onClick={() => onChange(removePath(paths, p))}
                className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Manual pattern entry — the escape hatch the tree can't cover: an extension glob
 * spanning every directory, or a path in a repo you aren't browsing. Collapsed by
 * default so clicking stays the primary interaction.
 */
function PatternInput({
  paths,
  onChange,
  copy,
}: {
  paths: string[];
  onChange: (next: string[]) => void;
  copy: Record<string, string>;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<PathError | null>(null);

  const commit = () => {
    if (!draft.trim()) return;
    const result = addPath(paths, draft);
    if (result.error) {
      setError(result.error);
      return;
    }
    onChange(result.paths);
    setDraft("");
    setError(null);
  };

  return (
    <details>
      <summary className="cursor-pointer list-none text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground">
        {copy.advancedPattern}
      </summary>
      <div className="mt-2 flex gap-1.5">
        <input
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            }
          }}
          placeholder={copy.addPathPlaceholder}
          className="min-w-0 flex-1 rounded-lg bg-background px-2.5 py-1.5 font-mono text-[13px] text-foreground ring-1 ring-inset ring-border/60 placeholder:text-muted-foreground/60 focus:outline-none focus:ring-primary/50"
        />
        <button
          type="button"
          onClick={commit}
          className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-muted/60 px-2.5 py-1.5 text-[13px] font-medium text-foreground transition-colors hover:bg-muted"
        >
          <Plus className="h-3 w-3" />
          {copy.addPath}
        </button>
      </div>
      {error && (
        <p className="mt-1.5 text-[13px] text-destructive">
          {error === "invalid" ? copy.errorInvalidPath : copy.errorDuplicatePath}
        </p>
      )}
    </details>
  );
}

/** Plain statements about the grant, derived from the selection. */
function Summary({
  lines,
  copy,
}: {
  lines: ReturnType<typeof summarize>;
  copy: Record<string, string>;
}) {
  return (
    <section className="space-y-2">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {copy.summaryTitle}
      </span>
      <ul className="space-y-1.5">
        {lines.map((line) => (
          <li
            key={line.key}
            className={`flex items-start gap-2 text-[13px] leading-relaxed ${
              line.tone === "warn" ? "text-amber-600 dark:text-amber-500" : "text-muted-foreground"
            }`}
          >
            {line.tone === "warn" ? (
              <AlertTriangle className="mt-[1px] h-3 w-3 shrink-0" />
            ) : (
              <Check className="mt-[1px] h-3 w-3 shrink-0" />
            )}
            <span>{interpolate(copy[SUMMARY_COPY_KEY[line.key]] ?? "", {
              paths: (line.paths ?? []).join(", "),
            })}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function SourceAccessModal({
  open,
  onClose,
  targetLabel,
  wholeAccount = false,
  permissions,
  scope,
  onApply,
}: SourceAccessModalProps) {
  const { t } = useI18n();
  const copy = t.widgets.permissions.sourceAccess as unknown as Record<string, string>;
  const browseLabelId = useId();

  // Seeded from the prop on the FIRST render, not in an effect: an effect would
  // paint "Deploy only" once before correcting itself, which for a security control
  // is a misleading flash — and it would make the component untestable via
  // renderToStaticMarkup (which runs no effects).
  const [selection, setSelection] = useState<SourceSelection>(() =>
    fromScope(scope, permissions),
  );

  // Re-seed when the modal reopens for a (possibly different) repo, so it never
  // shows the previous repo's rules.
  useEffect(() => {
    if (open) {
      setSelection(fromScope(scope, permissions));
      setSurface("read");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, targetLabel]);

  // Which surface the tree assigns to at the write tier. One browser feeding two
  // lists beats two trees: the same repo rendered twice would double the height and
  // make it ambiguous which one a click landed in.
  const [surface, setSurface] = useState<"read" | "write">("read");

  const canWrite = permissions.some((p) => p === "write" || p === "admin");

  // Which repo the tree shows. A repo grant browses itself; an ACCOUNT grant has no
  // single tree, so the operator picks one to browse while authoring patterns that
  // will apply to every repo under the account.
  const owner = wholeAccount ? targetLabel : (targetLabel.split("/")[0] ?? "");
  const ownRepo = wholeAccount ? null : (targetLabel.split("/")[1] ?? null);
  const [browseRepo, setBrowseRepo] = useState<string | null>(null);
  const [repoChoices, setRepoChoices] = useState<string[] | null>(null);

  const needsRepoChoice = wholeAccount && selection.tier !== "deploy";
  useEffect(() => {
    if (!open || !needsRepoChoice) return;
    let cancelled = false;
    permissionsApi
      .listResources("github_repository", owner)
      .then((res) => {
        if (cancelled) return;
        const names = (res?.data ?? [])
          .map((e) => String(e.id).split("/")[1] ?? "")
          .filter(Boolean);
        setRepoChoices(names);
        setBrowseRepo((cur) => cur ?? names[0] ?? null);
      })
      .catch(() => {
        if (!cancelled) setRepoChoices([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, needsRepoChoice, owner]);

  const browse =
    selection.tier === "deploy"
      ? null
      : ownRepo
        ? { owner, repo: ownRepo }
        : browseRepo
          ? { owner, repo: browseRepo }
          : null;

  const tierOptions = useMemo<LevelOption[]>(
    () =>
      SOURCE_TIERS.map((id) => ({
        id,
        label:
          id === "deploy" ? copy.tierDeploy : id === "content" ? copy.tierContent : copy.tierWrite,
      })),
    [copy],
  );

  const hint =
    selection.tier === "deploy"
      ? copy.tierDeployHint
      : selection.tier === "content"
        ? copy.tierContentHint
        : copy.tierWriteHint;

  const lines = summarize(selection);
  const blocking = problems(selection, permissions);

  if (!open) return null;

  const activePaths = surface === "read" ? selection.readPaths : selection.writePaths;
  const setActivePaths = (next: string[]) =>
    setSelection((s) =>
      surface === "read" ? { ...s, readPaths: next } : { ...s, writePaths: next },
    );

  return (
    // h-full + min-h-0 throughout so the TREE is what scrolls, not the whole panel —
    // the stacked version pushed the footer off screen on a repo of any size.
    <div
      className={`flex flex-col transition-[width] duration-200 ease-out ${
        selection.tier === "deploy" ? "w-[min(560px,92vw)]" : "w-[min(880px,95vw)]"
      }`}
    >
      <header className="shrink-0 space-y-4 px-6 pb-5 pt-6">
        <div>
          <h3 className="text-base font-semibold text-foreground">{copy.title}</h3>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            {interpolate(wholeAccount ? copy.subtitleAccount : copy.subtitle, {
              repo: targetLabel,
            })}
          </p>
        </div>
        <div className="space-y-2">
          <LevelSwitch
            options={tierOptions}
            value={selection.tier}
            onChange={(id) => setSelection((s) => setTier(s, id as SourceTierId))}
            size="lg"
          />
          <p className="text-[13px] leading-relaxed text-muted-foreground">{hint}</p>
        </div>
      </header>

      {selection.tier === "deploy" ? (
        // Nothing to scope at this tier, so no browser — just state what it means.
        <div className="min-h-0 flex-1 overflow-y-auto border-t border-border/50 px-6 py-5">
          <Summary lines={lines} copy={copy} />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col border-t border-border/50 lg:flex-row">
          {/* LEFT — the browser gets the room, because picking paths is the work. */}
          <section className="flex min-h-0 flex-1 flex-col gap-3 border-b border-border/50 p-5 lg:border-b-0 lg:border-e">
            {wholeAccount && (
              <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
                <p className="text-[13px] text-muted-foreground">{copy.appliesToEveryRepo}</p>
                {repoChoices && repoChoices.length > 0 && (
                  // Not a <label>: it would adopt the combobox's toggle as its labeled
                  // control (a <button> is labelable) and forward stray clicks to it.
                  // aria-labelledby carries the association instead.
                  <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
                    <span id={browseLabelId}>{copy.browseIn}</span>
                    <RepoCombobox
                      repos={repoChoices}
                      value={browseRepo}
                      onChange={setBrowseRepo}
                      copy={copy}
                      labelId={browseLabelId}
                    />
                  </div>
                )}
              </div>
            )}

            {selection.tier === "contentWrite" && (
              <div className="flex shrink-0 items-center gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {copy.assigningTo}
                </span>
                <LevelSwitch
                  options={[
                    { id: "read", label: copy.surfaceRead },
                    { id: "write", label: copy.surfaceWrite },
                  ]}
                  value={surface}
                  onChange={(id) => setSurface(id === "write" ? "write" : "read")}
                  size="lg"
                />
              </div>
            )}

            {browse ? (
              <RepoPathTree
                fill
                owner={browse.owner}
                repo={browse.repo}
                selected={activePaths}
                onChange={setActivePaths}
              />
            ) : (
              <p className="flex min-h-0 flex-1 items-center justify-center text-[13px] text-muted-foreground">
                {copy.treeLoading}
              </p>
            )}
          </section>

          {/* RIGHT — what has been chosen, and what it adds up to. */}
          <aside className="flex w-full shrink-0 flex-col gap-5 overflow-y-auto p-5 lg:w-[320px]">
            <PathChips
              label={copy.readPathsLabel}
              paths={selection.readPaths}
              onChange={(readPaths) => setSelection((s) => ({ ...s, readPaths }))}
              copy={copy}
            />
            {selection.tier === "contentWrite" && (
              <PathChips
                label={copy.writePathsLabel}
                paths={selection.writePaths}
                onChange={(writePaths) => setSelection((s) => ({ ...s, writePaths }))}
                copy={copy}
              />
            )}
            <PatternInput paths={activePaths} onChange={setActivePaths} copy={copy} />
            <Summary lines={lines} copy={copy} />
            {blocking.includes("writeNeedsWritePermission") && (
              <p className="flex items-start gap-2 text-[13px] leading-relaxed text-destructive">
                <AlertTriangle className="mt-[1px] h-3 w-3 shrink-0" />
                {copy.problemWriteNeedsPermission}
              </p>
            )}
          </aside>
        </div>
      )}

      <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border/50 px-6 py-4">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-border/60 bg-muted/30 px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted/50"
        >
          {copy.cancel}
        </button>
        <button
          type="button"
          disabled={blocking.length > 0}
          onClick={() => {
            onApply(toScope(selection));
            onClose();
          }}
          className="rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          title={canWrite ? undefined : copy.problemWriteNeedsPermission}
        >
          {copy.apply}
        </button>
      </footer>
    </div>
  );
}
