#!/usr/bin/env bun
/**
 * Build the GitHub Release body for a tag from the root CHANGELOG.md.
 *
 * Usage:
 *   bun scripts/changelog-notes.ts v0.6.1            # → release body on stdout
 *   bun scripts/changelog-notes.ts 0.6.1 --changelog path/to/CHANGELOG.md
 *
 * `.github/workflows/release.yml` runs this in the `publish` job and hands the
 * output to `gh release create --notes-file`, so the release description
 * carries the version's changelog section instead of the tag message (the
 * release tags are LIGHTWEIGHT, so the old `--notes-from-tag` had nothing but
 * the "Bump to vX.Y.Z" commit subject to work with).
 *
 * This must NEVER fail a release: every path returns a body, missing or
 * malformed changelog included. Its imports are Node built-ins and the pure core
 * changelog module, so it runs on a bare `bun` with no `bun install`.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// Import the dependency-free module directly: publishing needs no workspace install.
import {
  extractChangelogSection,
  normalizeChangelogVersion as normalizeVersion,
} from "../packages/core/src/updates/changelog-parser";
import { GITHUB_REPO } from "../packages/core/src/updates/types";
export { extractChangelogSection, normalizeVersion };

/** GitHub rejects a release body over 125,000 chars — stay clear of the edge. */
export const MAX_BODY_LENGTH = 120_000;

/** Cut `body` to `max` chars on a line boundary, with a pointer to the rest. */
export function truncateBody(body: string, changelogUrl: string, max = MAX_BODY_LENGTH): string {
  const limit = Number.isFinite(max)
    ? Math.max(0, Math.min(MAX_BODY_LENGTH, Math.floor(max)))
    : MAX_BODY_LENGTH;
  if (body.length <= limit) return body;
  const fullNotice = `\n\n…truncated. Read the full entry in [CHANGELOG.md](${changelogUrl}).`;
  const notice = fullNotice.length < limit ? fullNotice : "\n\n…truncated.";
  if (notice.length >= limit) return body.slice(0, limit);
  const room = limit - notice.length;
  const head = body.slice(0, room);
  const lastBreak = head.lastIndexOf("\n");
  return (lastBreak > room / 2 ? head.slice(0, lastBreak) : head).trimEnd() + notice;
}

/**
 * The release body for `tag`. Order of preference:
 *   1. the tag's own changelog section;
 *   2. for a prerelease (`v0.7.0-rc.1`), the base version's section if the
 *      changelog is already written for the upcoming release, clearly labelled;
 *   3. a generic body pointing at CHANGELOG.md — a version with no entry
 *      (several shipped tags have none) must still publish.
 */
export function buildReleaseNotes(
  changelog: string,
  tag: string,
  opts: { repo?: string; max?: number } = {},
): string {
  const repo = opts.repo || GITHUB_REPO;
  const version = normalizeVersion(tag);
  const prereleaseBase = version.match(/^(\d+\.\d+\.\d+)-/)?.[1];
  const changelogUrl = `https://github.com/${repo}/blob/${encodeURIComponent(tag)}/CHANGELOG.md`;

  let body = extractChangelogSection(changelog, version);
  if (!body && prereleaseBase) {
    const upcoming = extractChangelogSection(changelog, prereleaseBase);
    if (upcoming) {
      body = `_Prerelease of ${prereleaseBase} — notes for the upcoming release:_\n\n${upcoming}`;
    }
  }
  if (!body) {
    body =
      `No changelog entry for ${version} yet — see [CHANGELOG.md](${changelogUrl}) ` +
      `for the full history.`;
  }

  return truncateBody(body, changelogUrl, opts.max ?? MAX_BODY_LENGTH);
}

/* ─── CLI ───────────────────────────────────────────────────────────── */

if (import.meta.main) {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: { changelog: { type: "string" } },
  });
  const [tag] = positionals;
  if (!tag || positionals.length !== 1) {
    console.error("Usage: bun scripts/changelog-notes.ts <tag> [--changelog <path>]");
    process.exit(1);
  }
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const path = values.changelog ?? join(root, "CHANGELOG.md");

  let changelog = "";
  try {
    changelog = readFileSync(path, "utf8");
  } catch {
    // An unreadable CHANGELOG.md is not a reason to fail the release — fall
    // through to the generic body.
    console.error(`::warning::could not read ${path} — publishing generic release notes`);
  }
  process.stdout.write(buildReleaseNotes(changelog, tag, { repo: process.env.GITHUB_REPOSITORY }));
}
