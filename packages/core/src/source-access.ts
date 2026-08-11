/**
 * @module source-access
 *
 * Source-access scope — WHICH surface of a repository a grant reaches, and WHERE
 * inside it. Shared verbatim by the API (enforcement) and the dashboard
 * (client-side validation + the summary panel), so a rule can never be described
 * one way in the picker and enforced another way at the gate.
 *
 * ── The two dimensions ───────────────────────────────────────────────────────
 * A grant row carries BOTH:
 *
 *   permissions[]  the VERB      — read (may use this repo), write (may mutate),
 *                                  admin (may destroy)
 *   scope          the SURFACE   — this module: may it read file CONTENT, and
 *                                  under which paths
 *
 * They do not overlap, and the absence of a scope is meaningful:
 *
 *   read + no scope                 → metadata only (branches, detect, deploy).
 *                                     THIS IS THE DEFAULT. A repo grant does not
 *                                     imply the right to crawl the repo.
 *   read + { read: { paths } }      → file content, restricted to those paths
 *   write + { write: { paths } }    → content writes under those paths
 *
 * Deliberately NOT encoded as extra `Permission` values: that union is closed and
 * `rowToGrant` silently DROPS unknown strings, so a typo'd capability would fail
 * open into "no restriction recorded". A separate column fails closed instead.
 *
 * ── Matching rules ──────────────────────────────────────────────────────────
 *   *   matches any characters within ONE path segment (never crosses "/")
 *   **  matches zero or more WHOLE segments, so "src/**" covers "src" itself and
 *       everything beneath it — one pattern per subtree, no "src" + "src/**" pair
 *
 * Allow-list only. There are no deny rules: precedence between allow and deny is
 * ordering-dependent and easy to get subtly wrong, and nothing needs it.
 *
 * Paths are matched CASE-SENSITIVELY, because Git paths are. (Repo *identity* is
 * lowercased elsewhere — see github-access.ts — but that is the owner/repo key,
 * not the path.)
 */

/** Pattern granting the entire repository. */
export const WHOLE_REPO = "**";

/** Scope stored per grant row. `v` guards the shape if it ever has to change. */
export interface SourceAccessScope {
  v: 1;
  /** Content READ surface. Absent ⇒ no content access at all (metadata only). */
  read?: { paths: string[] };
  /** Content WRITE surface. Absent ⇒ no writes. Also requires "write" in permissions. */
  write?: { paths: string[] };
}

/** Resolved, ready-to-match view of a caller's effective source access. */
export interface ResolvedSourceAccess {
  readPaths: string[];
  writePaths: string[];
}

export const NO_SOURCE_ACCESS: ResolvedSourceAccess = { readPaths: [], writePaths: [] };

/** Bounds — a pattern or path beyond these is rejected rather than matched. */
const MAX_LENGTH = 1024;
const MAX_SEGMENTS = 64;

/**
 * Normalise a concrete repo-relative path (from `?file=` / `?path=`).
 *
 * Returns null for anything we refuse to reason about, and callers MUST treat null
 * as "deny" rather than "no restriction". Rejects traversal outright instead of
 * resolving it: a path that tried to escape is a caller bug or an attack, and
 * silently rewriting it to something valid would hide both.
 */
export function normalizeRepoPath(input: string): string | null {
  if (typeof input !== "string") return null;
  if (input.length > MAX_LENGTH) return null;
  // A NUL or a backslash means the caller is not speaking Git paths.
  if (input.includes("\0") || input.includes("\\")) return null;

  const segments: string[] = [];
  for (const raw of input.split("/")) {
    if (raw === "" || raw === ".") continue; // leading "/", "//", "./" — harmless noise
    if (raw === "..") return null; // traversal: refuse, never resolve
    segments.push(raw);
  }
  if (segments.length === 0) return ""; // the repo root
  if (segments.length > MAX_SEGMENTS) return null;
  return segments.join("/");
}

/**
 * Normalise a glob pattern authored in the picker. Same rules as a path, plus `*`
 * and `**` are legal segments. A `**` may only appear as a WHOLE segment —
 * `sr**c` is rejected rather than quietly treated as `sr*c`.
 */
