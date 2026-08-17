/**
 * Unified "version identity" for anything Openship can update — one discriminated
 * shape covering the three drift kinds so a single resolver/scanner and a single
 * banner can treat git projects, release/dist projects, the self-app, and
 * image-based apps the same way. This is the commit-OR-tag unification: instead
 * of a bespoke check per kind, every updatable entity produces a `current` and a
 * `latest` UpdatableIdentity, and `isBehind` decides whether an update exists.
 */

import { compareSemver } from "./semver";

/** How an entity's version is identified. */
export type UpdatableKind = "commit" | "release" | "image";

export type UpdatableIdentity =
  /** Git-backed project: the deployed vs remote-HEAD commit sha. */
  | { kind: "commit"; sha: string; branch?: string; message?: string }
  /** Release/dist project or the self-app/webmail: a semver/tag. */
  | { kind: "release"; version: string; tag?: string }
  /**
   * Image-based app (compose/services template): a mutable tag plus the
   * content-addressable digest actually running. `digest` is what makes a moved
   * `:latest`/`:1` detectable — the tag string alone never changes.
   */
  | { kind: "image"; ref: string; digest?: string };

/** True when `a` and `b` are the same kind (comparing across kinds is meaningless). */
export function sameKind(a: UpdatableIdentity, b: UpdatableIdentity): boolean {
  return a.kind === b.kind;
}

/** Git's own floor for an abbreviated sha — `core.abbrev` never goes below 7. */
const MIN_ABBREV = 7;

/** Hex sha, full or abbreviated. Anything else (a tag, a branch, `HEAD`) is not comparable. */
const HEX_SHA = /^[0-9a-f]{1,40}$/;

/** A full, canonical commit sha — what the GitHub API returns and what we store. */
export function isFullCommitSha(v: string | null | undefined): boolean {
  return /^[0-9a-f]{40}$/i.test(v?.trim() ?? "");
}

function normalizeSha(v: string | null | undefined): string | null {
  const s = v?.trim().toLowerCase();
  return s && HEX_SHA.test(s) ? s : null;
}

/** Verdict of comparing two commit refs by value. `unknown` = not comparable. */
export type CommitShaMatch = "same" | "different" | "unknown";

/**
 * Do two commit refs name the same commit? Deliberately not string equality: the
 * two sides come from different places. A branch HEAD arrives from the GitHub API
 * as all 40 hex chars, while a deployment's stored sha is whatever the caller that
 * triggered it supplied — `openship deploy --commit 1eeaf76`, an MCP call, a CI
 * script — and git checks that out happily, so the deploy is correct while the row
 * records an abbreviation. Comparing those by bytes reads one commit as two, and
 * since every surface renders `sha.slice(0, 7)`, the operator is told "new commit
 * available 1eeaf76 — you're deployed on 1eeaf76".
 *
 * Three-valued because "not provably equal" is not the same as "different", and
 * only a provable difference may drive a nudge:
 *   - a ref that isn't a hex sha at all (a tag, a branch name) → `unknown`
 *   - a prefix match below git's abbreviation floor → `unknown`, not a guess
 *   - a prefix match at or above it → `same`; two distinct commits sharing seven
 *     hex chars is a collision git itself calls ambiguous, and the far rarer
 *     failure than an update we advertise forever.
 */
export function compareCommitSha(
  a: string | null | undefined,
  b: string | null | undefined,
): CommitShaMatch {
  const x = normalizeSha(a);
  const y = normalizeSha(b);
  if (!x || !y) return "unknown";
  if (x === y) return "same";
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (!long.startsWith(short)) return "different";
  return short.length >= MIN_ABBREV ? "same" : "unknown";
}

/**
 * Is `current` behind `latest` (i.e. an update is available)?
 *
 *   - release → semver comparison (`compareSemver`), the single source of truth.
 *   - commit  → a PROVABLE sha difference (`compareCommitSha`); an abbreviated or
 *               non-sha ref on either side is no evidence, not new commits.
 *   - image   → digest inequality when BOTH digests are known; if either digest
 *               is unknown, fall back to ref/tag inequality. Unknown-vs-unknown
 *               (no digest either side) → NOT behind (we can't claim an update
 *               without evidence — fail-soft, never a false "update available").
 *
 * Mismatched kinds → false (never claim drift we can't reason about).
 */
export function isBehind(current: UpdatableIdentity, latest: UpdatableIdentity): boolean {
  if (current.kind !== latest.kind) return false;

  if (current.kind === "release" && latest.kind === "release") {
    return compareSemver(current.version, latest.version) < 0;
  }

  if (current.kind === "commit" && latest.kind === "commit") {
    return compareCommitSha(current.sha, latest.sha) === "different";
  }

  if (current.kind === "image" && latest.kind === "image") {
    // Compare the content digest only (the `sha256:…` part). The two sides come
    // from different sources with different prefixes — a stored RepoDigest
    // (`repo@sha256:…`) vs a registry manifest digest (`sha256:…`) — so full-
    // string comparison would falsely differ.
    const a = digestSha(current.digest);
    const b = digestSha(latest.digest);
    if (a && b) return a !== b;
    // Missing a digest on either side: only claim behind if the resolvable
    // reference actually differs; otherwise we have no evidence → not behind.
    if (current.ref && latest.ref && current.ref !== latest.ref) return true;
    return false;
  }

  return false;
}

/** Extract the `sha256:…` content digest from `repo@sha256:…` or a bare digest. */
export function digestSha(digest?: string): string | undefined {
  if (!digest) return undefined;
  const at = digest.lastIndexOf("@");
  return at >= 0 ? digest.slice(at + 1) : digest;
}

/** Compact human label for an identity — used in logs / UI subtitles. */
export function identityLabel(id: UpdatableIdentity): string {
  switch (id.kind) {
    case "commit":
      return id.sha.slice(0, 7);
    case "release":
      return id.version;
    case "image":
      return id.digest ? `${id.ref} (${id.digest.split(":").pop()?.slice(0, 12)})` : id.ref;
  }
}
