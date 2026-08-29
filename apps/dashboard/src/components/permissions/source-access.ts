/**
 * Source access control for one repository — the pure part.
 *
 * Everything here is a pure function so the whole state machine (tier switching,
 * path validation, the summary) is unit-testable without a DOM, matching the split
 * already used by mcp-access-templates.ts and confirm-server-access.ts.
 *
 * ── The one rule that shapes this file ───────────────────────────────────────
 * A repo grant is DEPLOY-ONLY by default. `permissions: ["read"]` authorises using
 * the repo — deploying it, listing branches, detecting its stack — and NOT reading
 * a single file. Content is a separate, opt-in surface stored in `scope`, and it
 * may be restricted to path globs.
 *
 * So "no scope" is a meaningful, safe state, not an empty form. The tier is stored
 * explicitly rather than inferred from `readPaths.length`, because "I picked
 * content and haven't added a path yet" and "I want deploy-only" must never
 * collapse into the same value — the first should mean the whole repo, the second
 * nothing at all, and guessing would silently over- or under-grant.
 *
 * ── What the server does with this ──────────────────────────────────────────
 *   - Patterns are re-validated and NORMALISED server-side; anything the matcher
 *     can't use is dropped rather than stored (packages/core source-access.ts).
 *   - `**` covers the whole repo; `src/**` covers `src` and everything under it.
 *   - Listing a directory that merely LEADS to a granted path is allowed, and the
 *     entries are filtered — so `src/**` lets an agent list `/` and see only `src/`.
 *   - A clone token needs UNRESTRICTED read, because a clone cannot be filtered.
 *     Partial read therefore disables local builds — surfaced as a summary line
 *     rather than left to be discovered at deploy time.
 */

import { WHOLE_REPO, normalizeRepoPattern, grantsWholeRepo, type SourceAccessScope } from "@repo/core";
import type { Permission } from "@/lib/api";

/** The three levels the modal offers, coarsest first. */
export type SourceTierId = "deploy" | "content" | "contentWrite";

export const SOURCE_TIERS: readonly SourceTierId[] = ["deploy", "content", "contentWrite"];

export interface SourceSelection {
  tier: SourceTierId;
  /** Empty ⇒ the whole repo. Non-empty ⇒ exactly these globs. */
  readPaths: string[];
  writePaths: string[];
}

export const DEPLOY_ONLY: SourceSelection = { tier: "deploy", readPaths: [], writePaths: [] };

/* ── Wire conversion ────────────────────────────────────────────────────────── */

/**
 * The `scope` to send. `undefined` for deploy-only — the ABSENCE of a scope is what
 * means metadata-only, so sending `{v:1}` would be wrong (the server parses an
 * empty scope back to undefined anyway, but being explicit keeps the payload
 * honest about intent).
 */
export function toScope(selection: SourceSelection): SourceAccessScope | undefined {
  if (selection.tier === "deploy") return undefined;
  const read = selection.readPaths.length > 0 ? selection.readPaths : [WHOLE_REPO];
  const scope: SourceAccessScope = { v: 1, read: { paths: read } };
  if (selection.tier === "contentWrite") {
    scope.write = {
      paths: selection.writePaths.length > 0 ? selection.writePaths : [WHOLE_REPO],
    };
  }
  return scope;
}

/**
 * Rebuild a selection from a stored grant, for editing.
 *
 * A scope naming write paths on a grant without the write VERB is shown as
 * read-only, matching how the server resolves it — the picker must not display
 * access the gate would refuse.
 */
export function fromScope(
  scope: SourceAccessScope | undefined | null,
  permissions: readonly Permission[] = [],
): SourceSelection {
  if (!scope?.read?.paths?.length) return DEPLOY_ONLY;
  const canWrite = permissions.some((p) => p === "write" || p === "admin");
  const writePaths = canWrite ? (scope.write?.paths ?? []) : [];
  const readPaths = grantsWholeRepo(scope.read.paths) ? [] : [...scope.read.paths];
  return {
    tier: writePaths.length > 0 ? "contentWrite" : "content",
    readPaths,
    writePaths: grantsWholeRepo(writePaths) ? [] : writePaths,
  };
}

