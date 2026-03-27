/**
 * Application-level encryption for sensitive data (env vars, secrets).
 *
 * Uses AES-256-GCM (authenticated encryption) via Node.js built-in crypto.
 * The encryption key is derived from BETTER_AUTH_SECRET (which every install
 * already has) — no extra env var needed.
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
 * SHA-256 always produces 32 bytes — exactly what AES-256 needs.
 */
function deriveKey(): Buffer {
  return createHash("sha256")
    .update(env.BETTER_AUTH_SECRET)
    .digest();
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Encrypt a plaintext string.
 * Returns a base64-encoded string containing IV + auth tag + ciphertext.
 */
export function encrypt(plaintext: string): string {
  const key = deriveKey();
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Pack: iv (16) + authTag (16) + ciphertext (variable)
  const packed = Buffer.concat([iv, authTag, encrypted]);
  return packed.toString("base64");
}

/**
 * Decrypt a value produced by `encrypt()`.
 * Throws if the data is tampered with or the key is wrong.
 */
export function decrypt(sealed: string): string {
  const key = deriveKey();
  const packed = Buffer.from(sealed, "base64");

  if (packed.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error("Invalid encrypted data: too short");
  }

  const iv = packed.subarray(0, IV_LENGTH);
  const authTag = packed.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = packed.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

/**
 * Encrypt a JSON-serialisable value.
 * Convenience wrapper for structured data like env var arrays.
 */
export function encryptJson<T>(value: T): string {
  return encrypt(JSON.stringify(value));
}

/**
 * Decrypt a value produced by `encryptJson()`.
 */
export function decryptJson<T = unknown>(sealed: string): T {
  return JSON.parse(decrypt(sealed)) as T;
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
      // Omit keys that fail decryption — never leak ciphertext into containers
    }
  }
  return result;
}