export function normalizeRepoPattern(input: string): string | null {
  if (typeof input !== "string") return null;
  if (input.length > MAX_LENGTH) return null;
  if (input.includes("\0") || input.includes("\\")) return null;

  const segments: string[] = [];
  for (const raw of input.split("/")) {
    if (raw === "" || raw === ".") continue;
    if (raw === "..") return null;
    // "**" is only meaningful alone; embedded in a longer segment it is ambiguous.
    if (raw.includes("**") && raw !== "**") return null;
    segments.push(raw);
  }
  if (segments.length === 0) return null; // an empty pattern grants nothing — say so
  if (segments.length > MAX_SEGMENTS) return null;
  return segments.join("/");
}

/**
 * Match one segment against one pattern segment, where `*` matches any run of
 * characters inside the segment.
 *
 * Greedy with backtracking (the classic two-pointer wildcard walk) so it is
 * O(n·m) — a regex build would need escaping every other metacharacter, and a
 * naive recursive version is exponential on patterns like `a*a*a*a*b`.
 */
function segmentMatches(seg: string, pat: string): boolean {
  if (pat === "*") return true;
  if (!pat.includes("*")) return seg === pat;

  let s = 0;
  let p = 0;
  let starP = -1;
  let starS = -1;
  while (s < seg.length) {
    if (p < pat.length && (pat[p] === seg[s] || pat[p] === "*")) {
      if (pat[p] === "*") {
        starP = p;
        starS = s;
        p++;
        continue;
      }
      s++;
      p++;
    } else if (starP !== -1) {
      starS++;
      s = starS;
      p = starP + 1;
    } else {
      return false;
    }
  }
  while (p < pat.length && pat[p] === "*") p++;
  return p === pat.length;
}

/**
 * Match a normalised path against a normalised pattern, segment-wise, with `**`
 * consuming zero or more whole segments. Same two-pointer shape as above, one
 * level up, so a pattern full of `**` cannot blow up.
 */
function pathMatchesPattern(path: string, pattern: string): boolean {
  const p = path === "" ? [] : path.split("/");
  const q = pattern.split("/");

  let pi = 0;
  let qi = 0;
  let starQ = -1;
  let starP = -1;

  while (pi < p.length) {
    if (qi < q.length && q[qi] === "**") {
      starQ = qi;
      starP = pi;
      qi++;
    } else if (qi < q.length && segmentMatches(p[pi]!, q[qi]!)) {
      pi++;
      qi++;
    } else if (starQ !== -1) {
      starP++;
      pi = starP;
      qi = starQ + 1;
    } else {
      return false;
    }
  }
  // Trailing "**" segments match the empty remainder — this is what makes
  // "src/**" cover "src" itself.
  while (qi < q.length && q[qi] === "**") qi++;
  return qi === q.length;
}

/**
 * Is `path` granted by any of `patterns`?
 *
 * Fails closed on every uncertainty: an unnormalisable path, an empty pattern
 * list, or an unnormalisable pattern all deny. An empty list is "grants nothing",
 * NOT "grants everything" — the difference is the whole feature.
 */
export function matchesAny(path: string, patterns: readonly string[]): boolean {
  if (!Array.isArray(patterns) || patterns.length === 0) return false;
  const target = normalizeRepoPath(path);
  if (target === null) return false;
  for (const raw of patterns) {
    const pattern = normalizeRepoPattern(raw);
    if (pattern === null) continue; // ignore a bad rule; never let it widen access
    if (pathMatchesPattern(target, pattern)) return true;
  }
  return false;
}

/**
 * Could `dir` CONTAIN something the patterns grant?
 *
 * This is what keeps a path-restricted grant usable. Given `read.paths =
 * ["src/**"]`, listing the repo root must not 403 (the caller could never
 * discover `src/`) and must not return the whole tree (that leaks every top-level
 * name). It returns `src/` alone: entries that are granted, or that are ancestors
 * of something granted.
 *
 * A `**` anywhere in a pattern means any deeper directory might match, so we stop
 * at the first `**` and treat everything below as potentially granted.
 */
