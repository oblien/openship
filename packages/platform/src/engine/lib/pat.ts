import { createHash, randomBytes } from "node:crypto";

/**
 * Personal Access Token format helpers — the single source of truth for how a
 * PAT is minted, displayed, and hashed. Shared by the auth middleware (verify)
 * and the tokens controller (create).
 *
 * Format: `opsh_pat_<43-char base64url secret>` (256 bits of entropy). Only the
 * SHA-256 hash is persisted; the plaintext is shown to the user once.
 */
export const PAT_PREFIX = "opsh_pat_";

/** SHA-256 hex of the full token — the DB lookup key. */
export function hashPatToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Mint a fresh token. Returns the plaintext (return to the user ONCE), the
 * display prefix (stored for recognition in the token list), and the hash to
 * persist.
 */
export function mintPatToken(): { token: string; tokenPrefix: string; tokenHash: string } {
  const secret = randomBytes(32).toString("base64url");
  const token = `${PAT_PREFIX}${secret}`;
  return {
    token,
    tokenPrefix: token.slice(0, PAT_PREFIX.length + 6),
    tokenHash: hashPatToken(token),
  };
}