/* ── Editing ────────────────────────────────────────────────────────────────── */

export type PathError = "invalid" | "duplicate";

/**
 * Add a glob, validating it with the SAME matcher the server enforces with — so a
 * rule can never be accepted here and silently dropped on save.
 */
export function addPath(
  paths: readonly string[],
  raw: string,
): { paths: string[]; error?: PathError } {
  const pattern = normalizeRepoPattern(raw);
  if (pattern === null) return { paths: [...paths], error: "invalid" };
  if (paths.includes(pattern)) return { paths: [...paths], error: "duplicate" };
  return { paths: [...paths, pattern] };
}

export function removePath(paths: readonly string[], pattern: string): string[] {
  return paths.filter((p) => p !== pattern);
}

/** Switch tier, keeping any paths already entered so exploring levels isn't lossy. */
export function setTier(selection: SourceSelection, tier: SourceTierId): SourceSelection {
  return { ...selection, tier };
}

/* ── Summary ────────────────────────────────────────────────────────────────── */

/**
 * Stable keys the component maps to copy. Derived from the selection, so the
 * summary cannot drift from the grant it describes.
 *
 * Unlike `capabilityDigest` in mcp-access-templates.ts, every line here is a
 * lossless statement about THIS grant — no claims about which tools exist — so it
 * can't go stale when a route is retagged.
 */
export type SummaryKey =
  | "deployOnly"
  | "readWholeRepo"
  | "readScoped"
  | "writeWholeRepo"
  | "writeScoped"
  | "cloneAllowed"
  | "cloneBlockedByScope";

export interface SummaryLine {
  key: SummaryKey;
  /** Paths the line refers to, for interpolation. */
  paths?: string[];
  tone: "neutral" | "warn";
}

export function summarize(selection: SourceSelection): SummaryLine[] {
  if (selection.tier === "deploy") {
    return [{ key: "deployOnly", tone: "neutral" }];
  }

  const lines: SummaryLine[] = [];
  const wholeRead = selection.readPaths.length === 0;
  lines.push(
    wholeRead
      ? { key: "readWholeRepo", tone: "neutral" }
      : { key: "readScoped", paths: selection.readPaths, tone: "neutral" },
  );

  if (selection.tier === "contentWrite") {
    lines.push(
      selection.writePaths.length === 0
        ? { key: "writeWholeRepo", tone: "warn" }
        : { key: "writeScoped", paths: selection.writePaths, tone: "neutral" },
    );
  }

  // Worth stating outright: a clone can't be path-filtered, so scoping the read
  // surface also blocks clone tokens — which is what a LOCAL build needs. Better
  // to say so while the owner is choosing than to have a deploy fail later.
  lines.push(
    wholeRead
      ? { key: "cloneAllowed", tone: "neutral" }
      : { key: "cloneBlockedByScope", tone: "warn" },
  );

  return lines;
}

/* ── Validation ─────────────────────────────────────────────────────────────── */

export type SelectionProblem = "writeNeedsWritePermission";

/**
 * Problems that must block saving. The write SURFACE is inert without the write
 * VERB (the server resolves `writePaths` to nothing), so offering it without the
 * permission would be a toggle that silently does nothing.
 */
export function problems(
  selection: SourceSelection,
  permissions: readonly Permission[],
): SelectionProblem[] {
  const out: SelectionProblem[] = [];
  if (selection.tier === "contentWrite" && !permissions.some((p) => p === "write" || p === "admin")) {
    out.push("writeNeedsWritePermission");
  }
  return out;
}

/** Does this selection grant any content at all? Drives the "changed" affordance. */
export function grantsContent(selection: SourceSelection): boolean {
  return selection.tier !== "deploy";
}