export function isAncestorOfAny(dir: string, patterns: readonly string[]): boolean {
  if (!Array.isArray(patterns) || patterns.length === 0) return false;
  const target = normalizeRepoPath(dir);
  if (target === null) return false;
  if (target === "") return true; // the root is an ancestor of everything granted
  const segs = target.split("/");

  for (const raw of patterns) {
    const pattern = normalizeRepoPattern(raw);
    if (pattern === null) continue;
    const q = pattern.split("/");

    let ok = true;
    for (let i = 0; i < segs.length; i++) {
      const pat = q[i];
      if (pat === undefined) {
        // Pattern ran out: it names something SHALLOWER than dir, so dir is only
        // inside it if the pattern ended in "**" (handled by matchesAny instead).
        ok = false;
        break;
      }
      if (pat === "**") break; // anything below here may match
      if (!segmentMatches(segs[i]!, pat)) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * Is a directory listing entry visible under `patterns`? A file must be granted
 * outright; a directory is shown when it is granted OR leads somewhere granted.
 */
export function entryVisible(
  path: string,
  isDirectory: boolean,
  patterns: readonly string[],
): boolean {
  if (matchesAny(path, patterns)) return true;
  return isDirectory && isAncestorOfAny(path, patterns);
}

/**
 * Does this allow-list grant the ENTIRE repository?
 *
 * Needed because some operations cannot be path-filtered. A `git clone` hands over
 * every byte, so a clone credential must require unrestricted content access —
 * granting it to a caller scoped to `src/**` would quietly hand them the rest of
 * the repo and make the path restriction decorative.
 *
 * True only when some pattern is `**` all the way down (`**`, `**​/**`). `*`
 * matches one segment, so `["*"]` is not whole-repo, and neither is `src/**`.
 */
export function grantsWholeRepo(patterns: readonly string[]): boolean {
  if (!Array.isArray(patterns)) return false;
  return patterns.some((raw) => {
    const pattern = normalizeRepoPattern(raw);
    return pattern !== null && pattern.split("/").every((s) => s === "**");
  });
}

/* ------------------------------------------------------------------ */
/*  Persistence                                                        */
/* ------------------------------------------------------------------ */

function cleanPaths(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const pattern = normalizeRepoPattern(raw);
    if (pattern !== null && !out.includes(pattern)) out.push(pattern);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Parse a stored `scope_json`. Anything malformed → `undefined`, which the
 * resolver reads as metadata-only. Fails CLOSED: a corrupt scope must never be
 * mistaken for "unrestricted".
 */
export function parseSourceAccessScope(
  json: string | null | undefined,
): SourceAccessScope | undefined {
  if (!json) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;

  const obj = parsed as Record<string, unknown>;
  if (obj.v !== 1) return undefined; // unknown version → deny, don't guess

  const read = cleanPaths((obj.read as Record<string, unknown> | undefined)?.paths);
  const write = cleanPaths((obj.write as Record<string, unknown> | undefined)?.paths);
  if (!read && !write) return undefined;

  return {
    v: 1,
    ...(read ? { read: { paths: read } } : {}),
    ...(write ? { write: { paths: write } } : {}),
  };
}

/** Serialise for storage. A scope granting nothing stores as null, not "{}". */
export function serializeSourceAccessScope(
  scope: SourceAccessScope | undefined | null,
): string | null {
  if (!scope) return null;
  const read = cleanPaths(scope.read?.paths);
  const write = cleanPaths(scope.write?.paths);
  if (!read && !write) return null;
  return JSON.stringify({
    v: 1,
    ...(read ? { read: { paths: read } } : {}),
    ...(write ? { write: { paths: write } } : {}),
  });
}

/**
 * Is `candidate` entirely contained by `envelope`?
 *
 * Used at mint time: a token's scope must never exceed the minter's own. Every
 * candidate pattern has to be covered by some envelope pattern. Patterns are
 * compared by MATCHING the candidate pattern's literal prefix against the
 * envelope — `src/**` ⊆ `**`, and `src/**` ⊄ `src/a/**`.
 */
export function scopeIsSubset(
  candidate: readonly string[],
  envelope: readonly string[],
): boolean {
  if (!Array.isArray(candidate) || candidate.length === 0) return true; // grants nothing
  if (!Array.isArray(envelope) || envelope.length === 0) return false;
  return candidate.every((raw) => {
    const pattern = normalizeRepoPattern(raw);
    if (pattern === null) return false;
    // A pattern is covered when the envelope grants its most permissive reach.
    // Replace trailing "**" with a probe segment so "src/**" tests as a path
    // under src rather than as the literal string "src/**".
    const probe = pattern
      .split("/")
      .map((s) => (s === "**" ? " probe" : s))
      .join("/")
      .replace(/ probe/g, "__any__");
    return matchesAny(probe, envelope) || matchesAny(pattern, envelope);
  });
}
