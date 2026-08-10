import { cache } from "react";
import { marked } from "marked";

/**
 * The website changelog is driven by the repo's `CHANGELOG.md` (single source of
 * truth) — fetched at runtime with a short cache. Prose comes from the markdown;
 * dates and "which versions are public" come from the repo's git **tags** (a
 * version appears only once it's tagged, so an unreleased `## X.Y.Z` heading
 * stays hidden). Tags — not GitHub Release objects — because this repo tags every
 * release but doesn't always publish a matching Release, so tags are the complete,
 * reliable signal.
 */

const REPO = "oblien/openship";
const RAW_URL = `https://raw.githubusercontent.com/${REPO}/main/CHANGELOG.md`;
const TAGS_URL = `https://api.github.com/repos/${REPO}/tags?per_page=100`;
const commitUrl = (ref: string) => `https://api.github.com/repos/${REPO}/commits/${ref}`;
const REVALIDATE = 600; // 10 minutes

export interface ChangelogEntry {
  /** Bare semver, e.g. "0.2.4". */
  version: string;
  /** Display form, e.g. "v0.2.4". */
  displayVersion: string;
  /** Shareable slug, e.g. "v0-2-4" (matches the historical fumadocs slugs). */
  slug: string;
  /** ISO date of the version's git tag. */
  date: string;
  tags: string[];
  /** Plain-text first paragraph — used for meta descriptions / the deep-link header. */
  summary: string;
  /** Rendered HTML of the version's body. */
  html: string;
}

marked.setOptions({ gfm: true });

function ghHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "openship-web",
  };
  // Optional — lifts the 60/hr unauth limit; not required given the short cache.
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

/** Split CHANGELOG.md into `{ version, body }` by each `## X.Y.Z` heading. */
function parseChangelog(md: string): { version: string; body: string }[] {
  const out: { version: string; body: string[] }[] = [];
  let cur: { version: string; body: string[] } | null = null;
  for (const line of md.split(/\r?\n/)) {
    const m = line.match(/^##\s+(\d+\.\d+\.\d+)\b/);
    if (m) {
      cur = { version: m[1], body: [] };
      out.push(cur);
      continue;
    }
    if (cur) cur.body.push(line);
  }
  return out.map((e) => ({ version: e.version, body: e.body.join("\n").trim() }));
}

/** Plain text of the first real paragraph, with light markdown stripped. */
function firstParagraph(body: string): string {
  const para = body
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .find((s) => s.length > 0 && !s.startsWith("#") && !s.startsWith(">") && !s.startsWith("-"));
  if (!para) return "";
  return para
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .replace(/\[(.+?)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Lightly infer tag pills from the section content. */
function inferTags(body: string): string[] {
  const tags = ["feature"];
  if (/\bfix(es|ed)?\b/i.test(body)) tags.push("fix");
  if (/\b(security|advisor|CVE|vulnerab)/i.test(body)) tags.push("security");
  if (/\bbreaking\b/i.test(body)) tags.push("breaking");
  return tags;
}

/** Set of released versions (bare semver) taken from the repo's git tags. */
async function fetchTaggedVersions(): Promise<Set<string>> {
  const res = await fetch(TAGS_URL, { headers: ghHeaders(), next: { revalidate: REVALIDATE } });
  if (!res.ok) return new Set();
  const tags = (await res.json()) as { name?: string }[];
  return new Set(
    tags.map((t) => t.name?.replace(/^v/, "")).filter((v): v is string => Boolean(v)),
  );
}

/** ISO date of the commit a version's tag points to, or null. */
async function fetchTagDate(version: string): Promise<string | null> {
  const res = await fetch(commitUrl(`v${version}`), {
    headers: ghHeaders(),
    next: { revalidate: REVALIDATE },
  });
  if (!res.ok) return null;
  const j = (await res.json()) as {
    commit?: { committer?: { date?: string }; author?: { date?: string } };
  };
  return j.commit?.committer?.date ?? j.commit?.author?.date ?? null;
}

/**
 * Load the changelog. Cached per-request via `React.cache` (the list and the
 * deep-link pages share one fetch); each `fetch` is additionally cached for
 * {@link REVALIDATE} seconds. Returns `[]` on any failure — Next serves the last
 * good copy across a failed revalidation, and the page renders an empty state.
 */
export const getChangelog = cache(async (): Promise<ChangelogEntry[]> => {
  try {
    const [mdRes, tagged] = await Promise.all([
      fetch(RAW_URL, { next: { revalidate: REVALIDATE } }),
      fetchTaggedVersions(),
    ]);
    if (!mdRes.ok) return [];
    const md = await mdRes.text();

    // Gate to tagged (released) versions, then date each from its tag commit.
    const gated = parseChangelog(md).filter((e) => tagged.has(e.version));
    const dated = await Promise.all(
      gated.map(async (e) => ({ ...e, date: await fetchTagDate(e.version) })),
    );

    const entries: ChangelogEntry[] = [];
    for (const { version, body, date } of dated) {
      if (!date) continue; // a tagged version we couldn't date — skip rather than guess
      entries.push({
        version,
        displayVersion: `v${version}`,
        slug: `v${version.replace(/\./g, "-")}`,
        date,
        tags: inferTags(body),
        summary: firstParagraph(body),
        html: await marked.parse(body),
      });
    }
    entries.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    return entries;
  } catch {
    return [];
  }
});
