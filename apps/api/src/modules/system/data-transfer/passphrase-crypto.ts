/**
 * Passphrase-based sealing of the secret bundle. Independent of the instance
 * key (BETTER_AUTH_SECRET) so the file is portable: only the user's passphrase
 * opens it.
 *
 * This owns only the KDF (scrypt, memory-hard) + envelope. The actual cipher is
 * the app's single AES-256-GCM implementation (encryptWithKey/decryptWithKey in
 * lib/encryption) — reused here so the crypto never diverges. A wrong passphrase
 * fails the GCM auth tag and surfaces as WrongPassphraseError.
 */

import { randomBytes, scryptSync } from "node:crypto";

import { decryptWithKey, encryptWithKey } from "../../../lib/encryption";
import type { SealedSecrets, SecretBundle } from "./types";

const KDF = { algo: "scrypt" as const, N: 32768, r: 8, p: 1, keyLen: 32 };
// scrypt needs maxmem >= 128*N*r (~32 MiB here); give headroom, and it also
// bounds an attacker-supplied N in a malicious file (larger N throws → treated
// as a bad file rather than a memory-DoS).
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

export class WrongPassphraseError extends Error {
  readonly code = "WRONG_PASSPHRASE" as const;
  constructor() {
    super("Incorrect passphrase, or the secret data in this file is corrupt.");
    this.name = "WrongPassphraseError";
  }
}

function deriveKey(passphrase: string, salt: Buffer, kdf: SealedSecrets["kdf"]): Buffer {
  return scryptSync(passphrase, salt, kdf.keyLen, {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    maxmem: SCRYPT_MAXMEM,
  });
}

export function sealSecretBundle(bundle: SecretBundle, passphrase: string): SealedSecrets {
  const salt = randomBytes(16);
  const kdf = { ...KDF, salt: salt.toString("base64") };
  const key = deriveKey(passphrase, salt, kdf);
  return {
    version: 1,
    kdf,
    blob: encryptWithKey(key, JSON.stringify(bundle)),
  };
}

export function openSecretBundle(sealed: SealedSecrets, passphrase: string): SecretBundle {
  try {
    const key = deriveKey(passphrase, Buffer.from(sealed.kdf.salt, "base64"), sealed.kdf);
    return JSON.parse(decryptWithKey(key, sealed.blob)) as SecretBundle;
  } catch {
    // Wrong key (GCM auth failure), bad KDF params, or malformed JSON — all mean
    // "this passphrase can't open this file".
    throw new WrongPassphraseError();
  }
}

/**
 * Resolve the optional credential envelope for import. A file without an
 * envelope is intentionally credential-free; a file with one must always be
 * unlocked instead of silently importing scrubbed credential columns.
 */
export function openTransferSecrets(
  sealed: SealedSecrets | null,
  passphrase?: string,
): SecretBundle | null {
  if (!sealed) return null;
  if (!passphrase) throw new WrongPassphraseError();
  return openSecretBundle(sealed, passphrase);
}
