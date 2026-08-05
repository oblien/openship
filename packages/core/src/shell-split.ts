/**
 * Shell-word splitting + docker-compose `command` → argv normalization.
 *
 * Shared by the compose parser (apps/api), the CLI compose ingestion (apps/cli),
 * and the Dockerfile compiler (packages/adapters) so all three agree on how a
 * command string becomes argv — see #332, where flattening a list command to a
 * space-joined string and re-wrapping it in `sh -c` broke entrypoint+CMD images.
 */

/**
 * POSIX-ish shell word splitter: honors single quotes, double quotes, and
 * backslash escapes; splits on unquoted whitespace. Does NOT expand variables,
 * globs, or operators — it only tokenizes, matching how docker-compose turns a
 * string `command` into argv (a shell is invoked only when the user writes
 * `sh -c` explicitly). `""` → `[]`.
 */
export function shellSplitWords(value: string): string[] {
  const words: string[] = [];
  let current = "";
  let quoted = false;
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (const char of value.trim()) {
    if (escaped) {
      // Unquoted, a backslash escapes any single following char (the backslash
      // is dropped). Inside double quotes it is NOT that permissive: POSIX keeps
      // the backslash LITERAL unless it precedes a character a double quote can
      // itself escape (`"`, `\`, `$`, or a backtick). Without this carve-out a
      // double-quoted regex/path/escape ("\d+", "C:\app", "s/\r//g") silently
      // lost its backslashes — while the single-quoted form kept them — so the
      // same command tokenized differently depending on the quote style.
      if (inDouble && char !== '"' && char !== "\\" && char !== "$" && char !== "`") {
        current += "\\";
      }
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && !inSingle) {
      escaped = true;
      continue;
    }
    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      quoted = true;
      continue;
    }
    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
      quoted = true;
      continue;
    }
    if (/\s/.test(char) && !inSingle && !inDouble) {
      if (current || quoted) {
        words.push(current);
        current = "";
        quoted = false;
      }
      continue;
    }
    current += char;
  }

  if (escaped) current += "\\";
  if (current || quoted) words.push(current);
  return words;
}

/**
 * Normalize a docker-compose `command` to argv, matching compose semantics:
 *   - `undefined` / `null` → `null`  (no override — keep the image CMD)
 *   - `string`            → `shellSplitWords(...)`  (`""` → `[]` = clear CMD)
 *   - `string[]`          → argv verbatim (stringified)
 *
 * Values are used AS GIVEN — callers that interpolate env (the compose parser)
 * must interpolate before calling. There is no implicit `sh -c`: to run a shell,
 * the command itself must be `sh -c "..."`.
 */
export function commandToArgv(
  command: string | string[] | null | undefined,
): string[] | null {
  if (command == null) return null;
  if (Array.isArray(command)) return command.map((part) => String(part));
  return shellSplitWords(command);
}
