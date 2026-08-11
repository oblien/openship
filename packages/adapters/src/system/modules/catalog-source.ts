/**
 * Catalog source — resolve a VERIFIED module catalog from the pinned remote
 * GitHub ref, falling back to the embedded bundle. Both paths run through the
 * SAME verify gate (verify.ts): there is no unsigned execution path, even offline.
 *
 * Resolution order (mirrors readLua's disk-first/embedded-fallback in
 * openresty-lua.ts): remote pinned catalog → embedded fallback. A dev dir
 * override (OPENSHIP_MODULE_CATALOG_DIR) is still signature-checked.
 *
 * Fetching happens HOST-SIDE (the API/orchestrator has Node + the baked pubkey);
 * we push already-verified bytes down to the target server. Fetch hardening
 * mirrors downloadTarballOnRemote (source-tarball.ts): fail on HTTP error, retry.
 */

import type { ModuleCatalog, VerifiedCatalog } from "./types";
import {
  CATALOG_PUBKEYS,
  insecureCatalogAllowed,
  referencedAssets,
  verifyAssets,
  verifyManifestSignature,
} from "./verify";
import { EMBEDDED_CATALOG } from "./catalog-embedded";

/** Pinned catalog coordinates, baked at build time; env overrides for dev/ops. */
const CATALOG_BASE_URL =
  process.env.OPENSHIP_MODULE_CATALOG_BASE_URL?.trim() ||
  "https://raw.githubusercontent.com/openship/native-modules";
const CATALOG_REF = process.env.OPENSHIP_MODULE_CATALOG_REF?.trim() || "main";

export interface CatalogLoadResult {
  catalog?: VerifiedCatalog;
  /** null when the module isn't published in this source; otherwise the reason. */
  error?: string;
}

/**
 * Pure verify-and-assemble: given raw manifest bytes + detached signature + the
 * asset byte map, verify the signature (unless the dev insecure hatch is on),
 * parse, then verify every referenced asset's sha256. Only a fully-verified
 * catalog is returned. This is the single trust chokepoint both sources funnel
 * through — unit-testable with a throwaway keypair.
 */
export function verifyAndBuild(
  module: string,
  manifestBytes: Buffer,
  signature: Buffer,
  assets: Map<string, Buffer>,
  ref: string,
  pubkeys: readonly string[] = CATALOG_PUBKEYS,
): CatalogLoadResult {
  const insecure = insecureCatalogAllowed();
  if (!insecure && !verifyManifestSignature(manifestBytes, signature, pubkeys)) {
    return { error: "manifest signature verification failed" };
  }

  let catalog: ModuleCatalog;
  try {
    catalog = JSON.parse(manifestBytes.toString("utf8"));
  } catch (err) {
    return { error: `manifest parse failed: ${(err as Error).message}` };
  }
  if (catalog.module !== module) {
    return { error: `manifest module mismatch: expected ${module}, got ${catalog.module}` };
  }

  // Only assets actually referenced by steps need to be present + hashed.
  const needed = referencedAssets(catalog);
  const subset = new Map<string, Buffer>();
  for (const key of needed) {
    const b = assets.get(key);
    if (b) subset.set(key, b);
  }
  if (!insecure) {
    const check = verifyAssets(catalog, subset);
    if (!check.ok) {
      return { error: `asset verification failed: ${JSON.stringify(check.failures)}` };
    }
  }

  return { catalog: { catalog, assets: subset, ref } };
}

/** Load + verify the embedded (bundled) catalog for `module`, if present. */
export function loadEmbeddedCatalog(module: string): CatalogLoadResult {
  const entry = EMBEDDED_CATALOG[module];
  if (!entry) return {}; // module not bundled — not an error
  const manifest = Buffer.from(entry.manifest, "base64");
  const sig = Buffer.from(entry.sig ?? "", "base64");
  const assets = new Map<string, Buffer>();
  for (const [k, b64] of Object.entries(entry.assets)) assets.set(k, Buffer.from(b64, "base64"));
  return verifyAndBuild(module, manifest, sig, assets, "embedded");
}

async function fetchBytes(url: string): Promise<Buffer | null> {
  // Retry a couple of times like downloadTarballOnRemote; a 404 is "not there".
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (attempt === 2) throw err;
    }
  }
  return null;
}

/** Fetch + verify the pinned remote catalog for `module`, if reachable. */
export async function fetchRemoteCatalog(module: string): Promise<CatalogLoadResult> {
  const dir = `${CATALOG_BASE_URL}/${CATALOG_REF}/modules/${module}`;
  const [manifest, sig] = await Promise.all([
    fetchBytes(`${dir}/catalog.json`),
    fetchBytes(`${dir}/catalog.json.sig`).catch(() => null),
  ]);
  if (!manifest) return {}; // not published remotely
  // Parse first (unverified) only to learn which assets to fetch; the real trust
  // check happens in verifyAndBuild over the raw bytes.
  let parsed: ModuleCatalog;
  try {
    parsed = JSON.parse(manifest.toString("utf8"));
  } catch (err) {
    return { error: `remote manifest parse failed: ${(err as Error).message}` };
  }
  const assets = new Map<string, Buffer>();
  for (const key of referencedAssets(parsed)) {
    const b = await fetchBytes(`${dir}/${key}`);
    if (b) assets.set(key, b);
  }
  return verifyAndBuild(module, manifest, sig ?? Buffer.alloc(0), assets, `${CATALOG_REF}`);
}

/**
 * Resolve the best verified catalog for `module`: pinned remote first (live
 * updates), then the embedded bundle (offline / air-gapped). Returns null when
 * neither source has a verifiable catalog — the caller then leaves the module
 * untouched (fail-closed).
 */
export async function resolveVerifiedCatalog(module: string): Promise<VerifiedCatalog | null> {
  try {
    const remote = await fetchRemoteCatalog(module);
    if (remote.catalog) return remote.catalog;
    if (remote.error) {
      console.warn(`[modules] remote catalog for ${module} rejected: ${remote.error}`);
    }
  } catch (err) {
    console.warn(`[modules] remote catalog fetch for ${module} failed: ${(err as Error).message}`);
  }
  const embedded = loadEmbeddedCatalog(module);
  if (embedded.catalog) return embedded.catalog;
  if (embedded.error) {
    console.warn(`[modules] embedded catalog for ${module} rejected: ${embedded.error}`);
  }
  return null;
}
