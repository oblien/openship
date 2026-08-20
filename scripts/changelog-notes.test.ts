/**
 * `bun run test:scripts` (→ `bun test ./scripts/`), which the root `test`
 * script — and therefore CI — chains after the turbo/vitest run. scripts/ is
 * outside every workspace, so there is no vitest project to host this; the
 * scripts are already `#!/usr/bin/env bun`, so bun's own runner is the
 * zero-config fit.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MAX_BODY_LENGTH,
  buildReleaseNotes,
  extractChangelogSection,
  truncateBody,
} from "./changelog-notes";

const SAMPLE = `# Changelog

All notable changes to Openship.

## 0.6.1

Headline paragraph.

### Networking

- Did a thing with \`backticks\` and "quotes".

## 0.4.9

### Rollback

- Older entry.

## 0.4.7
`;

describe("extractChangelogSection", () => {
  test("returns the section body up to the next version heading", () => {
    const body = extractChangelogSection(SAMPLE, "0.6.1");
    expect(body).toBe(
      [
        "Headline paragraph.",
        "",
        "### Networking",
        "",
        '- Did a thing with `backticks` and "quotes".',
      ].join("\n"),
    );
  });

  test("accepts a v-prefixed tag and stops before the following version", () => {
    const body = extractChangelogSection(SAMPLE, "v0.4.9");
    expect(body).toBe(["### Rollback", "", "- Older entry."].join("\n"));
    expect(body).not.toContain("0.4.7");
  });

  test("returns null for a missing version and for an empty trailing section", () => {
    expect(extractChangelogSection(SAMPLE, "9.9.9")).toBeNull();
    expect(extractChangelogSection(SAMPLE, "0.4.7")).toBeNull();
  });

  test("does not match a prefix of another version", () => {
    expect(extractChangelogSection("## 0.6.10\n\nten\n", "0.6.1")).toBeNull();
  });

  test("tolerates dated and bracketed headings", () => {
    expect(extractChangelogSection("## [1.2.3] - 2026-01-02\n\nnotes\n", "1.2.3")).toBe("notes");
    expect(extractChangelogSection("## v1.2.3 — 2026-01-02\n\nnotes\n", "1.2.3")).toBe("notes");
  });
});

describe("buildReleaseNotes", () => {
  test("uses the version's own section", () => {
    expect(buildReleaseNotes(SAMPLE, "v0.6.1")).toContain("Headline paragraph.");
  });

  test("falls back to a CHANGELOG pointer when the version has no entry", () => {
    const notes = buildReleaseNotes(SAMPLE, "v9.9.9", { repo: "oblien/openship" });
    expect(notes).toContain("No changelog entry for 9.9.9");
    expect(notes).toContain("https://github.com/oblien/openship/blob/v9.9.9/CHANGELOG.md");
  });

  test("never throws on an empty or malformed changelog", () => {
    expect(buildReleaseNotes("", "v1.0.0")).toContain("No changelog entry for 1.0.0");
    expect(buildReleaseNotes("###### not a version\n#\n##\n", "v1.0.0")).toContain("CHANGELOG.md");
  });

  test("a prerelease borrows its base version's section, labelled", () => {
    const notes = buildReleaseNotes(SAMPLE, "v0.6.1-rc.2");
    expect(notes).toStartWith("_Prerelease of 0.6.1 —");
    expect(notes).toContain("Headline paragraph.");
  });

  test("a prerelease with its own section prefers it", () => {
    const changelog = "## 0.7.0-rc.1\n\nrc notes\n\n## 0.7.0\n\nstable notes\n";
    expect(buildReleaseNotes(changelog, "v0.7.0-rc.1")).toBe("rc notes");
  });

  test("stays under GitHub's release-body limit", () => {
    const huge = `## 1.0.0\n\n${"- a very long bullet line\n".repeat(20000)}`;
    const notes = buildReleaseNotes(huge, "v1.0.0");
    expect(huge.length).toBeGreaterThan(MAX_BODY_LENGTH);
    expect(notes.length).toBeLessThanOrEqual(MAX_BODY_LENGTH);
    expect(notes).toContain("…truncated.");
  });

  test("truncateBody cuts on a line boundary", () => {
    const out = truncateBody("aaa\nbbb\nccc\n", "https://example.test/CHANGELOG.md", 80);
    expect(out.split("\n")[0]).toBe("aaa");
  });
});

describe("the real CHANGELOG.md", () => {
  const changelog = readFileSync(
    join(dirname(dirname(fileURLToPath(import.meta.url))), "CHANGELOG.md"),
    "utf8",
  );

  test("every documented version resolves to a non-empty section", () => {
    const versions = [...changelog.matchAll(/^##\s+v?(\d+\.\d+\.\d+[^\s]*)/gm)].map((m) => m[1]);
    expect(versions.length).toBeGreaterThan(0);
    for (const v of versions) {
      const body = extractChangelogSection(changelog, v);
      expect(body, `section for ${v}`).toBeTruthy();
      expect(body).not.toContain(`## ${v}`);
    }
  });

  test("the current package version yields a valid body either way", () => {
    // Not every release has a section (0.5.0, 0.5.5, 0.6.0 and 0.6.5 shipped
    // without one), so the honest contract is: a real section when one exists,
    // the changelog-link fallback when it doesn't, never an empty body.
    const root = dirname(dirname(fileURLToPath(import.meta.url)));
    const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string;
    const notes = buildReleaseNotes(changelog, `v${version}`);
    const hasSection = extractChangelogSection(changelog, version) !== null;
    if (hasSection) expect(notes).not.toContain("No changelog entry");
    else expect(notes).toContain("CHANGELOG.md");
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.length).toBeLessThanOrEqual(MAX_BODY_LENGTH);
  });

  test("a version with a real section gets its notes, and they fit the limit", () => {
    // 0.6.1 is pinned as a version known to carry a section, so this cannot
    // rot when a future release ships without one.
    const notes = buildReleaseNotes(changelog, "v0.6.1");
    expect(notes).not.toContain("No changelog entry");
    expect(notes.length).toBeLessThanOrEqual(MAX_BODY_LENGTH);
  });
});
