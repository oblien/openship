/**
 * Encryption helpers for SSH server credentials stored at rest.
 *
 * SSH passwords and key passphrases sit in `servers.ssh_password` /
 * `servers.ssh_key_passphrase` - sensitive plaintext that the dashboard
 * never displays back. We encrypt on write and decrypt only at the
 * moment we hand the secret to the ssh2 client.
 *
 * Layering:
 *   - `encrypt()` / `decrypt()` live in `lib/encryption.ts` (the
 *     repo's existing AES-256-GCM helpers, key derived from
 *     BETTER_AUTH_SECRET).
 *   - The functions here add a recognizable prefix to every ciphertext
 *     we produce ("enc1:" + base64). That prefix is the discriminator:
 *     a value WITHOUT the prefix is plaintext and `decrypt…` returns it
 *     as-is.
 *
 * Why the prefix instead of always trying to decrypt + falling back on
 * error: silently catching decrypt errors and treating the value as
 * plaintext masks real corruption / key mismatches. The prefix gives
 * an explicit "this is encrypted" / "this is plaintext" signal.
 */

import { encrypt, decrypt } from "./encryption";

/**
 * Discriminator on every encrypted ciphertext. Anything starting with
 * this prefix is interpreted as encrypted; anything else is plaintext
 * (interpreted verbatim).
 *
 *   "enc1" - version 1 of our encryption envelope. Bump if the underlying
 *            algorithm or key derivation changes incompatibly.
 */
const CIPHERTEXT_PREFIX = "enc1:" as const;

/**
 * Encrypt a credential string for storage.
 *
 * Returns the raw input untouched when:
 *   - it's `null` / `undefined` / empty string (caller wants to clear the field)
 *
 * Always-encrypts otherwise. The result is `enc1:<base64>` - recognizable
 * as encrypted by `decryptSecretField`.
 */
export function encryptSecretField(plain: string | null | undefined): string | null {
  if (plain == null || plain === "") return plain ?? null;
  return CIPHERTEXT_PREFIX + encrypt(plain);
}

/**
 * Decrypt a value from `servers.ssh_password` / `servers.ssh_key_passphrase`.
 *
 * Three cases:
 *   - Empty / null  → return as-is (no credential set).
 *   - Encrypted (starts with "enc1:") → decrypt + return plaintext.
 *   - Plaintext (no prefix)           → return as-is. The next save
 *     re-encrypts the value.
 */
export function decryptSecretField(stored: string | null | undefined): string | undefined {
  if (stored == null || stored === "") return undefined;
  if (!stored.startsWith(CIPHERTEXT_PREFIX)) return stored; // plaintext, no prefix
  return decrypt(stored.slice(CIPHERTEXT_PREFIX.length));
}

/** Whether a stored field is in the encrypted-at-rest format. */
export function isEncryptedSecret(stored: string | null | undefined): boolean {
  return typeof stored === "string" && stored.startsWith(CIPHERTEXT_PREFIX);
}
