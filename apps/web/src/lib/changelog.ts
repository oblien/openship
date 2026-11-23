import { reportCaughtError } from "@repo/core/diagnostics";
import { unstable_cache } from "next/cache";
import { loadPublishedChangelog, CHANGELOG_REVALIDATE } from "./changelog-source";
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

/** One bullet from the changelog, split into a headline and the prose under it. */
export interface ChangelogItem {
  /** Inline HTML of the headline — the row you see while the item is collapsed. */
  title: string;
  /** Rendered HTML of the detail, or `""` for a one-liner that has nothing to open. */
  detailHtml: string;
}

/** One `### ` group inside a version. */
export interface ChangelogSection {
  /** Heading text, or `""` for bullets that appear before any heading. */
  title: string;
  items: ChangelogItem[];
  /** Rendered HTML of the group's loose paragraphs (e.g. "Upgrade note: …"). */
  notesHtml: string[];
}

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
  /** Rendered HTML of the version's body. Kept for `/api/changelog` consumers. */
  html: string;
  /** Rendered HTML of the version's lead-in paragraph. */
  leadHtml: string;
  /** The body, structured for the collapsed version → item → detail rendering. */
  sections: ChangelogSection[];
  /** Total bullets across {@link sections} — shown on the collapsed version row. */
  itemCount: number;
}

marked.setOptions({ gfm: true });

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

