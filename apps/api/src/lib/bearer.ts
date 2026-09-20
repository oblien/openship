import type { Context } from "hono";
import { PAT_PREFIX } from "@repo/platform/engine/lib/pat";

/**
 * Parse a `Authorization: Bearer <token>` header. Single source of truth for
 * both the auth middleware and the MCP endpoint — the regex must stay identical
 * so a token authenticates the same way on every route.
 */
export function parseBearerToken(c: Context): string | null {
  const raw = c.req.header("authorization") ?? c.req.header("Authorization");
  const m = raw ? /^bearer\s+(.+)$/i.exec(raw.trim()) : null;
  return m ? m[1]!.trim() : null;
}

/** True when a bearer token is a Personal Access Token (`opsh_pat_…`). */
export function isPatToken(token: string | null): token is string {
  return !!token && token.startsWith(PAT_PREFIX);
}
