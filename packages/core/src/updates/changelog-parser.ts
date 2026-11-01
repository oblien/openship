/** Tag spelling used for exact changelog lookup; prerelease/build suffixes stay. */
export function normalizeChangelogVersion(version: string): string {
  return version.trim().replace(/^v/i, "");
}

/**
 * Shared by the website, desktop updater and release workflow. Level-two
 * headings bound entries; headings inside fenced examples are ordinary text.
 */
export function parseChangelog(markdown: string): { version: string; body: string }[] {
  const entries: { version: string; lines: string[] }[] = [];
  let current: (typeof entries)[number] | undefined;
  let fence: { character: string; length: number } | undefined;
  for (const line of markdown.split(/\r?\n/)) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (
        marker &&
        marker[1]![0] === fence.character &&
        marker[1]!.length >= fence.length &&
        !marker[2]!.trim()
      )
        fence = undefined;
      current?.lines.push(line);
      continue;
    }
    if (marker) {
      fence = { character: marker[1]![0]!, length: marker[1]!.length };
      current?.lines.push(line);
      continue;
    }

    const heading = line.match(/^ {0,3}##(?:[ \t]+(.*)|$)/);
    if (heading) {
      current = undefined;
      // Support both `## v1.2.3` and `## [v1.2.3] - date`, with a full
      // version token so `1.2.3foo` cannot masquerade as release 1.2.3.
      const title = (heading[1] ?? "").trim().replace(/[ \t]+#+$/, "");
      const token = title.match(/^(?:\[([^\]]+)\]|([^\s]+))(?:[ \t]+.*)?$/);
      const version = normalizeChangelogVersion(token?.[1] ?? token?.[2] ?? "");
      if (
        /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
          version,
        )
      ) {
        current = { version, lines: [] };
        entries.push(current);
      }
      continue;
    }
    current?.lines.push(line);
  }
  return entries.map(({ version, lines }) => ({ version, body: lines.join("\n").trim() }));
}

/** Extract one exact version body, returning empty for a missing/empty entry. */
export function extractChangelogSection(markdown: string, version: string): string {
  const target = normalizeChangelogVersion(version);
  return parseChangelog(markdown).find((entry) => entry.version === target)?.body ?? "";
}
