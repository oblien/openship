/** Read a token's resource hint before authentication. This never establishes
 * trust: the auth middleware still requires a live, issued-token receipt.
 * Opaque PATs have no audience and use their own permission checks.
 */
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

export function readTokenAudience(token: string): string | null {
  const payload = decodePayload(token);
  if (!payload) return null;
  const aud = payload.aud;
  if (typeof aud === "string") return aud;
  // RFC 7519 allows an array; take the single-valued case we ever emit.
  if (Array.isArray(aud) && typeof aud[0] === "string" && aud.length === 1) return aud[0];
  return null;
}
