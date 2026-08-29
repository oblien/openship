/**
 * Shell-word splitting + docker-compose `command` → argv normalization.
 *
 * Shared by the compose parser (apps/api), the CLI compose ingestion (apps/cli),
 * and the Dockerfile compiler (packages/adapters) so all three agree on how a
 * command string becomes argv — see #332, where flattening a list command to a
 * space-joined string and re-wrapping it in `sh -c` broke entrypoint+CMD images.
 */

/**
 * POSIX single-quote a value so it survives shell interpolation as one literal word.
 *
 * The inverse of {@link shellSplitWords}, and the one function standing between a
 * data-derived string (a container label, a project slug, a unit name read off a scan)
 * and root on the target — so it lives next to the splitter rather than being re-typed in
 * each module that needs it. Nine byte-identical local copies existed before this one.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

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

export interface ResolveCommandArgvInput {
  /** Argv the writer supplied explicitly. `undefined` = didn't mention it. */
  incomingArgv?: string[] | null;
  /** Text command the writer supplied. `undefined` = didn't mention it. */
  incomingCommand?: string | null;
  /** The stored row's text command. */
  storedCommand?: string | null;
  /** The stored row's argv. */
  storedArgv?: string[] | null;
}

/**
 * Decide the `commandArgv` to persist next to an incoming text `command`.
 *
 * The runtime prefers `commandArgv` and only falls back to `["sh","-c",command]`
 * when it's null (resolveComposeCmd), so a writer that sets `command` alone leaves
 * the row in one of two wrong states: a stale argv keeps running the OLD command,
 * or a null argv resurrects the `sh -c` wrap that breaks entrypoint+CMD images
 * (#332). Every writer that accepts a text command resolves argv through here.
 *
 * The subtlety is that a row's `command` is a LOSSY display join for a list
 * command — compose `["sh","-c","a && b"]` is stored as `sh -c a && b`, which
 * re-splits into five words. Several wire shapes carry only the string, and
 * clients echo it back on unrelated writes (the service form posts every field it
 * owns; a deploy request replays its service list), so re-deriving unconditionally
 * would corrupt a correct argv. Hence: an UNCHANGED command string never disturbs
 * the stored argv, and only a real edit re-derives.
 *
 * Returns `undefined` when the caller should not write the column at all.
 */
export function resolveCommandArgv(
  input: ResolveCommandArgvInput,
): string[] | null | undefined {
  const { incomingArgv, incomingCommand, storedCommand, storedArgv } = input;

  // Explicit argv always wins — the writer speaks the runtime's own language.
  if (incomingArgv !== undefined) return incomingArgv;

  // Command not mentioned → leave the column alone.
  if (incomingCommand === undefined) return undefined;

  // Unchanged string → keep the stored argv. This is what protects a list command
  // from being re-split out of its lossy display join.
  const nextCommand = incomingCommand?.trim() || null;
  const priorCommand = storedCommand?.trim() || null;
  if (storedArgv != null && nextCommand === priorCommand) return storedArgv;

  // A real edit (or a first write): split the way docker-compose does — no `sh -c`.
  return commandToArgv(nextCommand);
}