/** True when index `i` in `s` falls outside a `` `code span` ``. */
function outsideCode(s: string, i: number): boolean {
  return (s.slice(0, i).match(/`/g) ?? []).length % 2 === 0;
}

/** First `sep` outside code that still leaves enough text on either side of it. */
function findSeparator(text: string, sep: string, minHead: number, minTail: number): number {
  for (let i = text.indexOf(sep); i !== -1; i = text.indexOf(sep, i + 1)) {
    if (i >= minHead && text.length - i - sep.length >= minTail && outsideCode(text, i)) return i;
  }
  return -1;
}

/**
 * Split one bullet into headline + detail. Nearly every entry is written as
 * `**Headline** — detail`, so the bold lead-in is the headline. Older entries
 * predate that convention: fall back to a bare em dash, then to a `:`/`;` clause
 * break on a long line, and finally leave the bullet as a one-liner with no
 * detail — so its row renders flat rather than as a toggle that opens nothing.
 */
function splitItem(text: string): { title: string; detail: string } {
  if (text.startsWith("**")) {
    const end = text.indexOf("**", 2);
    if (end > 2) {
      return {
        title: text.slice(2, end).trim(),
        detail: text
          .slice(end + 2)
          .replace(/^\s*[—–:-]\s*/, "")
          .trim(),
      };
    }
  }
  const dash = findSeparator(text, " — ", 8, 8);
  if (dash !== -1) {
    return { title: text.slice(0, dash).trim(), detail: text.slice(dash + 3).trim() };
  }
  if (text.length > 120) {
    for (const sep of [": ", "; "]) {
      const i = findSeparator(text, sep, 30, 40);
      if (i !== -1) {
        return { title: text.slice(0, i).trim(), detail: text.slice(i + sep.length).trim() };
      }
    }
  }
  return { title: text.trim(), detail: "" };
}

const HTML_ENTITY = /&(?:#\d+|#x[\da-fA-F]+|[a-zA-Z]+);/g;

/**
 * Capitalize a detail's first letter. A detail is the tail of a
 * `**Headline** — detail` sentence, so it's written mid-sentence; once the
 * headline becomes its own row the tail has to stand as a sentence of its own.
 * Skipped when the detail opens with markup — a leading `` `command` `` or link
 * carries casing that is load-bearing, not prose.
 */
function capitalizeDetail(html: string): string {
  const match = html.match(/^(\s*<p>)([^<]+)/);
  if (!match) return html;
  const [, open, run] = match;
  // Entities contain letters; mask them so `&quot;Foo` doesn't look lowercase.
  const i = run.replace(HTML_ENTITY, (e) => "\0".repeat(e.length)).search(/[A-Za-z]/);
  if (i === -1 || run[i] === run[i].toUpperCase()) return html;
  return open + run.slice(0, i) + run[i].toUpperCase() + html.slice(open.length + i + 1);
}

type RawGroup = { title: string; items: string[]; notes: string[] };

/**
 * Group a version body by its `### ` headings, separating each group's bullets
 * from its loose paragraphs. Bullets wrap across lines in `CHANGELOG.md`, so a
 * bullet runs until the next bullet, heading, or blank line.
 */
function parseGroups(body: string): RawGroup[] {
  const groups: RawGroup[] = [];
  let cur: RawGroup = { title: "", items: [], notes: [] };
  let buf: string[] = [];
  let mode: "item" | "note" | null = null;

  const flush = () => {
    const text = buf.join(" ").replace(/\s+/g, " ").trim();
    if (text) (mode === "item" ? cur.items : cur.notes).push(text);
    buf = [];
    mode = null;
  };

  for (const raw of body.split(/\r?\n/)) {
    const heading = raw.match(/^###\s+(.+?)\s*$/);
    if (heading) {
      flush();
      groups.push(cur);
      cur = { title: heading[1], items: [], notes: [] };
      continue;
    }
    const line = raw.trim();
    // Editor notes in the source file are not website content.
    if (line === "" || line.startsWith("<!--")) {
      flush();
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      flush();
      mode = "item";
      buf.push(line.replace(/^[-*]\s+/, ""));
      continue;
    }
    if (mode !== "item") mode = "note";
    buf.push(line);
  }
  flush();
  groups.push(cur);
  return groups;
}

/** Render a version body into the lead paragraph plus its collapsible sections. */
async function renderBody(body: string): Promise<{
  leadHtml: string;
  sections: ChangelogSection[];
}> {
  const groups = parseGroups(body);
  // Anything before the first `### ` is the version's lead-in.
  const lead = groups[0]?.title ? undefined : groups.shift();
  const leadHtml = lead?.notes.length ? await marked.parse(lead.notes.join("\n\n")) : "";
  if (lead?.items.length) groups.unshift({ title: "", items: lead.items, notes: [] });

  const sections: ChangelogSection[] = [];
  for (const group of groups) {
    if (!group.items.length && !group.notes.length) continue;
    const items: ChangelogItem[] = [];
    for (const raw of group.items) {
      const { title, detail } = splitItem(raw);
      items.push({
        title: await marked.parseInline(title),
        detailHtml: detail ? capitalizeDetail(await marked.parse(detail)) : "",
      });
    }
    sections.push({
      title: group.title,
      items,
      notesHtml: await Promise.all(group.notes.map((n) => marked.parse(n))),
    });
  }
  return { leadHtml, sections };
}

/** Lightly infer tag pills from the section content. */
function inferTags(body: string): string[] {
  const tags = ["feature"];
  if (/\bfix(es|ed)?\b/i.test(body)) tags.push("fix");
  if (/\b(security|advisor|CVE|vulnerab)/i.test(body)) tags.push("security");
  if (/\bbreaking\b/i.test(body)) tags.push("breaking");
  return tags;
}

/** Preserve the complete last successful catalog when upstream revalidation fails. */
export const getChangelog = cache(
  unstable_cache(
    async (): Promise<ChangelogEntry[]> => {
      try {
        const dated = await loadPublishedChangelog();

        const entries: ChangelogEntry[] = [];
        for (const { version, body, date } of dated) {
          const { leadHtml, sections } = await renderBody(body);
          entries.push({
            version,
            displayVersion: `v${version}`,
            slug: `v${version.replace(/\./g, "-")}`,
            date,
            tags: inferTags(body),
            summary: firstParagraph(body),
            html: await marked.parse(body),
            leadHtml,
            sections,
            itemCount: sections.reduce((n, s) => n + s.items.length, 0),
          });
        }
        entries.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
        return entries;
      } catch (error) {
        reportCaughtError(error, "web/lib/changelog");
        throw error;
      }
    },
    ["published-changelog-v2"],
    { revalidate: CHANGELOG_REVALIDATE },
  ),
);
