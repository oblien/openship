/** Small, dependency-free helpers for reading & parsing proxy configs. */

import type { CommandExecutor } from "../../../types";

export async function tryExec(executor: CommandExecutor, command: string): Promise<string | null> {
  try {
    return await executor.exec(command);
  } catch {
    return null;
  }
}

/** Strip `#` line comments (nginx / caddy / apache all use them). */
export function stripComments(text: string): string {
  return text.replace(/#.*$/gm, "");
}

/**
 * Extract the bodies of `keyword { ... }` blocks with balanced-brace matching
 * (handles nested `location {}` etc.). `keyword` is matched as a whole token,
 * so `server` won't match `server_name` and `server 127.0.0.1;` (no brace).
 */
export function extractBlocks(text: string, keyword: string): string[] {
  const blocks: string[] = [];
  const re = new RegExp(`(?:^|[\\s;}])${keyword}\\b[^{;]*\\{`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const openIdx = m.index + m[0].length - 1; // index of the opening `{`
    let depth = 1;
    let i = openIdx + 1;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") depth--;
    }
    if (depth === 0) {
      blocks.push(text.slice(openIdx + 1, i - 1));
      re.lastIndex = i;
    } else {
      break; // unbalanced — stop rather than loop forever
    }
  }
  return blocks;
}

/**
 * Single-quote a value for safe interpolation into a POSIX shell command
 * (wraps in `'…'` and escapes embedded quotes). Used to quote file paths fed to
 * `cat` when reading discovered vhost files.
 */
export function sq(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
