/** Small, dependency-free helpers for reading & parsing proxy configs. */

import type { CommandExecutor } from "../../../types";

export async function tryExec(executor: CommandExecutor, command: string): Promise<string | null> {
  try {
    return await executor.exec(command);
  } catch {
    return null;
  }
}

/**
 * Strip `#` line comments (nginx / caddy / apache all use them) — but not a `#`
 * that sits inside a quoted string.
 *
 * `/#.*$/gm` was fine until a config WE write carried one. The edge's not-found
 * page is embedded as `return 404 '<html>…</html>'` (see `edge-not-found.ts`) and a
 * CSS `#fff` in it truncated the line, taking ~40 closing braces with it. The edge
 * scan reads every vhost through a single `cat` whose glob puts `_default.conf`
 * first, so the file's brace balance broke and `extractBlocks` swallowed every
 * vhost AFTER it: the box scanned as zero sites, and the migrate wizard offered no
 * domains and no certificates to carry. Nothing failed — it just found nothing.
 *
 * Quote state is tracked per LINE and reset at each newline. All three config
 * languages close a quoted value on the line that opens it (nginx's multi-line
 * `log_format` is one quoted chunk per line), and a config with one stray quote
 * would otherwise turn every following line into "string" and delete the rest of
 * the file. Confining a misread to its own line keeps the worst case no worse than
 * the regex this replaces.
 */
export function stripComments(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      let quote: '"' | "'" | undefined;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (quote) {
          if (ch === "\\") i++; // `\"` inside a quoted value — skip the escapee
          else if (ch === quote) quote = undefined;
        } else if (ch === '"' || ch === "'") {
          quote = ch;
        } else if (ch === "#") {
          return line.slice(0, i);
        }
      }
      return line;
    })
    .join("\n");
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
/**
 * Resolve same-hostname collisions before they reach disk.
 *
 * Every importer feeds one vhost FILE per hostname, so two parsed blocks sharing
 * a `server_name`/address are a collision where last-write-wins and the loser is
 * gone with no trace. Every proxy has a shape that produces this pair:
 *
 *   • nginx  — certbot's `:80` helper beside the real `:443` vhost
 *   • traefik — the `web` redirect router beside the `websecure` router
 *   • caddy  — an explicit `http://host` block beside the auto-HTTPS one
 *   • apache — `<VirtualHost *:80>` with a Redirect beside `<VirtualHost *:443>`
 *
 * Observed live: the plain-HTTP half won and a customer's HTTPS site came back
 * HTTP-only serving an empty ACME webroot. `score` decides the winner (higher
 * wins); ties keep source order, and `dropped` is returned so the caller can say
 * what it set aside rather than staying quiet.
 */
export function collapseByHost<T>(
  items: T[],
  hostsOf: (item: T) => string[],
  score: (item: T) => number,
): { kept: T[]; dropped: T[] } {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    // Keyed on the FULL name set: a multi-name block (`a.com b.com`) is one vhost
    // and must not be compared against a single-name block for one of them.
    const key = [...hostsOf(item)].sort().join(" ");
    const bag = groups.get(key);
    if (bag) bag.push(item);
    else groups.set(key, [item]);
  }

  const kept: T[] = [];
  const dropped: T[] = [];
  // Map iteration follows first-insert order, so `kept` stays in source order.
  for (const bag of groups.values()) {
    let winner = bag[0];
    for (const cand of bag) if (score(cand) > score(winner)) winner = cand;
    kept.push(winner);
    for (const loser of bag) if (loser !== winner) dropped.push(loser);
  }
  return { kept, dropped };
}

export function sq(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
