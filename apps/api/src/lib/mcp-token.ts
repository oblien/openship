/**
 * Audience-bound MCP access tokens.
 *
 * better-auth's mcp() plugin mints an OPAQUE random access token and stores it
 * in `oauth_access_token`. That satisfies OAuth (the format is opaque to the
 * client by design) but leaves nothing for a spec-strict MCP client — or an
 * operator debugging one — to inspect: RFC 8707 says the token must be bound to
 * the `resource` the client asked for, and the MCP authorization spec makes the
 * resource server responsible for rejecting a token issued for someone else.
 *
 * So we re-issue: after the plugin creates the row, the stored token string is
 * REPLACED with a JWT carrying `aud` (the requested resource), `iss`, `sub`,
 * `exp` and a `jti` equal to the opaque value it replaces. Nothing else about
 * the flow changes — introspection is still an exact-string lookup of that row,
 * which remains the authoritative check. The signature is a defence-in-depth
 * integrity marker, not the trust anchor.
 *
 * Tokens issued before this existed stay opaque and keep working: the audience
 * gate treats a non-JWT token as unconstrained (see `readTokenAudience`).
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../config/env";

/** Claims we put on an MCP access token. */
export interface McpAccessTokenClaims {
  iss: string;
  sub: string;
  aud: string;
  exp: number;
  iat: number;
  jti: string;
  client_id: string;
  scope: string;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(data: string): string {
  return createHmac("sha256", env.BETTER_AUTH_SECRET).update(data).digest("base64url");
}

/** Sign an HS256 JWT for the given claims. */
export function signMcpAccessToken(claims: McpAccessTokenClaims): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "at+jwt" }));
  const payload = base64url(JSON.stringify(claims));
  return `${header}.${payload}.${sign(`${header}.${payload}`)}`;
}

/** Decode a JWT payload without verifying. Null when the value isn't a JWT. */
function decodePayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1] as string, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Does this token carry our own HS256 signature? */
export function isSignedByThisInstance(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const expected = Buffer.from(sign(`${parts[0]}.${parts[1]}`));
  const actual = Buffer.from(parts[2] as string);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * The audience a bearer token was issued for, or null when it carries none —
 * an opaque legacy token, or any value we didn't mint. A null audience is NOT a
 * failure; it means "unconstrained", which is how every token issued before
 * this change behaves.
 */
export function readTokenAudience(token: string): string | null {
  const payload = decodePayload(token);
  if (!payload) return null;
  const aud = payload.aud;
  if (typeof aud === "string") return aud;
  // RFC 7519 allows an array; take the single-valued case we ever emit.
  if (Array.isArray(aud) && typeof aud[0] === "string" && aud.length === 1) return aud[0];
  return null;
}
