/**
 * Mini TOML helpers - just enough to extract a string-array key from a named
 * section without a full TOML dependency. Used by Cargo and Python (uv) detectors.
 *
 * Limitations (intentional):
 *   - Only handles top-level sections, not array-of-tables.
 *   - String-array values only; ignores everything else.
 *   - Section termination is by `\n[` (not `[`) so values containing `[` -
 *     e.g. `deps = "pkg[extra]"` - don't prematurely close the section.
 */

/**
 * Extract a string-array key from a named TOML section.
 *
 *   extractStringArrayFromSection(content, "workspace", "members")
 *
 * Returns `[]` when the section is missing, the key is missing, or the value
 * isn't a string array. Robust to multi-line arrays and inline comments.
 */
export function extractStringArrayFromSection(
  content: string,
  sectionPath: string,
  key: string,
): string[] {
  const sectionHeader = new RegExp(
    `(?:^|\\n)\\[${escapeRegex(sectionPath)}\\]\\s*(?:\\r?\\n|\\r)`,
    "i",
  );
  const startMatch = sectionHeader.exec(content);
  if (!startMatch) return [];

  // Section body: from after the header to the next top-level `[...]` header (any depth).
  const bodyStart = startMatch.index + startMatch[0].length;
  const nextHeader = /\n\s*\[/g;
  nextHeader.lastIndex = bodyStart;
  const next = nextHeader.exec(content);
  const body = content.slice(bodyStart, next ? next.index : content.length);

  // Locate `key = [` inside the body, then scan forward to the matching `]`,
  // tracking bracket depth and quote state so values like "foo[1]" don't
  // truncate the array early.
  const keyStart = new RegExp(
    `(?:^|\\n)\\s*${escapeRegex(key)}\\s*=\\s*\\[`,
    "i",
  );
  const keyMatch = keyStart.exec(body);
  if (!keyMatch) return [];

  const arrayBodyStart = keyMatch.index + keyMatch[0].length;
  const closingIndex = findClosingBracket(body, arrayBodyStart);
  if (closingIndex === -1) return [];

  return parseTomlStringArray(body.slice(arrayBodyStart, closingIndex));
}

/**
 * Walk `body` forward from `start` and return the index of the `]` that closes
 * the array opened just before `start`. Respects string literals (single and
 * double quoted) and nested `[`. Returns -1 if no closing bracket is found.
 */
function findClosingBracket(body: string, start: number): number {
  let depth = 1; // we're already past the opening `[`
  let inDouble = false;
  let inSingle = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    const prev = body[i - 1];
    if (inDouble) {
      if (ch === '"') {
        // A closing double quote is escaped only when it is preceded by an
        // odd number of consecutive backslashes (standard TOML basic-string rule).
        let backslashRun = 0;
        for (let j = i - 1; j >= 0 && body[j] === "\\"; j--) {
          backslashRun++;
        }
        if (backslashRun % 2 === 0) inDouble = false;
      }
      continue;
    }
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === "[") {
      depth++;
      continue;
    }
    if (ch === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Parse the body of a TOML string array (already stripped of the surrounding brackets). */
function parseTomlStringArray(arrayBody: string): string[] {
  const items: string[] = [];
  // Match either "double-quoted" or 'single-quoted' strings, ignoring commas/whitespace/comments.
  const itemPattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'/g;
  let match: RegExpExecArray | null;
  while ((match = itemPattern.exec(arrayBody)) !== null) {
    const value = (match[1] ?? match[2] ?? "").trim();
    if (value) items.push(value);
  }
  return items;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
