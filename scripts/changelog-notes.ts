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
 * malformed changelog included, and the file imports nothing outside node: so
 * it runs on a bare `bun` with no `bun install`.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** GitHub rejects a release body over 125,000 chars — stay clear of the edge. */
export const MAX_BODY_LENGTH = 120_000;

/** A level-2 heading that names a version: `## 0.6.1`, `## v0.6.1 — 2026-01-01`,
 *  `## [0.6.1] - 2026-01-01`. Levels 3+ (`### Fixes`) are section content. */
const VERSION_HEADING = /^##\s+v?\[?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)*)\]?/;

/** Strip a leading `v` and surrounding whitespace: `v0.6.1` → `0.6.1`. */
export function normalizeVersion(input: string): string {
  return input.trim().replace(/^v/i, "");
}

/**
 * The body of `version`'s section: everything after its `## <version>` heading
 * up to the next version heading (or EOF), trimmed of blank edges. Returns null
 * when the version has no section, or when its section is empty.
 */
export function extractChangelogSection(changelog: string, version: string): string | null {
  const want = normalizeVersion(version);
  if (!want) return null;

  const lines = changelog.split(/\r?\n/);
  let start = -1;
  let end = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const m = VERSION_HEADING.exec(lines[i]);
    if (!m) continue;
    if (start === -1) {
      if (m[1] === want) start = i + 1;
    } else {
      // The next version heading closes the section (newest-at-top ordering is
      // irrelevant here — we bound on headings, not on order).
      end = i;
      break;
    }
  }

  if (start === -1) return null;
  const body = lines.slice(start, end).join("\n").trim();
  return body.length > 0 ? body : null;
}

/** Cut `body` to `max` chars on a line boundary, with a pointer to the rest. */
export function truncateBody(body: string, changelogUrl: string, max = MAX_BODY_LENGTH): string {
  if (body.length <= max) return body;
  const notice = `\n\n…truncated. Read the full entry in [CHANGELOG.md](${changelogUrl}).`;
  const room = max - notice.length;
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
  const repo = opts.repo || "oblien/openship";
  const version = normalizeVersion(tag);
  const base = version.split("-")[0];
  const changelogUrl = `https://github.com/${repo}/blob/${tag}/CHANGELOG.md`;

  let body = extractChangelogSection(changelog, version);
  if (!body && base !== version) {
    const upcoming = extractChangelogSection(changelog, base);
    if (upcoming) {
      body = `_Prerelease of ${base} — notes for the upcoming release:_\n\n${upcoming}`;
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
  const args = process.argv.slice(2);
  const tag = args.find((a) => !a.startsWith("--"));
  if (!tag) {
    console.error("Usage: bun scripts/changelog-notes.ts <tag> [--changelog <path>]");
    process.exit(1);
  }
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const path =
    args.find((a) => a.startsWith("--changelog="))?.slice("--changelog=".length) ??
    join(root, "CHANGELOG.md");

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
