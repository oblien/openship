/**
 * Where the Compose stack lives on disk, and the ONE reader of its `.env`.
 *
 * Split out of lib/compose.ts so the internal-token resolver (lib/internal-token.ts)
 * can read the stack's INTERNAL_TOKEN without pulling in the whole compose backend:
 * the api container boots with THAT token, so every loopback caller needs it —
 * including commands (reset-admin-password, doctor) that have nothing to do with
 * bringing a stack up.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { OS_DIR } from "./paths";

export const COMPOSE_DIR = join(OS_DIR, "compose");
export const COMPOSE_FILE = join(COMPOSE_DIR, "docker-compose.yml");
export const COMPOSE_ENV_FILE = join(COMPOSE_DIR, ".env");

/**
 * Is there a Compose install on this box?
 *
 * The compose file is the evidence, NOT `readInstallMethod()`: nothing ever writes
 * `bare` back to that marker, so it still reads "compose" on a box converted the
 * other way (same reasoning as composeHostChannelExpected).
 */
export function composeInstallExists(): boolean {
  return existsSync(COMPOSE_FILE);
}

export interface ComposeEnvRead {
  env: Record<string, string>;
  /**
   * Set when the file EXISTS but wouldn't open — a root-owned 0600 `.env` under a
   * non-root invocation, in practice. ENOENT is NOT reported here: that's a box with
   * no compose install, and each caller decides what that means (a first install for
   * `up`, "look at the bare token instead" for the resolver).
   */
  unreadable: string | null;
}

/** Parse the stack's `.env` into KEY=value pairs. Pure — callers own the reporting. */
export function readComposeEnvFile(): ComposeEnvRead {
  let text: string;
  try {
    text = readFileSync(COMPOSE_ENV_FILE, "utf8");
  } catch (err) {
    const code = (err as { code?: string }).code;
    return { env: {}, unreadable: code === "ENOENT" ? null : (err as Error).message };
  }
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return { env, unreadable: null };
}
