/**
 * Application-level encryption for sensitive data (env vars, secrets).
 *
 * Uses AES-256-GCM (authenticated encryption) via Node.js built-in crypto.
 * The encryption key is derived from BETTER_AUTH_SECRET (which every install
 * already has) - no extra env var needed.
 *
 * Format:  base64( iv:16 || authTag:16 || ciphertext )
 *
 * Usage:
 *   import { encrypt, decrypt } from "../lib/encryption";
 *   const sealed = encrypt("my secret");
 *   const plain  = decrypt(sealed); // "my secret"
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { env } from "../config/env";

// ─── Key derivation ──────────────────────────────────────────────────────────

const ALGORITHM = "aes-256-gcm" as const;
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

/**
 * Derive a deterministic 256-bit key from the auth secret.
 * SHA-256 always produces 32 bytes - exactly what AES-256 needs.
 */
function deriveKey(): Buffer {
  return createHash("sha256")
    .update(env.BETTER_AUTH_SECRET)
    .digest();
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Seal a plaintext under an EXPLICIT 32-byte key. The single AES-256-GCM
 * implementation for the whole app — `encrypt()` uses the instance key,
 * while callers with a different key source (e.g. a passphrase-derived key
 * for data export) reuse this so the cipher/format never diverges.
 * Returns base64( iv:16 || authTag:16 || ciphertext ).
 */
export function encryptWithKey(key: Buffer, plaintext: string): string {
  return encryptBytesWithKey(key, Buffer.from(plaintext, "utf8")).toString("base64");
}

/** Binary twin used by bounded transfer chunks; keeps bytes binary on the wire. */
export function encryptBytesWithKey(key: Buffer, plaintext: Uint8Array): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]);
}

/**
 * Open a value produced by `encryptWithKey()` (or `encrypt()`), using an
 * explicit key. Throws if the data is tampered with or the key is wrong.
 */
export function decryptWithKey(key: Buffer, sealed: string): string {
  return decryptBytesWithKey(key, Buffer.from(sealed, "base64")).toString("utf8");
}

/** Open one binary AES-GCM chunk without converting its payload through UTF-8. */
export function decryptBytesWithKey(key: Buffer, sealed: Uint8Array): Buffer {
  const packed = Buffer.from(sealed);
  if (packed.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error("Invalid encrypted data: too short");
  }
  const iv = packed.subarray(0, IV_LENGTH);
  const authTag = packed.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = packed.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Encrypt a plaintext string under the instance key.
 * Returns a base64-encoded string containing IV + auth tag + ciphertext.
 */
export function encrypt(plaintext: string): string {
  return encryptWithKey(deriveKey(), plaintext);
}

/**
 * Decrypt a value produced by `encrypt()`.
 * Throws if the data is tampered with or the key is wrong.
 */
export function decrypt(sealed: string): string {
  return decryptWithKey(deriveKey(), sealed);
}

/**
 * Decrypt a Record<string, encryptedValue> → Record<string, plaintext>.
 * On decryption failure for a key, that key is omitted (not silently passed through).
 */
export function decryptEnvMap(
  encrypted: Record<string, string>,
  onError?: (key: string, err: unknown) => void,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(encrypted)) {
    try {
      result[k] = decrypt(v);
    } catch (err) {
      onError?.(k, err);
      // Omit keys that fail decryption - never leak ciphertext into containers
    }
  }
  return result;
}
