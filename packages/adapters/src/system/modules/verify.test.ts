import { describe, it, expect } from "vitest";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import {
  verifyManifestSignature,
  verifyAssets,
  sha256Hex,
  expectedAssetHashes,
  referencedAssets,
} from "./verify";
import type { ModuleCatalog } from "./types";

/** A throwaway ed25519 keypair; the pubkey stands in for the baked keyring. */
function testKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spkiB64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  return { spkiB64, privateKey };
}

const asset = (s: string) => Buffer.from(s, "utf8");

function makeCatalog(assets: Record<string, Buffer>): ModuleCatalog {
  return {
    module: "openresty",
    schema: 1,
    serial: 1,
    latest: "1.1.0",
    versions: [
      {
        version: "1.1.0",
        apply: "consent",
        steps: [
          { kind: "file", id: "f1", path: "/x", asset: "a/f1", sha256: sha256Hex(assets["a/f1"]!) },
          { kind: "exec", id: "e1", asset: "a/e1.sh", sha256: sha256Hex(assets["a/e1.sh"]!) },
        ],
      },
    ],
  };
}

describe("catalog signature verification", () => {
  it("accepts a manifest signed by a keyring member", () => {
    const { spkiB64, privateKey } = testKey();
    const bytes = Buffer.from(JSON.stringify({ module: "openresty", serial: 1 }));
    const sig = cryptoSign(null, bytes, privateKey);
    expect(verifyManifestSignature(bytes, sig, [spkiB64])).toBe(true);
  });

  it("rejects a tampered manifest", () => {
    const { spkiB64, privateKey } = testKey();
    const bytes = Buffer.from(JSON.stringify({ module: "openresty", serial: 1 }));
    const sig = cryptoSign(null, bytes, privateKey);
    const tampered = Buffer.from(JSON.stringify({ module: "openresty", serial: 2 }));
    expect(verifyManifestSignature(tampered, sig, [spkiB64])).toBe(false);
  });

  it("rejects a signature from a key outside the keyring", () => {
    const signer = testKey();
    const other = testKey();
    const bytes = Buffer.from("payload");
    const sig = cryptoSign(null, bytes, signer.privateKey);
    expect(verifyManifestSignature(bytes, sig, [other.spkiB64])).toBe(false);
  });

  it("fails closed on an empty keyring", () => {
    const { privateKey } = testKey();
    const bytes = Buffer.from("payload");
    const sig = cryptoSign(null, bytes, privateKey);
    expect(verifyManifestSignature(bytes, sig, [])).toBe(false);
  });
});

describe("asset hash verification", () => {
  const assets = { "a/f1": asset("lua bytes"), "a/e1.sh": asset("#!/bin/sh\necho hi\n") };
  const catalog = makeCatalog(assets);

  it("enumerates every referenced asset", () => {
    expect(referencedAssets(catalog)).toEqual(new Set(["a/f1", "a/e1.sh"]));
    expect(expectedAssetHashes(catalog).size).toBe(2);
  });

  it("passes when all asset bytes match their committed sha256", () => {
    const res = verifyAssets(catalog, new Map(Object.entries(assets)));
    expect(res.ok).toBe(true);
    expect(res.failures).toEqual({});
  });

  it("fails a hash mismatch", () => {
    const bad = new Map(Object.entries({ ...assets, "a/f1": asset("TAMPERED") }));
    const res = verifyAssets(catalog, bad);
    expect(res.ok).toBe(false);
    expect(res.failures["a/f1"]).toMatch(/sha256 mismatch/);
  });

  it("fails a missing asset", () => {
    const missing = new Map(Object.entries({ "a/f1": assets["a/f1"]! }));
    const res = verifyAssets(catalog, missing);
    expect(res.ok).toBe(false);
    expect(res.failures["a/e1.sh"]).toBe("missing asset");
  });
});
