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

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export const DEFAULT_ENCRYPTION_SECRET = "change-me-in-production";

// ─── Key derivation ──────────────────────────────────────────────────────────

const ALGORITHM = "aes-256-gcm" as const;
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

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

/** One installation's secrets. The existing ciphertext format and key derivation are unchanged. */
export function createEncryption(secret: string) {
  if (typeof secret !== "string" || !secret)
    throw new TypeError("An explicit encryption secret is required");
  const key = createHash("sha256").update(secret).digest();
  let closed = false;
  function getKey(): Buffer {
    if (closed) throw new Error("Encryption context is closed");
    return key;
  }
  /**
   * Encrypt a plaintext string under the instance key.
   * Returns a base64-encoded string containing IV + auth tag + ciphertext.
   */
  function encrypt(plaintext: string): string {
    return encryptWithKey(getKey(), plaintext);
  }

  /**
   * Decrypt a value produced by `encrypt()`.
   * Throws if the data is tampered with or the key is wrong.
   */
  function decrypt(sealed: string): string {
    return decryptWithKey(getKey(), sealed);
  }

  /**
   * Decrypt a Record<string, encryptedValue> → Record<string, plaintext>.
   * On decryption failure for a key, that key is omitted (not silently passed through).
   */
  function decryptEnvMap(
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

  return Object.freeze({
    encrypt,
    decrypt,
    decryptEnvMap,
    close() {
      if (!closed) {
        closed = true;
        key.fill(0);
      }
    },
  });
}
export type Encryption = ReturnType<typeof createEncryption>;
