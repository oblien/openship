/**
 * Verify-before-execute gate for the native-module migration catalog.
 *
 * Trust model (asymmetric): Openship holds the ed25519 PRIVATE key (CI/offline);
 * only PUBLIC keys are baked here. A signed catalog can therefore be authored
 * only by Openship, while any self-hosted instance can verify it — a compromised
 * box can read the pubkeys but cannot forge a catalog the rest of the fleet would
 * execute as root. This is the apt `signed-by=` trust bootstrap generalized to
 * our own catalog.
 *
 * There is NO existing "verify a remote blob before executing" primitive in the
 * repo — every `curl | sh` install today runs unverified over TLS. This module
 * is that missing gate: (1) verify the manifest signature with a baked pubkey,
 * (2) verify each referenced asset's sha256, and only then may bytes be written
 * or executed on a host.
 */

import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import type { ModuleCatalog } from "./types";

/**
 * Baked ed25519 public keyring — base64 of SPKI DER. A KEYRING (not a single
 * key) so a key can be rotated: publish catalogs signed by the new key while old
 * builds still trust the previous one. EMPTY until real keys are generated and
 * committed (Phase 0 owner task); an empty keyring means every remote/embedded
 * catalog fails verification (fail-closed) unless the dev escape hatch is on.
 */
export const CATALOG_PUBKEYS: readonly string[] = [
  // "MCowBQYDK2VwAyEA…",  // ed25519 SPKI DER, base64
];

/** SHA-256 hex of a buffer (the asset tamper check). */
export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Dev-only escape hatch. Set OPENSHIP_MODULE_CATALOG_INSECURE=1 to skip signature
 * + hash verification while developing against an unsigned local catalog. HARD
 * fail-safe: ignored (stays secure) whenever NODE_ENV=production, so it can never
 * weaken a real deployment even if the env leaks in. Reads process.env directly
 * to avoid pulling the API's env boot-guards into this leaf module.
 */
export function insecureCatalogAllowed(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  const v = process.env.OPENSHIP_MODULE_CATALOG_INSECURE;
  return v === "1" || v === "true";
}

/**
 * Verify a detached ed25519 signature over the exact manifest bytes against the
 * baked keyring. Returns true on the first key that validates.
 */
export function verifyManifestSignature(
  manifestBytes: Buffer,
  signature: Buffer,
  pubkeys: readonly string[] = CATALOG_PUBKEYS,
): boolean {
  for (const b64 of pubkeys) {
    try {
      const key = createPublicKey({
        key: Buffer.from(b64, "base64"),
        format: "der",
        type: "spki",
      });
      // ed25519 uses algorithm `null` in Node's one-shot verify.
      if (cryptoVerify(null, manifestBytes, key, signature)) return true;
    } catch {
      // Malformed key or signature for this candidate — try the next.
    }
  }
  return false;
}

/** Every asset key a catalog's steps reference (file + exec steps carry `asset`). */
export function referencedAssets(catalog: ModuleCatalog): Set<string> {
  const out = new Set<string>();
  for (const v of catalog.versions) {
    for (const step of v.steps) out.add(step.asset);
  }
  return out;
}

/** Expected sha256 for each referenced asset key (last one wins if reused). */
export function expectedAssetHashes(catalog: ModuleCatalog): Map<string, string> {
  const out = new Map<string, string>();
  for (const v of catalog.versions) {
    for (const step of v.steps) {
      out.set(step.asset, step.sha256.toLowerCase());
    }
  }
  return out;
}

export interface AssetVerifyResult {
  ok: boolean;
  /** asset key → reason, for the assets that failed (missing / hash mismatch). */
  failures: Record<string, string>;
}

/**
 * Verify that every referenced asset is present in `assets` and hashes to the
 * sha256 committed in the (already signature-verified) manifest. Because the
 * manifest is signed and the manifest commits each asset's hash, one signature
 * transitively authenticates all asset bytes.
 */
export function verifyAssets(
  catalog: ModuleCatalog,
  assets: Map<string, Buffer>,
): AssetVerifyResult {
  const failures: Record<string, string> = {};
  for (const [key, expected] of expectedAssetHashes(catalog)) {
    const bytes = assets.get(key);
    if (!bytes) {
      failures[key] = "missing asset";
      continue;
    }
    const actual = sha256Hex(bytes);
    if (actual !== expected) {
      failures[key] = `sha256 mismatch (expected ${expected}, got ${actual})`;
    }
  }
  return { ok: Object.keys(failures).length === 0, failures };
}
