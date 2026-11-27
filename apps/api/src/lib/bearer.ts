import type { Context } from "hono";

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
